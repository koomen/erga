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
import { Awareness } from "y-protocols/awareness";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { argumentsSchema } from "../run";
import { colorFor, files, hasSeen, introduce, stamp, stateVector, type Author } from "../../document/content";
import { byLine, VIA } from "../../shared/attribution";
import { pageRefusal } from "../../document/pages";
import { joinLocal } from "../../document/room";
import type { AgentSession, DocumentAgents, SessionOptions, ToolContent } from "../../document/agent";
import type { LogEvent } from "../../shared/agent-log";
import { YjsWorkspace, type Pacer } from "./workspace";
import type { AgentSettings } from "../models";
import { CHANGES, makeTools, toolPath } from "./tools";

/**
 * A document's agents, as the server gives them to it (DocumentDeps.agents): each person's session, and the key the
 * versions' descriptions are written with (`settings`: the key an admin stored, else the Worker's).
 */
export function documentAgents(o: { settings: () => Promise<AgentSettings> }): DocumentAgents {
  return {
    start: startSession,
    changes: CHANGES,
    async descriptionKey() {
      const cfg = await o.settings();
      return !("missing" in cfg) && cfg.model != "script" ? Redacted.value(cfg.apiKey) : "";
    },
  };
}

const TOOL_ACTIVITY: Record<string, string> = {
  open_page: "opening a page",
  read: "reading",
  edit: "editing",
  write: "writing",
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
  diff_versions: "comparing versions",
};

export async function startSession(opts: SessionOptions): Promise<AgentSession> {
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
  const presence = (patch: Record<string, unknown>) => awareness.setLocalState({ ...awareness.getLocalState(), ...patch });
  // Working while an agent calls tools: during a call, and for a while after the last one, since it's thinking between
  // calls and nothing here says when its turn is done.
  const busy = { calls: 0, timer: null as Fiber.Fiber<void> | null };
  let wasBusy = false;
  /** The version the document was at when this agent's last run of calls ended. */
  let lastTurn: Promise<string | null> = Promise.resolve(null);
  const syncBusy = (activity?: string | null) => {
    const on = busy.calls > 0 || busy.timer != null;
    // A run of calls just ended: the document cuts a version of it.
    if (wasBusy && !on) {
      const at = opts.turnEnded?.();
      if (at) { const before = lastTurn; lastTurn = at.catch(() => before); }
    }
    wasBusy = on;
    presence({ busy: on, activity: on ? activity ?? (awareness.getLocalState()?.activity as string | null) ?? "working" : null });
  };
  // The person's tabs hear Undo's count (document/host.ts sends it on).
  const listeners = new Set<(ev: LogEvent) => void>();
  const undoable = () => {
    for (const l of listeners) l({ t: "undoable", count: undo.undoStack.length });
  };

  /** Done in the room: the replica has it once it has seen everything the room has (a few microtasks). */
  const caughtUp = async () => {
    const want = stateVector(opts.room.doc);
    for (let i = 0; i < 200 && !hasSeen(doc, want); i++) await Effect.runPromise(Effect.sleep(0));
  };
  const tools = makeTools(ws, {
    view: (req) => opts.view({ ...req, after: stateVector(doc) }),
    readAsset: opts.readAsset,
    versions: opts.versions,
    lastTurn: () => lastTurn,
    canEdit: opts.canEdit,
    by: () => byLine(owner.id, acting.via),
    caughtUp,
    open: opts.open,
    files: opts.files,
    edited: (path, at) => {
      // One undo step per tool call, and the agent's cursor where it last wrote.
      undo.stopCapturing();
      undoable();
      const t = files(doc).get(path);
      if (t) presence({ cursor: { path, anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(t, at)), head: null } });
    },
  });
  /** The tools as the person may use them now: someone who may only view the document has none that change it. */
  const mine = () => (opts.canEdit() ? tools : tools.filter((t) => !CHANGES.has(t.name)));

  return {
    close() {
      if (busy.timer) Effect.runFork(Fiber.interrupt(busy.timer));
      listeners.clear();
      leave();
      awareness.destroy();
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
    undoable: () => undo.undoStack.length,
    done() {
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
