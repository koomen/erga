// Each person's agent's hands in a document: one session per person per document, in the document's host
// (document/host.ts), which starts it through `documentAgents` (the contract: document/agent.ts). Every agent's
// document tools run here for that person: their own agent's (agents/person/, which reaches the document through
// agents/tools.ts, runInDocument) and an outside agent's with one of their tokens. The session joins the document room
// as an ordinary Yjs peer with its own replica of the shared doc, so others see its edits as they apply, attributed
// ("Pete's agent"), its labelled caret that follows them, and whether it's working, on awareness. It keeps the undo
// history of those edits, one step per tool call, for its person's Undo.
//
// The tools are written against the small Workspace interface (agents/document/workspace.ts, YjsWorkspace). This
// module is the Promise edge: document/host.ts wraps what it exposes in Effect.

import * as Y from "yjs";
import { Awareness } from "../../shared/yjs-protocol.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { argumentsSchema } from "../run";
import { colorFor, files, hasSeen, introduce, stamp, stateVector, type Author } from "../../document/content";
import { byLine, VIA } from "../../shared/attribution";
import { pageRefusal } from "../../document/pages";
import { joinLocal, LOCK_IDLE_MS } from "../../document/room";
import type { AgentSession, DocumentAgents, SessionOptions, ToolContent } from "../../document/agent";
import type { LogEvent } from "../../shared/agent-log";
import { YjsWorkspace, type Cursor } from "./workspace";
import { cleanPath } from "../../document/pages";
import type { AgentSettings } from "../models";
import type { Sandbox } from "../../document/page-api";
import { CHANGES, makeTools, toolPath } from "./tools";
import { unifiedDiff } from "../../document/versions";

/**
 * A document's agents, as the server gives them to it (DocumentDeps.agents): each person's session, and the key the
 * versions' descriptions are written with (`settings`: the Anthropic key an admin stored, else the Worker's), and the
 * sandbox a page's own API runs in.
 */
export function documentAgents(o: { settings: () => Promise<AgentSettings>; sandbox: Sandbox }): DocumentAgents {
  return {
    start: (opts) => startSession(opts, o.sandbox),
    sandbox: o.sandbox,
    changes: CHANGES,
    async descriptionKey() {
      const cfg = await o.settings();
      // The server's Anthropic key, whose ever keys the agents use (the agent_keys setting).
      if (!("missing" in cfg) && cfg.model == "script") return "";
      const key = cfg.server?.anthropic;
      return key ? Redacted.value(key) : "";
    },
  };
}

const TOOL_ACTIVITY: Record<string, string> = {
  open_page: "opening a page",
  read: "reading",
  edit: "editing",
  document_api: "reading the page's edits",
  call_edit: "editing",
  write: "writing",
  grep: "searching",
  view_page: "looking at the page",
  eval_in_page: "running code in the page",
  page_log: "reading the live page",
  page_input: "acting on the page",
  diff_versions: "comparing versions",
};

async function startSession(opts: SessionOptions, sandbox: Sandbox): Promise<AgentSession> {
  const { owner } = opts;
  // Its work is its person's, via it: "Ada, via their agent".
  const me: Author = { user: owner.id, name: byLine(owner.name, VIA.agent), color: colorFor(owner.id, true), kind: "agent", via: VIA.agent };
  /** Who the session's edits are by now: the person's agent, or, while a shared agent's calls run, that agent (runTool, `via`). */
  let acting = me;
  /** Says who edits now, in the shared doc's authors, so each edit is attributed to it. */
  const actAs = (a: Author) => { if (acting != a) { acting = a; introduce(doc, a); presence({ user: a }); } };

  // The session's own replica of the shared doc, joined to the room as a peer.
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: me, busy: false, activity: null, cursor: null });
  const room = joinLocal(opts.room, doc, awareness);
  await Effect.runPromise(Effect.sleep(0)); // the in-process sync is microtasks: done by now
  introduce(doc, me);

  const origin = { agent: owner.id };
  // One undo step per tool call: its steps merge until the call ends (edited, stopCapturing).
  const undo = new Y.UndoManager(files(doc), { trackedOrigins: new Set([origin]), captureTimeout: Infinity });
  // Where each edit ends, as the agent's caret: others' editors play the edit as typing up to it (workspace.ts).
  const cursor: Cursor = (path, anchor, head) =>
    presence({ cursor: { path, anchor: Y.relativePositionToJSON(anchor), head: head && Y.relativePositionToJSON(head) } });
  const ws = new YjsWorkspace(
    doc,
    () => acting,
    opts.canEdit,
    origin,
    opts.only ?? null,
    (path) => (opts.kind ? pageRefusal(opts.kind(), path, opts.docName) : null),
    cursor
  );
  const presence = (patch: Record<string, unknown>) => awareness.setLocalState({ ...awareness.getLocalState(), ...patch });
  // Working while an agent calls tools: during a call, and for a while after the last one, since it's thinking between
  // calls and nothing here says when its turn is done.
  const busy = { calls: 0, timer: null as Fiber.Fiber<void> | null };
  let wasBusy = false;
  /**
   * The person's own agent's turn here (never a shared agent's, which says no end): where it began in the undo history,
   * the version before it, and the files it changed. It begins with the agent's first call after done().
   */
  let turn: { from: number; version: string | null; files: Set<string> } | null = null;
  let turnOver = true;
  const own = (via: string | undefined) => !via || via == VIA.agent;
  /** The version the document was at when this agent's last run of calls ended. */
  let lastTurn: Promise<string | null> = Promise.resolve(null);
  const syncBusy = (activity?: string | null) => {
    const on = busy.calls > 0 || busy.timer != null;
    // A run of calls just ended: the document cuts a version of it, and the lock for source edits goes, if it had it.
    if (wasBusy && !on) {
      room.unlock();
      const at = opts.cutVersion?.();
      if (at) { const before = lastTurn; lastTurn = at.catch(() => before); }
    }
    wasBusy = on;
    presence({ busy: on, activity: on ? activity ?? (awareness.getLocalState()?.activity as string | null) ?? "working" : null });
  };
  // The person's tabs hear Undo's and Redo's counts (document/host.ts sends them on).
  const listeners = new Set<(ev: LogEvent) => void>();
  const undoable = () => {
    for (const l of listeners) l({ t: "undoable", count: undo.undoStack.length, redo: undo.redoStack.length });
  };
  /**
   * Undo or Redo of one step, in one transaction stamped as the agent's (so it is the agent's even when it only deletes).
   * The manager files the step on the other stack only if its flag is still on when the transaction ends, after
   * undo()/redo() turned it off: so it is turned on again until then. Like Undo, Redo changes only the agent's own text:
   * what anyone typed since stays.
   */
  const replay = (which: "undo" | "redo") => {
    if (!(which == "undo" ? undo.undoStack : undo.redoStack).length) return false;
    doc.transact(() => {
      undo[which]();
      stamp(doc, acting);
      if (which == "undo") undo.undoing = true;
      else undo.redoing = true;
    }, undo);
    undo.undoing = undo.redoing = false;
    // A call still under way goes on in a step of its own.
    undo.stopCapturing();
    undoable();
    return true;
  };

  /** Done in the room: the replica has it once it has seen everything the room has (a few microtasks). */
  const caughtUp = async () => {
    const want = stateVector(opts.room.doc);
    for (let i = 0; i < 200 && !hasSeen(doc, want); i++) await Effect.runPromise(Effect.sleep(0));
  };
  const tools = makeTools(ws, {
    view: async (req) => {
      // The render reads the room: it waits for the agent's edits to reach it (a few microtasks).
      const want = stateVector(doc);
      for (let i = 0; i < 200 && !hasSeen(opts.room.doc, want); i++) await Effect.runPromise(Effect.sleep(0));
      return opts.view(req);
    },
    live: opts.live,
    readAsset: opts.readAsset,
    versions: opts.versions,
    lastTurn: () => lastTurn,
    canEdit: opts.canEdit,
    by: () => byLine(owner.id, acting.via),
    caughtUp,
    open: opts.open,
    files: opts.files,
    sandbox,
    edited: (path, at) => {
      // One undo step per tool call, and the agent's cursor where it last wrote.
      undo.stopCapturing();
      undoable();
      if (own(acting.via)) turn?.files.add(path);
      const t = files(doc).get(path);
      if (t) presence({ cursor: { path, anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(t, at)), head: null } });
    },
  });
  /** Whether a person has the file open, their caret in it (the page's editor, or the source view: their presence). */
  const someoneHas = (path: string) =>
    [...opts.room.awareness.getStates().values()].some((st) => {
      const p = st as { user?: { kind?: string }; cursor?: { path?: string } | null };
      return p.user?.kind == "person" && p.cursor?.path == path;
    });
  /** The tools as the person may use them now: someone who may only view the document has none that change it. */
  const mine = () => (opts.canEdit() ? tools : tools.filter((t) => !CHANGES.has(t.name)));

  return {
    close() {
      if (busy.timer) Effect.runFork(Fiber.interrupt(busy.timer));
      listeners.clear();
      room.leave();
      awareness.destroy();
    },
    undo: () => replay("undo"),
    redo: () => replay("redo"),
    undoable: () => ({
      count: undo.undoStack.length,
      redo: undo.redoStack.length,
      turn: turn && { changes: Math.max(0, undo.undoStack.length - turn.from), files: [...turn.files].sort(), version: turn.version },
    }),
    undoTurn() {
      let n = 0;
      while (turn && undo.undoStack.length > turn.from && replay("undo")) n++;
      return n;
    },
    async turnDiff() {
      const before = turn?.version && opts.versions ? await opts.versions.files(turn.version) : null;
      return before && opts.versions ? unifiedDiff(before, await opts.versions.current()).diff : "";
    },
    done() {
      turnOver = true;
      if (busy.calls) return;
      if (busy.timer) Effect.runFork(Fiber.interrupt(busy.timer));
      busy.timer = null;
      syncBusy();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    tools: () => mine().map((t) => ({ name: t.name, description: t.description, parameters: argumentsSchema(t.parameters) })),
    async runTool(name, args, via) {
      const here = mine();
      if (CHANGES.has(name) && !opts.canEdit())
        throw new Error(
          `${owner.name} can only view this document, so ${name} isn't one of the tools: they are ${here.map((t) => t.name).join(", ")}.`
        );
      const tool = tools.find((t) => t.name == name);
      if (!tool) throw new Error(`There's no tool named "${name}". The tools are: ${here.map((t) => t.name).join(", ")}.`);
      const id = `ext-${crypto.randomUUID()}`;
      let params: Record<string, unknown>;
      try {
        params = Schema.decodeUnknownSync(tool.parameters as Schema.Codec<Record<string, unknown>>)(args ?? {}, { errors: "all" });
      } catch (e) {
        throw new Error(`Validation failed for tool "${name}":\n${(e as Error).message}`);
      }
      const path = toolPath(params);
      // An edit to the source locks the document for this agent's run of them: no one else's edit lands meanwhile, and
      // the tabs show the page read-only (document/room.ts). Any edit while another has it says so.
      if (CHANGES.has(name)) {
        // (Only an edit of a page that's there, or of a file someone has open in the source view: a new file, or a
        // stylesheet nobody has open, can't be in anyone's typing.)
        const clean = path != null ? cleanPath(path) : null;
        // (A glob's edit may reach any page.)
        const page = !!clean && (/[*?{]/.test(clean) || (/\.html?$/i.test(clean) && files(doc).has(clean)));
        const open = !!clean && someoneHas(clean);
        // (Named as its edits are: a shared agent's under its person, via its token's label.)
        const who = via ? byLine(owner.name, via) : me.name;
        const other = name == "call_edit" || !(page || open) ? room.lockedBy() : room.lock(who);
        if (other)
          throw new Error(
            `${other} is editing this document's source just now, so nothing was changed. The lock ends when their turn ends, or ${LOCK_IDLE_MS / 1000} seconds after their last edit: wait, then try again.`
          );
      }
      // The person's own agent's turn begins: a version of the document before it (the panel's "See changes" shows the
      // turn from it), and its place in the undo history ("Undo the turn").
      if (own(via) && turnOver) {
        turnOver = false;
        const began: NonNullable<typeof turn> = { from: undo.undoStack.length, version: null, files: new Set() };
        turn = began;
        began.version = (await Promise.resolve(opts.cutVersion?.()).catch(() => null)) ?? null;
      }
      busy.calls++;
      // A shared agent's edits are its person's, via it, under the token's label ("Ada, via a shared agent (CI)"); the cursor says so too.
      if (via) actAs({ ...me, name: byLine(owner.name, via), via });
      if (busy.timer) {
        Effect.runFork(Fiber.interrupt(busy.timer));
        busy.timer = null;
      }
      syncBusy(`${TOOL_ACTIVITY[name] ?? name}${path ? ` ${path}` : ""}`);
      try {
        const result = await tool.execute(id, params);
        // A PDF goes out as a document (read's block for it is an image's, with the PDF's type).
        return (result.content as ToolContent[]).map((c) => (c.type == "image" && c.mimeType == "application/pdf" ? { type: "document", data: c.data, mimeType: "application/pdf" } : c));
      } finally {
        busy.calls--;
        if (!busy.calls) actAs(me);
        if (busy.timer) Effect.runFork(Fiber.interrupt(busy.timer));
        busy.timer = Effect.runFork(
          Effect.sleep(IDLE_MS).pipe(
            Effect.andThen(
              Effect.sync(() => {
                busy.timer = null;
                syncBusy();
              })
            )
          )
        );
        syncBusy("working");
      }
    },
  };
}

/** How long an agent counts as working after its last tool call, unless it says its turn is done (done()). */
const IDLE_MS = 8_000;
