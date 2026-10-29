// The document agent: one session per person per document, running in the
// document's host (document/host.ts), which starts it through
// `documentAgents` (the contract: document/agent.ts). A session holds that person's transcript and runs (kept step by step
// in the person's own object, so a restart neither loses nor repeats work:
// agents/checkpoint.ts), and joins the
// document room as an ordinary Yjs peer with its own replica of the shared
// doc. The room never holds a conversation, a long run doesn't load the
// room, and closing the tab doesn't stop the agent.
//
// It runs on the loop both agents share (agents/run.ts: Effect AI) with our
// own tools, written against the small Workspace interface in
// agents/document/workspace.ts, so the same agent could run elsewhere (a
// browser) if it ever needs to. Others see only its edits,
// attributed ("Pete's agent"), and its presence while it works: a labelled
// caret that follows its edits as they apply, and whether it's busy, on awareness.
//
// This module is the Promise edge: document/host.ts wraps what it exposes in
// Effect.
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
// `scriptModel`), for the test suites (e2e/full/suite/, servers.script in e2e/helpers/fixtures.ts): deterministic, free,
// and it needs no key. Never set it on a deployment real people use.

import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { withBlobs, type ChatStore } from "../checkpoint";
import { resultImage, startLoop, type AgentTool } from "../run";
import { documentGuide } from "../guides";
import { colorFor, files, hasSeen, introduce, stamp, stateVector, type Author } from "../../document/content";
import { byLine, VIA } from "../../shared/attribution";
import { pageRefusal } from "../../document/pages";
import { joinLocal } from "../../document/room";
import type { AgentSession, DocumentAgents, SessionOptions, ToolContent } from "../../document/agent";
import { YjsWorkspace, type Pacer } from "./workspace";

import { MODELS, type AgentConfig, type AgentSettings } from "../models";
import { kindLine, systemPrompt } from "./prompt";
import { CHANGES, makeTools, toolPath } from "./tools";
/** A session as `documentAgents` starts it: the document's side (SessionOptions), with the agent's settings, the store and the server tools. */
export interface AgentSessionOptions extends SessionOptions {
  /** The agent's settings now, or why it's off: read as the session starts and at each refresh. */
  settings: () => Promise<AgentSettings>;
  /** Where the person's conversation here is kept, step by step (the person's own object: agents/checkpoint.ts); without it, only in memory. */
  store?: ChatStore;
  /** What the store keeps beside it, for whoever wakes a run after a restart (the document's id). */
  meta?: Record<string, string>;
  /**
   * The tools beyond the document the owner may use now (agents/tools.ts:
   * sharing; the server's settings and users for an admin). Asked for again
   * before each new prompt, so becoming (or stopping being) an admin shows.
   * Each says what the agent is doing while it runs (`activity`).
   */
  serverTools?: () => Promise<ServerAgentTool[]>;
}

/** The settings of a test document's agent: the scripted model, free and the same every run. */
const SCRIPTED: AgentConfig = { apiKey: Redacted.make(""), model: "script", effort: "medium" };

/**
 * A document's agents, as the server gives them to it (DocumentDeps.agents):
 * each session reads the agent's settings (`settings`: the key an admin
 * stored, else the Worker's), keeps the person's conversation in their own
 * store (`chats`), and has the server tools they may use (`serverTools`).
 */
export function documentAgents(o: {
  settings: () => Promise<AgentSettings>;
  chats?: (person: { id: string; name: string }, docId: string) => ChatStore;
  serverTools?: (person: { id: string; name: string }, docId: string) => Promise<ServerAgentTool[]>;
}): DocumentAgents {
  /** The settings now, or why the agent is off. */
  const settings = () =>
    o.settings().catch((e: unknown) => ({
      missing: `the agent's settings couldn't be read (${e instanceof Error ? e.message : String(e)}); try again in a moment`,
      }));
  return {
    start: (opts) => {
      const store = o.chats?.(opts.owner, opts.docId);
      return startSession({
        ...opts,
        settings: opts.scripted ? async () => SCRIPTED : settings,
        // (Its big pictures and PDFs in the blob store, by hash: agents/checkpoint.ts, withBlobs.)
        store: store && opts.blobs ? withBlobs(store, opts.blobs) : store,
        meta: { doc: opts.docId },
        serverTools: o.serverTools && (() => o.serverTools!(opts.owner, opts.docId)),
      });
    },
    guide: documentGuide,
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })),
    changes: CHANGES,
    async descriptionKey() {
      const cfg = await o.settings();
      return !("missing" in cfg) && cfg.model != "script" ? Redacted.value(cfg.apiKey) : "";
    },
  };
}

/** A tool beyond the document (agents/tools.ts), with what the agent is doing while it runs. */
export type ServerAgentTool = AgentTool;

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

export async function startSession(opts: AgentSessionOptions): Promise<AgentSession> {
  const { owner } = opts;
  const first = await opts.settings();
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
  await Effect.runPromise(Effect.sleep(0)); // the in-process sync is microtasks: done by now
  introduce(doc, me);

  const origin = { agent: owner.id }, undoOrigin = { agentUndo: owner.id };
  // One undo step per tool call: its steps merge until the call ends (edited, stopCapturing).
  const undo = new Y.UndoManager(files(doc), { trackedOrigins: new Set([origin]), captureTimeout: Infinity });
  // Others see each edit as it applies: the agent's selection on the old text, then the new typed in (workspace.ts, Pacer).
  const pacer: Pacer = {
    cursor: (path, anchor, head) =>
      presence({ cursor: { path, anchor: Y.relativePositionToJSON(anchor), head: head && Y.relativePositionToJSON(head) } }),
    wait: (ms) => Effect.runPromise(Effect.sleep(ms)),
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
  // The conversation as it was at its last checkpoint, if there is one (a reload, a restart).
  const stored = opts.store ? await opts.store.load().catch((e: unknown) => { console.log(`couldn't read ${owner.id}'s conversation: ${e}`); return null; }) : null;
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
  // Each step of a run, kept in the person's store; a restart goes on from the last (agents/checkpoint.ts).
  const loop = startLoop({
    cfg: "missing" in first ? null : first,
    stored,
    store: opts.store ?? null,
    meta: { person: owner.id, name: owner.name, ...opts.meta },
    tag: "editor",
    hooks: {
      about: (_name, args) => toolPath(args),
      toolStarted: (name, path) => {
        const server = loop.side?.tools.find((t) => t.name == name);
        presence({ activity: `${TOOL_ACTIVITY[name] ?? server?.activity ?? name}${path ? ` ${path}` : ""}` });
      },
      toolEnded: () => presence({ activity: "thinking" }),
      busy: (on) => {
        busy.agent = on;
        syncBusy(on ? "thinking" : undefined);
      },
    },
  });
  const emit = loop.emit;
  const undoable = () => emit({ t: "undoable", count: undo.undoStack.length });

  /** Done in the room: the replica has it once it has seen everything the room has (a few microtasks). */
  const caughtUp = async () => {
    const want = stateVector(opts.room.doc);
    for (let i = 0; i < 200 && !hasSeen(doc, want); i++) await Effect.runPromise(Effect.sleep(0));
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
  // Someone who may only view: the prompt says so, and why the tools that change the document aren't there.
  const prompted = (more: AgentTool[]) => systemPrompt(opts.docName, owner.name, opts.only != null, more.map((t) => t.name)) + kindLine(opts.only != null ? null : opts.kind?.() ?? null, owner.name) + (opts.canEdit() ? "" : `\n\n${owner.name} can only view this document, so you can't change it: you have only the tools that change nothing (read, ls, find, grep and the like). If they ask for a change, say so.`);
  /** The model's side, made once there are settings (at the start, or when a key arrives later). It reads the key at each call. */
  const makeAgent = async (first: AgentConfig) => {
    const serverTools = await beyond();
    return loop.side ?? loop.start(first, prompted(serverTools), [...mine(), ...serverTools]);
  };
  if (loop.cfg) await makeAgent(loop.cfg);
  /** The model's side, being made (a key arrived after the session started). */
  let making: Promise<unknown> | null = null;
  /** The settings now (a key an admin stored, replaced or cleared since the session started): the next model call uses them. */
  const configure = async (next: AgentConfig | null) => {
    loop.configure(next);
    if (next && !loop.side)
      await (making ??= makeAgent(next).finally(() => {
        making = null;
      }));
  };

  return {
    close() {
      loop.abort();
      if (busy.extTimer) clearTimeout(busy.extTimer);
      leave();
      awareness.destroy();
    },
    get model() {
      return loop.model;
    },
    get modelChoice() {
      return loop.modelChoice;
    },
    setModel: loop.setModel,
    async refresh() {
      const cfg = await opts.settings();
      await configure("missing" in cfg ? null : cfg);
      return "missing" in cfg ? cfg.missing : "";
    },
    log: () => loop.log,
    prompt(text, context, files = []) {
      // The tools beyond the document as the owner may use them now (an admin's, say).
      loop.prompt(text, context, files, (side) =>
        beyond().then((more) => {
          side.tools = [...mine(), ...more];
          side.systemPrompt = prompted(more);
        })
      );
    },
    abort: loop.abort,
    async reset() {
      undo.clear();
      await loop.reset(() => {
        busy.agent = false;
        syncBusy();
        presence({ cursor: null });
      });
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
    subscribe: loop.subscribe,
    resume: loop.resume,
    tools: () => mine().map((t) => ({ name: t.name, description: t.description, parameters: Tool.getJsonSchemaFromSchema(t.parameters) })),
    async runTool(name, args, via) {
      if (CHANGES.has(name) && !opts.canEdit()) throw new Error(`${owner.name} can only view this document, so ${name} isn't one of the tools: they are ${mine().map((t) => t.name).join(", ")}.`);
      const tool = tools.find((t) => t.name == name);
      if (!tool) throw new Error(`There's no tool named "${name}". The tools are: ${mine().map((t) => t.name).join(", ")}.`);
      const id = `ext-${crypto.randomUUID()}`;
      let params: Record<string, unknown>;
      try {
        params = Schema.decodeUnknownSync(tool.parameters as Schema.Codec<Record<string, unknown>>)(args ?? {}, { errors: "all" });
      } catch (e) {
        throw new Error(`Validation failed for tool "${name}":\n${(e as Error).message}`);
      }
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
