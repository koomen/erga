// The agent editor: one session per person per document, running in the
// host. A session holds that person's transcript and runs (kept step by step
// in the person's own object, so a restart neither loses nor repeats work:
// agents/checkpoint.ts), and joins the
// document room as an ordinary Yjs peer with its own replica of the shared
// doc. The room never holds a conversation, a long run doesn't load the
// room, and closing the tab doesn't stop the agent.
//
// It runs on pi's agent core (https://github.com/badlogic/pi-mono:
// @mariozechner/pi-agent-core + pi-ai) with our own tools, written against
// the small Workspace interface in agents/document/workspace.ts, so the same agent could
// run elsewhere (a browser) if it ever needs to. Others see only its edits,
// attributed ("Pete's agent"), and its presence while it works: a labelled
// caret that follows its edits as they apply, and whether it's busy, on awareness.
//
// This module is the Promise edge: pi's SDK is async, and document/host.ts wraps
// what it exposes in Effect.
//
// Configuration comes from the Worker's bindings (in local development,
// .dev.vars; see .dev.vars.example). The key lives only here, in the host:
//   ANTHROPIC_API_KEY          required: the key an admin stored on /admin
//                              (server/directory/api-keys.ts, through cloudflare/d1.ts's withKeys),
//                              else the Worker secret (locally a real one in
//                              .dev.vars, else the dev server's environment: dev/agent-key.ts)
//   ERGA_AGENT_MODEL    the model a session starts on: opus-fast
//                              (default, Claude Opus 5.5 in fast mode) or sonnet
//                              (Claude Sonnet 5.5); each person can switch in the panel
//   ERGA_AGENT_EFFORT   low | medium (default) | high | xhigh | max
//
// ERGA_AGENT_MODEL=script swaps the model for a scripted one (see
// `scriptModel`), for the test suites (e2e/suite, servers.script in e2e/fixtures.ts): deterministic, free,
// and it needs no key. Never set it on a deployment real people use.

import * as Redacted from "effect/Redacted";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { validateToolArguments } from "@mariozechner/pi-ai";
import { fileRefs, messageContent, type Attachment } from "../../shared/attach";
import { Agent as PiAgent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { emptyLog, offerOf, reduce, type Log, type LogEvent } from "../../shared/agent-log";
import { CUT, Checkpoints, restoredLog, sendLate, type ChatStore } from "../checkpoint";
import { type ViewRequest, type ViewResult } from "../../shared/agent-log";
import { colorFor, files, hasSeen, introduce, stamp, stateVector, type Author } from "../../document/content";
import { byLine, VIA } from "../../shared/attribution";
import { pageRefusal, type DocKind, type TreeOp } from "../../document/pages";
import { joinLocal, type Room } from "../../document/room";
import type { Naming } from "../../server/directory/index.ts";
import { YjsWorkspace, type Pacer } from "./workspace";

import {
  DEFAULT_MODEL,
  describeModel,
  isModelChoice,
  isScript,
  patchPayload,
  resultImage,
  resultText,
  scriptModel,
  type AgentConfig,
  type ModelChoice,
} from "../models";
import { kindLine, systemPrompt } from "./prompt";
import {
  CHANGES,
  makeTools,
  toolPath,
  type FilesAccess,
  type OpenResult,
  type PageTree,
  type ToolContent,
  type ToolSpec,
  type VersionsAccess,
} from "./tools";
export { beyondPrompt } from "./prompt";
export {
  CHANGES,
  documentToolSpecs,
  describeView,
  type FilesAccess,
  type VersionsAccess,
  type PageTree,
  type OpenResult,
  type ToolContent,
  type ToolSpec,
} from "./tools";
export { externalGuide } from "./guide";

export {
  MODELS,
  DEFAULT_MODEL,
  isModelChoice,
  isScript,
  agentConfigFrom,
  describeModel,
  patchPayload,
  scriptModel,
  resultImage,
  resultText,
  type AgentConfig,
  type ModelChoice,
} from "../models";

export interface AgentSession {
  /** The model's name, or null when the embedded agent is off (its tools still work). */
  readonly model: string | null;
  /** The model it's on, of MODELS; null when off or scripted (nothing to switch). */
  readonly modelChoice: ModelChoice | null;
  /** Switches model from the next turn on (a running turn finishes on the old one). */
  setModel(choice: ModelChoice): boolean;
  /**
   * The agent's settings now (null: off): a key an admin stored, replaced or
   * cleared since the session started. The next model call uses them.
   */
  configure(cfg: AgentConfig | null): Promise<void>;
  /** The transcript so far (for a tab that just loaded). */
  log(): Log;
  /** Sends a message, with any files attached; while a turn is running it steers the current one. */
  prompt(text: string, context: string | null, files?: Attachment[]): void;
  abort(): void;
  reset(): Promise<void>;
  /** Takes back the agent's most recent change (one tool call), if any. */
  undo(): boolean;
  subscribe(listener: (ev: LogEvent) => void): () => void;
  /**
   * Goes on with a run that a restart cut off, from its last checkpoint (the
   * first call only; call it once the session's events reach its tabs).
   * Answers whether a run goes on.
   */
  resume(): Promise<boolean>;
  /** The tools, for an external agent. */
  tools(): ToolSpec[];
  /**
   * Runs one tool for an external agent, exactly as the embedded agent would:
   * same replica of the doc, same attribution, presence and undo history. The
   * call shows in the transcript, marked as external. Throws with a message
   * the caller can act on (unknown tool, bad arguments, the tool's own error).
   */
  /** `via`: how the person acts through the outside agent (shared/attribution.ts: "a shared agent (label)"); its edits are theirs, via it. */
  runTool(name: string, args: unknown, via?: string): Promise<ToolContent[]>;
  /** Leaves the room and stops its timers (the document closed: it starts again the next time it's needed). */
  close(): void;
}

export interface SessionOptions {
  /** Null when the embedded agent is off: no model, but the tools still work for an external agent. `configure` changes it later. */
  cfg: AgentConfig | null;
  room: Room;
  /** The person this session works for. */
  owner: { id: string; name: string };
  docName: string;
  /** A document that's a single file opened from disk: its path (the agent can't make other files). */
  only?: string;
  /** A document (one page: no other page can be made) or a project (pages), now; a project if not given. */
  kind?: () => DocKind;
  /** Whether the owner may edit (an agent acts with its user's permissions). */
  canEdit: () => boolean;
  /** Asks one of the owner's open tabs to render and capture the page. */
  view: (req: ViewRequest) => Promise<ViewResult>;
  readAsset: (path: string) => Promise<Uint8Array | null>;
  /** The document's title and address, as the owner (get_title, set_title); without it those tools are left out. */
  naming?: Naming;
  /** Does a tree operation in the room: new_page, mkdir, mv and rm; without it those tools are left out. */
  tree?: (op: TreeOp) => Promise<void>;
  /** The document's pages with titles, and its address (list_pages); without it list_pages and open_page are left out. */
  pages?: () => Promise<PageTree>;
  /** Switches the owner's open editor tabs to a page (open_page, new_page's open). */
  open?: (path: string) => Promise<OpenResult>;
  /**
   * The tools beyond the document the owner may use now (agents/tools.ts:
   * sharing; the server's settings and users for an admin). Asked for again
   * before each new prompt, so becoming (or stopping being) an admin shows.
   * Each says what the agent is doing while it runs (`activity`).
   */
  serverTools?: () => Promise<ServerAgentTool[]>;
  /** The agent's turn ended (or an external agent's run of calls did): the document cuts a version, and answers the version it's at then (diff_versions' "last_turn"). */
  turnEnded?: () => Promise<string | null> | void;
  /** The document's versions; without it those tools are left out. */
  versions?: VersionsAccess;
  /** Where the person's conversation here is kept, step by step (the person's own object: agents/checkpoint.ts); without it, only in memory. */
  store?: ChatStore;
  /** What the store keeps beside it, for whoever wakes a run after a restart (the document's id). */
  meta?: Record<string, string>;
  /** Every file's size, time and kind, PDFs' text, and writes of bytes (document/host.ts); without it the file tools see text and names only. */
  files?: FilesAccess;
}

/** A tool beyond the document (agents/tools.ts), with what the agent is doing while it runs. */
export type ServerAgentTool = AgentTool & { activity?: string };

const TOOL_ACTIVITY: Record<string, string> = {
  new_page: "making a page",
  make_project: "making it a project",
  make_document: "making it a document",
  list_pages: "looking at the pages",
  open_page: "opening a page",
  mkdir: "making a folder",
  mv: "moving",
  rm: "deleting",
  read: "reading",
  edit: "editing",
  write: "writing",
  ls: "looking around",
  find: "looking for files",
  grep: "searching",
  view_page: "looking at the page",
  evaluate_page: "inspecting the page",
  page_console: "reading the page's console",
  page_network: "reading the page's requests",
  page_events: "reading the page's events",
  page_inspect: "inspecting the live page",
  page_click: "clicking on the page",
  page_key: "pressing a key on the page",
  get_title: "reading the title",
  set_title: "renaming the document",
  list_versions: "looking at versions",
  read_version: "reading an old version",
  diff_versions: "comparing versions",
  restore_version: "restoring a version",
};

export async function startSession(opts: SessionOptions): Promise<AgentSession> {
  const { owner } = opts;
  /** The settings now: configure changes them (a key an admin stores reaches the next model call). */
  let cfg = opts.cfg;
  // Its work is its person's, via it: "Ada, via their agent".
  const me: Author = { user: owner.id, name: byLine(owner.name, VIA.agent), color: colorFor(owner.id, true), kind: "agent", via: VIA.agent };
  /** Who the session's edits are by now: the embedded agent, or, while an outside agent's calls run, that agent (runTool). */
  let acting = me;
  /** Says who edits now, in the shared doc's authors, so each edit is attributed to it. */
  const actAs = (a: Author) => { if (acting != a) { acting = a; introduce(doc, a); presence({ user: a }); } };

  // The session's own replica of the shared doc, joined to the room as a peer.
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: me, busy: false, activity: null, cursor: null });
  const leave = joinLocal(opts.room, doc, awareness);
  await new Promise((r) => setTimeout(r, 0)); // the in-process sync is microtasks: done by now
  introduce(doc, me);

  const origin = { agent: owner.id }, undoOrigin = { agentUndo: owner.id };
  // One undo step per tool call: its steps merge until the call ends (edited, stopCapturing).
  const undo = new Y.UndoManager(files(doc), { trackedOrigins: new Set([origin]), captureTimeout: Infinity });
  // Others see each edit as it applies: the agent's selection on the old text, then the new typed in (workspace.ts, Pacer).
  const pacer: Pacer = {
    cursor: (path, anchor, head) =>
      presence({ cursor: { path, anchor: Y.relativePositionToJSON(anchor), head: head && Y.relativePositionToJSON(head) } }),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    revert: () => {
      doc.transact(() => {
        undo.undo();
        stamp(doc, acting);
      }, undoOrigin);
      undo.redoStack.pop();
      undo.stopCapturing();
    },
  };
  const ws = new YjsWorkspace(
    doc,
    () => acting,
    opts.canEdit,
    origin,
    opts.only ?? null,
    (path) => (opts.kind ? pageRefusal(opts.kind(), path, opts.docName) : null),
    pacer
  );
  let choice: ModelChoice | null = cfg == null || cfg.model == "script" ? null : cfg.model;

  // The conversation as it was at its last checkpoint, if there is one (a reload, a restart).
  const stored = opts.store ? await opts.store.load().catch((e: unknown) => { console.log(`couldn't read ${owner.id}'s conversation: ${e}`); return null; }) : null;
  const log = stored ? restoredLog(stored) : emptyLog();
  if (stored && choice != null && isModelChoice(stored.state.model ?? "")) choice = stored.state.model as ModelChoice;
  const listeners = new Set<(ev: LogEvent) => void>();
  // tool_execution_end carries no args; keep each call's path from its start event.
  const paths = new Map<string, string | null>();
  const emit = (ev: LogEvent) => {
    if (ev.t == "tool") {
      if (ev.status == "running") paths.set(ev.id, ev.path);
      else ev = { ...ev, path: paths.get(ev.id) ?? null };
    }
    checkpoints.logged(reduce(log, ev));
    for (const l of listeners) l(ev);
  };
  const presence = (patch: Record<string, unknown>) => awareness.setLocalState({ ...awareness.getLocalState(), ...patch });
  // Busy while the embedded agent runs, or while an external agent is
  // calling tools: during a call, and for a while after the last one, since
  // it's thinking between calls and nothing says when it's done.
  const busy = { agent: false, ext: 0, extTimer: null as ReturnType<typeof setTimeout> | null };
  let wasBusy = false;
  /** The version the document was at when this agent's last turn ended. */
  let lastTurn: Promise<string | null> = Promise.resolve(null);
  const syncBusy = (activity?: string | null) => {
    const on = busy.agent || busy.ext > 0 || busy.extTimer != null;
    // A turn just ended: the document cuts a version of it.
    if (wasBusy && !on) {
      const at = opts.turnEnded?.();
      if (at) { const before = lastTurn; lastTurn = at.catch(() => before); }
    }
    wasBusy = on;
    presence({ busy: on, activity: on ? activity ?? (awareness.getLocalState()?.activity as string | null) ?? "working" : null });
  };
  const undoable = () => emit({ t: "undoable", count: undo.undoStack.length });

  /** Done in the room: the replica has it once it has seen everything the room has (a few microtasks). */
  const caughtUp = async () => {
    const want = stateVector(opts.room.doc);
    for (let i = 0; i < 200 && !hasSeen(doc, want); i++) await new Promise((r) => setTimeout(r, 0));
  };
  const tools = makeTools(ws, {
    view: (req) => opts.view({ ...req, after: stateVector(doc) }),
    readAsset: opts.readAsset,
    naming: opts.naming,
    versions: opts.versions,
    lastTurn: () => lastTurn,
    canEdit: opts.canEdit,
    by: () => byLine(owner.id, acting.via),
    caughtUp,
    pages: opts.pages,
    open: opts.open,
    files: opts.files,
    tree: opts.tree && (async (op) => {
      if (!opts.canEdit()) throw new Error("Your user can only view this document, so you can't change it.");
      await opts.tree!(op);
      await caughtUp();
    }),
    edited: (path, at) => {
      // One undo step per tool call, and the agent's cursor where it last wrote.
      undo.stopCapturing();
      undoable();
      const t = files(doc).get(path);
      if (t) presence({ cursor: { path, anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(t, at)), head: null } });
    },
  });

  /** The tools as the owner may use them now: someone who may only view the document has none that change it. */
  const mine = () => (opts.canEdit() ? tools : tools.filter((t) => !CHANGES.has(t.name)));
  // The tools beyond the document, as the owner may use them now (none if they can't be had).
  const beyond = async () => (await opts.serverTools?.().catch((e: unknown) => { console.log(`server tools for ${owner.id}: ${e}`); return null; })) ?? [];
  let starting = false;
  // Someone who may only view: the prompt says so, and why the tools that change the document aren't there.
  const prompted = (more: AgentTool[]) => systemPrompt(opts.docName, owner.name, opts.only != null, more.map((t) => t.name)) + kindLine(opts.only != null ? null : opts.kind?.() ?? null, owner.name) + (opts.canEdit() ? "" : `\n\n${owner.name} can only view this document, so you can't change it: you have only the tools that change nothing (read, ls, find, grep and the like). If they ask for a change, say so.`);
  /** The model's side, made once there are settings (at the start, or when a key arrives later). It reads the key at each call. */
  let agent: PiAgent | null = null;
  /** The model's messages while it has no model side yet (the agent off): the stored ones, until a reset. */
  let offMessages = stored?.messages ?? [];
  // Each step of a run, kept in the person's store; a restart goes on from the last (agents/checkpoint.ts).
  const checkpoints = new Checkpoints(opts.store ?? null, {
    log, stored, meta: { person: owner.id, name: owner.name, ...opts.meta },
    messages: () => agent?.state.messages ?? offMessages,
    busy: () => !!agent?.state.isStreaming,
    model: () => choice,
  });
  const makeAgent = async (first: AgentConfig) => {
    const serverTools = await beyond();
    const kept = stored && isModelChoice(stored.state.model ?? "") ? stored.state.model as ModelChoice : null;
    choice = first.model == "script" ? null : kept ?? first.model;
    const a = new PiAgent({
      initialState: { systemPrompt: prompted(serverTools), model: choice == null ? scriptModel() : describeModel(choice), thinkingLevel: "medium", tools: [...mine(), ...serverTools], messages: offMessages },
      getApiKey: () => (cfg ? Redacted.value(cfg.apiKey) : "") || "none",
      onPayload: isScript(first) ? undefined : patchPayload(() => cfg ?? first, () => choice ?? DEFAULT_MODEL),
      beforeToolCall: checkpoints.beforeToolCall,
    });
    // The session's handler first, so the transcript has each event when its checkpoint is saved.
    a.subscribe(onEvent);
    a.subscribe(checkpoints.listener);
    return a;
  };
  /** A run that ended in a failure outside the model's answer (pi threw). */
  const failed = (err: unknown) => {
    starting = false;
    emit({ t: "error", text: err instanceof Error ? err.message : String(err) });
    busy.agent = false;
    syncBusy();
    emit({ t: "busy", busy: false });
  };
  let resumed = false;

  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case "message_update": {
        const m = e.assistantMessageEvent;
        if (m.type == "text_delta") emit({ t: "text", delta: m.delta });
        else if (m.type == "thinking_delta") emit({ t: "thinking", delta: m.delta });
        break;
      }
      case "message_end": {
        const msg = e.message as { role?: string; stopReason?: string; errorMessage?: string };
        if (msg.role == "assistant" && msg.stopReason == "error") emit({ t: "error", text: msg.errorMessage || "The request failed." });
        break;
      }
      case "tool_execution_start": {
        const path = toolPath(e.args);
        const server = agent?.state.tools.find((t) => t.name == e.toolName) as ServerAgentTool | undefined;
        presence({ activity: `${TOOL_ACTIVITY[e.toolName] ?? server?.activity ?? e.toolName}${path ? ` ${path}` : ""}` });
        emit({ t: "tool", id: e.toolCallId, name: e.toolName, path, status: "running" });
        break;
      }
      case "tool_execution_end":
        presence({ activity: "thinking" });
        emit({
          t: "tool", id: e.toolCallId, name: e.toolName, path: null,
          status: e.isError ? "error" : "done",
          detail: e.isError ? resultText(e.result).slice(0, 400) : undefined,
          image: e.isError ? undefined : resultImage(e.result),
          offer: e.isError ? undefined : offerOf(e.result),
        });
        break;
      case "agent_start": busy.agent = true; syncBusy("thinking"); emit({ t: "busy", busy: true }); break;
      case "agent_end": busy.agent = false; syncBusy(); emit({ t: "busy", busy: false }); if (agent) sendLate(agent, failed); break;
    }
  };
  if (cfg) agent = await makeAgent(cfg);
  const piAgent = () => agent;
  /** The model's side, being made (a key arrived after the session started). */
  let making: Promise<void> | null = null;

  return {
    close() {
      agent?.abort();
      if (busy.extTimer) clearTimeout(busy.extTimer);
      leave();
      awareness.destroy();
    },
    get model() { return agent?.state.model.name ?? null; },
    get modelChoice() { return choice; },
    setModel(next) {
      if (!agent || choice == null) return false;
      choice = next;
      agent.state.model = describeModel(next);
      return true;
    },
    async configure(next) {
      cfg = next;
      if (next && !agent) await (making ??= makeAgent(next).then((a) => { agent ??= a; }).finally(() => { making = null; }));
    },
    log: () => log,
    prompt(text, context, files = []) {
      emit(files.length ? { t: "user", text, files: fileRefs(files) } : { t: "user", text });
      const agent = piAgent();
      if (!agent || !cfg) { emit({ t: "error", text: "The agent is off." }); return; }
      const content = messageContent(context ? `<editor>\n${context}\n</editor>\n\n${text}` : text, files);
      if (isScript(cfg)) scriptModel();
      const message = { role: "user" as const, content, timestamp: Date.now() };
      // Kept until the model has it: a restart before then doesn't lose it.
      checkpoints.queue(message);
      // A message sent while the turn is starting (its tools being looked up) steers it too.
      if (agent.state.isStreaming || starting) { agent.steer(message); return; }
      starting = true;
      // The tools beyond the document as the owner may use them now (an admin's, say).
      const refresh = beyond().then((more) => {
        agent.state.tools = [...mine(), ...more];
        agent.state.systemPrompt = prompted(more);
      });
      refresh.then(() => { starting = false; return agent.prompt(message); }).catch(failed);
    },
    abort: () => agent?.abort(),
    async reset() {
      if (agent) {
        agent.abort();
        await agent.waitForIdle();
        agent.reset();
      }
      paths.clear();
      undo.clear();
      offMessages = [];
      await checkpoints.clear();
      busy.agent = false;
      syncBusy();
      presence({ cursor: null });
      emit({ t: "reset" });
      undoable();
    },
    undo() {
      if (!undo.undoStack.length) return false;
      // Stamped, so the undo is attributed to the agent even when it only deletes.
      doc.transact(() => { undo.undo(); stamp(doc, acting); }, undoOrigin);
      // A call still under way goes on in a step of its own.
      undo.stopCapturing();
      undoable();
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async resume() {
      if (resumed) return false;
      resumed = true;
      const was = checkpoints.current.running || checkpoints.current.queued.length > 0;
      const going = await checkpoints.resume(agent, onEvent, failed);
      // A run with nothing left to do, or that can't go on (the agent is off now), ends here.
      if (was && !going) {
        if (!agent) emit({ t: "error", text: CUT });
        emit({ t: "busy", busy: false });
      }
      return going;
    },
    tools: () => mine().map((t) => ({ name: t.name, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters)) })),
    async runTool(name, args, via) {
      if (CHANGES.has(name) && !opts.canEdit()) throw new Error(`${owner.name} can only view this document, so ${name} isn't one of the tools: they are ${mine().map((t) => t.name).join(", ")}.`);
      const tool = tools.find((t) => t.name == name);
      if (!tool) throw new Error(`There's no tool named "${name}". The tools are: ${mine().map((t) => t.name).join(", ")}.`);
      const id = `ext-${crypto.randomUUID()}`;
      const params = validateToolArguments(tool, { type: "toolCall", id, name, arguments: (args ?? {}) as Record<string, unknown> });
      const path = toolPath(params);
      busy.ext++;
      // Its edits are its person's, via it, under the token's label ("Ada, via a shared agent (CI)"); the cursor says so too.
      if (via) actAs({ ...me, name: byLine(owner.name, via), via });
      if (busy.extTimer) { clearTimeout(busy.extTimer); busy.extTimer = null; }
      syncBusy(`${TOOL_ACTIVITY[name] ?? name}${path ? ` ${path}` : ""}`);
      emit({ t: "tool", id, name, path, status: "running", via: "external" });
      try {
        const result = await tool.execute(id, params);
        emit({ t: "tool", id, name, path, status: "done", image: resultImage(result), via: "external" });
        // A PDF goes out as a document (read's block for it is an image's, with the PDF's type).
        return (result.content as ToolContent[]).map((c) => (c.type == "image" && c.mimeType == "application/pdf" ? { type: "document", data: c.data, mimeType: "application/pdf" } : c));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        emit({ t: "tool", id, name, path, status: "error", detail: message.slice(0, 400), via: "external" });
        throw new Error(message);
      } finally {
        busy.ext--;
        if (!busy.ext) actAs(me);
        if (busy.extTimer) clearTimeout(busy.extTimer);
        busy.extTimer = setTimeout(() => { busy.extTimer = null; syncBusy(); }, EXTERNAL_IDLE_MS);
        syncBusy("working");
      }
    },
  };
}

/** How long an external agent counts as working after its last tool call. */
const EXTERNAL_IDLE_MS = 8_000;
