// Whoever is in the document: one record for each participant, in one map, and the sockets of their tabs. A
// participant is a user in person, or a user via one of their agents: its key is the user and `via`
// (shared/attribution.ts, Act), so two agents of one user are two participants, and a user's tabs are one. The
// document knows no agent: a participant with a `via` only works on the server, where one in person works in their
// tabs. Nothing else keeps who is in the document: the room asks this file to send its messages (room.ts, `tell`).
//
// A participant has:
//   - its connections: its user's tabs that are joined to the room (a participant with a `via` has none);
//   - whether its user may edit, as the app said last (the right is the user's: every participant of theirs has it);
//   - its name tag, which others see on its edits and its caret: the room holds each tab to it (room.ts);
//   - the texts that it last read here (workspace.ts), which its writes merge from;
//   - the state of its work on the server (`Work`): its calls under way, and its turn;
//   - with a `via`: its presence (its caret, and whether it works), and an undo history of its changes, one step for
//     each call. A user in person has neither here: their tab shows them, and keeps their ⌘Z.
//
// The sockets outlive the open document. A Durable Object that holds its sockets with the hibernation API sleeps
// while they're idle, and wakes for their next message with nothing in memory: no room, no document. So each socket
// carries what it is (its attachment, `Tab`: its user, read-only or not, the epoch of the history it holds, and what
// it hears), and this file joins every socket to the document each time the document opens (`attach`), and lets
// them wait while it's closed:
//
// - a tab's edit (any message but presence) opens the document again, from its journal, and every socket joins it:
//   each tab then gets the room's sync step 1 and sends back anything the room lacks;
// - presence alone (carets, awareness) never opens it: while it's closed, a tab's presence goes straight to the
//   other tabs;
// - a message for every tab (the document's publishing state) reaches the tabs that hear events while it's closed, too.
//
// One socket is a whole tab (an editor's: ?events=1): the room's Yjs messages travel as binary frames, its user's
// events (a rename, the tree, Undo's count) as text frames of JSON. A socket without events (a headless participant,
// y-websocket's client) gets the binary frames only.
//
// Two lifetimes, then. What must stay through a sleep is in the socket's attachment. Everything else here is in
// memory, and goes when the document closes (`detach`): the records, with their undo histories, turns and presence.
//
// Trap: the sockets' four functions (`Sockets`) are the only IO of this file, so that the tests put a document to
// sleep and wake it (tests/hibernation.test.ts). The state of a participant's work is one value and one pure
// function (`step`); the class keeps the value, the timers, the undo histories and the presence, and does what each
// step says.

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Fiber from "effect/Fiber";
import * as Y from "yjs";
import { byLine, type Act } from "../../shared/attribution.ts";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, type AwarenessChange } from "../../shared/yjs-protocol.ts";
import { PING, PONG } from "../../shared/room-socket.ts";
import { later, stop } from "../life/later.ts";
import type { Asker, Person, Role } from "../model/access.ts";
import { colorFor, files, sameAuthor, type Author } from "../model/content.ts";
import type { StoreError } from "../store/storage.ts";
import { isAwareness, presenceAs, type Connection, type Participant, type Room } from "./room.ts";
import { Workspace } from "./workspace.ts";

/** How long a participant counts as working after its last call ends, unless its turn is said done. */
export const IDLE_MS = 8_000;

// ---------------------------------------------------------------- the state of a participant's work

/**
 * A participant's work on the server. It works while a call runs, and for IDLE_MS after its last call ended (between
 * calls it thinks, and an outside agent never says that its turn is done). `turn`: the id of its turn, which a user's
 * own agent sends with each call.
 *
 *   resting --call--> calls under way --answered (the last one)--> waiting --idle | done--> resting (the run ended)
 *   waiting --call--> calls under way
 */
export interface Work {
  readonly calls: number;
  /** No call runs, and the timer of the idle rule does. */
  readonly waiting: boolean;
  readonly turn: string | null;
}

export const RESTING: Work = { calls: 0, waiting: false, turn: null };

export type WorkEvent =
  /** A call starts; `turn`: its turn's id, or null (an outside agent: the idle rule alone ends its run). */
  | { on: "call"; turn: string | null }
  /** A call ended. */
  | { on: "answered" }
  /** IDLE_MS passed with no call. */
  | { on: "idle" }
  /** Its user's own agent says that the turn is done. */
  | { on: "done" };

/**
 * What the owner does after a step. mark: a new turn began (a version before it, and its place in the undo history).
 * wait: start the idle timer. stop: stop it. ended: the run of calls ended (the lock goes, and a version is cut).
 */
export type WorkEffect = "mark" | "wait" | "stop" | "ended";

export const working = (w: Work): boolean => w.calls > 0 || w.waiting;

export function step(w: Work, e: WorkEvent): { work: Work; effects: WorkEffect[] } {
  switch (e.on) {
    case "call": {
      const effects: WorkEffect[] = [];
      if (e.turn != null && e.turn != w.turn) effects.push("mark");
      if (w.waiting) effects.push("stop");
      return { work: { calls: w.calls + 1, waiting: false, turn: e.turn ?? w.turn }, effects };
    }
    case "answered": {
      const calls = Math.max(0, w.calls - 1);
      return calls ? { work: { ...w, calls }, effects: [] } : { work: { ...w, calls, waiting: true }, effects: ["wait"] };
    }
    case "idle":
      return w.waiting ? { work: { ...w, waiting: false }, effects: ["ended"] } : { work: w, effects: [] };
    case "done":
      // (With a call under way, the idle rule ends the run after it.)
      return w.waiting ? { work: { ...w, waiting: false }, effects: ["stop", "ended"] } : { work: w, effects: [] };
  }
}

// ---------------------------------------------------------------- the participants

/** A turn of a participant: where it began in the undo history, the version before it, and the files it changed. */
interface Turn {
  id: string;
  from: number;
  version: string | null;
  files: Set<string>;
}

interface Entry extends Participant {
  author: Author;
  /** Whether its user may edit, as the app said last (x-erga-access), or as the server's call vouched. */
  edits: boolean;
  /** Its user's tabs that are joined to the open room, by the tab's id. */
  tabs: Map<string, Connection>;
  work: Work;
  timer: Fiber.Fiber<void> | null;
  /** What it does now, for its presence ("editing index.html"). */
  activity: string | null;
  workspace: Workspace | null;
  /** With a `via`, once it has worked here. */
  presence: Awareness | null;
  undo: Y.UndoManager | null;
  turn: Turn | null;
  /** The version the document was at when its last run of calls ended. */
  lastTurn: Promise<string | null>;
}

/** What Undo can do for a user: how many of their agents' changes it can take back and put back, and their agent's last turn. */
export interface Undoable {
  count: number;
  redo: number;
  turn: { changes: number; files: string[]; version: string | null } | null;
}

/**
 * What a socket is, kept with it (its attachment): its user; read-only or not; `epoch`, the history the tab holds,
 * once it has one; `events`, whether it hears its user's events (and the document's details as it joins).
 */
export type Tab = {
  id: string;
  readOnly: boolean;
  epoch: string | null;
  person: Person;
  events: boolean;
  /** A viewer's page: it hears what every tab hears, first the version to show, and never joins the room. */
  watch?: boolean;
  who?: Asker;
  /** It hears that the document's comments changed (?comments=1: the page's editor, libs/text/ui/comments.ts). */
  comments?: boolean;
};

export interface TabSocket {
  send(message: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** The tabs' sockets, as the adapter holds them: this file's only IO. */
export interface Sockets<S extends TabSocket> {
  /** Every socket the document has (a Durable Object's, asleep or not). */
  all(): S[];
  /** What a socket is (its attachment); null for one that isn't a tab. */
  tabOf(socket: S): Tab | null;
  /** Keeps what a socket is with it. */
  keep(socket: S, tab: Tab): void;
}

/** What the participants need of their document (document/api/host.ts gives it). */
export interface ParticipantsHost {
  isOpen(): boolean;
  /** Opens the document if it isn't (a tab's message after a sleep): false if there's no such document. */
  reopen(): Effect.Effect<boolean, StoreError>;
  /** Something happened: the document stays open a while longer. */
  activity(): void;
  /** The version viewers see now, where the document is closed (it stays closed); null: no document. */
  viewed(): Effect.Effect<string | null, StoreError>;
  /** The version viewers see, for a watcher that joins the open document. */
  greet(tell: (ver: string) => void): void;
  /** A person's picture, as their tabs know it. */
  avatarOf(person: Person): string | undefined;
  /** What a tab hears first: the document's details as its user sees them, and its tree. */
  hello(person: Person, canEdit: boolean): Promise<unknown>;
  /** A tab that hears events joined: what else it hears first (the files on their way). */
  joined(send: (msg: unknown) => void): void;
  /** The last tab that may edit left: what they did is a version. */
  left(): void;
  /** Cuts a version (if the document changed since the last one), and answers the version it's at then. */
  cutVersion(): Promise<string | null>;
}

/** A socket call that may find it closed already: nothing to do then. */
const quietly = (f: () => void) => void Result.try(f);

/** A participant's key: its user, and how they act. */
const keyOf = (login: string, via?: string | null) => `${login}\n${via ?? ""}`;

export class Participants<S extends TabSocket = TabSocket> {
  /** The one record of each participant of the open document. */
  private all = new Map<string, Entry>();
  /** The order of the undo steps and the turns, across a user's participants. */
  private seq = 0;
  /** The open document's room; null while the document is closed. `only`: a single file's one path. */
  private open: { room: Room; only: string | null } | null = null;

  constructor(
    private sockets: Sockets<S>,
    private host: ParticipantsHost
  ) {}

  private get room(): Room {
    if (!this.open) throw new Error("the document is closed");
    return this.open.room;
  }

  // ---------------------------------------------------------------- the sockets: joined to the room while it's open

  /** The document's room opened: the participants are of this room, until `detach`, and their tabs get its messages. */
  opened(room: Room, only: string | null): void {
    this.open = { room, only };
    room.tell = (message, except) => {
      for (const e of this.all.values()) for (const conn of e.tabs.values()) if (conn !== except) conn.send(message);
    };
  }

  /** The document opened (again): every socket joins it; one holding another history is closed (the tab reloads). */
  attach(): void {
    for (const socket of this.sockets.all()) if (!this.join(socket)) quietly(() => socket.close(4409, "stale epoch"));
  }

  /** The document closed: the sockets wait for it to open again, and what was in memory goes. */
  detach(): void {
    for (const e of this.all.values()) {
      if (e.timer) stop(e.timer);
      e.undo?.destroy();
      e.presence?.destroy();
    }
    this.all.clear();
    this.open = null;
  }

  /**
   * A new socket, or one waiting, joins the open document (while it's closed, it waits); false if it holds another
   * epoch's history (it's refused, never merged). Someone who may only view joins read-only: they see every edit, and
   * theirs go nowhere. Each edit that the socket sends is its user's (the room names it from the connection).
   */
  join(socket: S, tab = this.sockets.tabOf(socket)): boolean {
    if (!tab || !this.open || this.connOf(tab)) return true;
    const { room } = this.open;
    const send = (m: string | Uint8Array) => quietly(() => socket.send(m));
    const json = (msg: unknown) => send(JSON.stringify(msg));
    // A watcher (a viewer's page): first the version to show; it never joins the room.
    if (tab.watch) {
      this.host.greet((ver) => json({ type: "view", ver }));
      return true;
    }
    if (tab.epoch && tab.epoch != room.epoch) return false;
    // A tab that joins as the document wakes brings no request: what its user may do is what its socket says.
    const e = this.of(tab.person, null, this.mine(tab.person.id).length ? undefined : !tab.readOnly) as Entry;
    // A tab that hears events (an editor's) first hears what it needs to start: the document's details as its user
    // sees them, and its tree (document/api/http.ts, hello). Its user's events come over the same socket, as text.
    if (tab.events) {
      void this.host.hello(tab.person, !tab.readOnly).then(json, () => {});
      this.host.joined(json);
    }
    const conn = room.connect(e, send, { epoch: tab.epoch, readOnly: tab.readOnly });
    if (!conn) return false;
    // From now on it holds this history: after a sleep, it may only join this epoch again.
    if (tab.epoch != room.epoch) this.sockets.keep(socket, { ...tab, epoch: room.epoch });
    e.tabs.set(tab.id, conn);
    return true;
  }

  /** The connection of a tab that is joined to the room. */
  private connOf(tab: Tab): Connection | undefined {
    return this.all.get(keyOf(tab.person.id))?.tabs.get(tab.id);
  }

  /**
   * A viewer's page (a watcher) connects. On an open document it joins as any tab does. A closed document stays closed,
   * with no room loaded for someone who only reads: the page hears the version kept with the files, and joins when
   * the document opens (attach). `accept` makes the socket, once there is a document; null: there's none.
   */
  watch(tab: Tab, accept: () => S): Effect.Effect<S | null, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      if (!self.host.isOpen()) {
        const ver = yield* self.host.viewed();
        if (ver == null) return null;
        // (Still closed: with no version kept, working it out opened the document.)
        if (!self.host.isOpen()) {
          const socket = accept();
          quietly(() => socket.send(JSON.stringify({ type: "view", ver })));
          return socket;
        }
      }
      if (!(yield* self.host.reopen())) return null;
      const socket = accept();
      self.join(socket, tab);
      return socket;
    });
  }

  /** A message from a tab: binary, the room's; text, only PING (where nothing answered it for us). */
  message(socket: S, data: Uint8Array | string): Effect.Effect<void, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const tab = self.sockets.tabOf(socket);
      if (!tab) return;
      if (typeof data == "string") {
        if (data == PING) quietly(() => socket.send(PONG));
        return;
      }
      // A watcher only listens.
      if (tab.watch) return;
      let conn = self.connOf(tab);
      if (!conn) {
        // Presence while the document is closed: to the other tabs, with the name of its socket, and nothing opens.
        // Bytes that are no presence close their socket, as the open room does, and reach no other tab.
        if (isAwareness(data) && !self.host.isOpen()) {
          const presence = presenceAs(data, self.tag(tab.person));
          return presence ? self.relay(socket, tab.id, presence) : quietly(() => socket.close(4400, "malformed message"));
        }
        if (!(yield* self.host.reopen())) return quietly(() => socket.close(4404, "document deleted"));
        // Joined as it opened (attach); one refused there is closed.
        if (!self.connOf(tab) && !self.join(socket)) return quietly(() => socket.close(4409, "stale epoch"));
        conn = self.connOf(tab);
      }
      if (!conn) return;
      if (!conn.receive(data)) return quietly(() => socket.close(4400, "malformed message"));
      if (!isAwareness(data)) self.host.activity();
    });
  }

  /** A socket closed. */
  closed(socket: S): void {
    const tab = this.sockets.tabOf(socket);
    const conn = tab && this.connOf(tab);
    if (!conn) return;
    this.all.get(keyOf(tab.person.id))!.tabs.delete(tab.id);
    conn.close();
    // When the last tab that may edit leaves, what they did is a version.
    if (conn.readOnly) return;
    for (const e of this.all.values()) for (const other of e.tabs.values()) if (!other.readOnly) return;
    this.host.left();
  }

  /**
   * The document's permissions changed: a tab whose user may no longer open it is closed (4403: the page opens again,
   * and says so); one whose user may edit now, or no longer, is closed to join again as they may now (4408: the tab
   * comes back by itself); every other tab hears it ({ type: "access" }).
   */
  async permissionsChanged(roleOf: (who: Asker) => Promise<Role | null>): Promise<void> {
    for (const socket of this.sockets.all()) {
      const tab = this.sockets.tabOf(socket);
      if (!tab?.who) continue;
      const role = await roleOf(tab.who);
      const edits = role == "owner" || role == "editor";
      if (!role) quietly(() => socket.close(4403, "not shared"));
      else if (!tab.watch && edits == tab.readOnly) quietly(() => socket.close(4408, "role changed"));
    }
    this.tellAll({ type: "access" });
  }

  /** A message for every tab that hears events, whoever's (a new version, a rename, its publishing state). Opens nothing. */
  tellAll(msg: unknown): void {
    const text = JSON.stringify(msg);
    for (const socket of this.sockets.all()) if (this.sockets.tabOf(socket)?.events) quietly(() => socket.send(text));
  }

  /** A message for a user's own tabs (an editor's: not a watcher, which hears only what every tab does). */
  tell(login: string, msg: unknown): void {
    const text = JSON.stringify(msg);
    for (const socket of this.tabsOf(login)) quietly(() => socket.send(text));
  }

  /** A user's own tabs: the sockets that hear their events. */
  tabsOf(login: string): S[] {
    return this.sockets.all().filter((socket) => {
      const tab = this.sockets.tabOf(socket);
      return !!tab && tab.events && !tab.watch && tab.person.id == login;
    });
  }

  /** The document's comments changed: the tabs that hear it read them again. Opens nothing. */
  commentsChanged(): void {
    for (const socket of this.sockets.all())
      if (this.sockets.tabOf(socket)?.comments) quietly(() => socket.send(JSON.stringify({ type: "comments" })));
  }

  private relay(from: S, id: string, data: Uint8Array): void {
    for (const socket of this.sockets.all()) {
      if (socket === from) continue;
      const tab = this.sockets.tabOf(socket);
      if (tab && tab.id != id) quietly(() => socket.send(data));
    }
  }

  // ---------------------------------------------------------------- the participants of the open document

  /**
   * The participant for a user, in person or via one of their agents: made the first time. `edits`: whether the user
   * may edit, when the caller knows (the app said so, or the server's own call checked it): every participant of
   * theirs has that right then.
   */
  of(user: Person, via?: string | null, edits?: boolean): Participant {
    const mine = this.mine(user.id);
    if (edits != null) for (const e of mine) e.edits = edits;
    const key = keyOf(user.id, via);
    const author = this.tag(user, via);
    const had = this.all.get(key);
    if (had) {
      // (Who they are as the app says it now: a call of the server's own knows only the login.)
      if ((user.name != user.id || user.avatar) && !sameAuthor(had.author, author)) had.author = author;
      return had;
    }
    const e: Entry = {
      act: via ? { login: user.id, via } : { login: user.id },
      author,
      edits: edits ?? mine[0]?.edits ?? false,
      canEdit: () => e.edits,
      tabs: new Map(),
      work: RESTING,
      timer: null,
      activity: null,
      workspace: null,
      presence: null,
      undo: null,
      turn: null,
      lastTurn: Promise.resolve(null),
    };
    this.all.set(key, e);
    return e;
  }

  /** A user's participants: in person, and via each of their agents. */
  private mine(login: string): Entry[] {
    return [...this.all.values()].filter((e) => e.act.login == login);
  }

  /** The name tag of a user in person, or via one of their agents: what the others see on their edits and their caret. */
  private tag(user: Person, via?: string | null): Author {
    if (via) return { user: user.id, name: byLine(user.name, via), color: colorFor(user.id, true), kind: "agent", via };
    const avatar = this.host.avatarOf(user);
    return { user: user.id, name: user.name, color: colorFor(user.id), kind: "person", ...(avatar ? { avatar } : {}) };
  }

  /** The participant's view of the text: the texts that it last read, and its edits (workspace.ts). */
  workspace(p: Participant): Workspace {
    const e = p as Entry;
    return (e.workspace ??= new Workspace(this.room, e, this.open?.only ?? null, (path, anchor, head) =>
      this.present(e, { cursor: { path, anchor: Y.relativePositionToJSON(anchor), head: head && Y.relativePositionToJSON(head) } })
    ));
  }

  /** Whether any participant is in the middle of its work on the server. */
  working(): boolean {
    for (const e of this.all.values()) if (working(e.work)) return true;
    return false;
  }

  /**
   * Runs one call of a participant's work. `turn`: its turn's id (null: none). `changes`: it changes the document, so
   * it is refused while another participant holds the lock for source edits; with `lock`, it takes that lock, for
   * this run of calls. Throws why not (the lock's holder), before anything runs.
   */
  async during<A>(
    p: Participant,
    call: { turn: string | null; activity: string; changes: boolean; lock: boolean },
    run: () => Promise<A>
  ): Promise<A> {
    const e = p as Entry;
    const { room } = this;
    if (call.changes) {
      if (call.lock ? room.lock(e, e.author.name) : room.lockedBy(e)) throw new Error(room.refusal(e)!.message);
      // Its undo history starts before its first change.
      if (e.act.via) this.history(e);
    }
    e.activity = call.activity;
    if (this.go(e, { on: "call", turn: call.turn }).includes("mark")) {
      // The turn begins: its place in the undo history ("Undo the turn"), and a version of the document before it.
      const turn: Turn = { id: call.turn!, from: e.undo?.undoStack.length ?? 0, version: null, files: new Set() };
      e.turn = turn;
      this.seq++;
      turn.version = await this.host.cutVersion().catch(() => null);
    }
    try {
      return await run();
    } finally {
      e.activity = "working";
      this.go(e, { on: "answered" });
    }
  }

  /** The participant's turn is done (its user's own agent says so): it works here no more. */
  done(p: Participant): void {
    this.go(p as Entry, { on: "done" });
  }

  /** A call changed a file, up to `at`: one undo step for each call, its turn's files, and its caret where it last wrote. */
  edited(p: Participant, path: string, at: number): void {
    const e = p as Entry;
    e.undo?.stopCapturing();
    this.told(e);
    if (e.turn && e.turn.id == e.work.turn) e.turn.files.add(path);
    const t = files(this.room.doc).get(path);
    if (t)
      this.present(e, { cursor: { path, anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(t, at)), head: null } });
  }

  /** The version the document was at when the participant's last run of calls ended; null before its first. */
  lastTurn(p: Participant): Promise<string | null> {
    return (p as Entry).lastTurn;
  }

  // ---------------------------------------------------------------- undo, for a user: the changes of their agents

  /** What Undo and Redo can do for a user, and their agent's last turn (or the one under way). */
  undoable(login: string): Undoable {
    const mine = this.histories(login);
    const e = this.turnOf(login);
    return {
      count: mine.reduce((n, x) => n + x.undo!.undoStack.length, 0),
      redo: mine.reduce((n, x) => n + x.undo!.redoStack.length, 0),
      turn: e?.turn
        ? { changes: Math.max(0, (e.undo?.undoStack.length ?? 0) - e.turn.from), files: [...e.turn.files].sort(), version: e.turn.version }
        : null,
    };
  }

  /**
   * Takes back the newest change of the user's agents (one call), if any; or puts back the one taken back last.
   * `why`: it can't now (another participant holds the lock for source edits, or the user may only view).
   */
  replay(login: string, which: "undo" | "redo"): { ok: boolean; why?: string } {
    const stack = (e: Entry) => (which == "undo" ? e.undo!.undoStack : e.undo!.redoStack);
    const at = (e: Entry) => (stack(e).at(-1)?.meta.get(STEP) as number | undefined) ?? -1;
    const newest = this.histories(login)
      .filter((e) => stack(e).length)
      .sort((a, b) => at(b) - at(a))[0];
    if (!newest) return { ok: false };
    const no = this.room.refusal(newest);
    return no ? { ok: false, why: no.message } : { ok: this.step(newest, which) };
  }

  /** Takes back every change of the user's agent's last turn that Undo still can, at once: how many. */
  undoTurn(login: string): number {
    const e = this.turnOf(login);
    let n = 0;
    while (e?.turn && e.undo && e.undo.undoStack.length > e.turn.from && this.step(e, "undo")) n++;
    return n;
  }

  /** The user's participants that have an undo history. */
  private histories(login: string): Entry[] {
    return this.mine(login).filter((e) => e.undo);
  }

  /** The user's participant that has a turn (their own agent's). */
  private turnOf(login: string): Entry | undefined {
    return this.mine(login).find((e) => e.turn);
  }

  private history(e: Entry): Y.UndoManager {
    if (e.undo) return e.undo;
    // One step for each call: its changes merge until the call ends (edited, stopCapturing).
    const undo = (e.undo = new Y.UndoManager(files(this.room.doc), { trackedOrigins: new Set([e]), captureTimeout: Infinity }));
    undo.on("stack-item-added", ({ stackItem }) => void stackItem.meta.set(STEP, ++this.seq));
    return undo;
  }

  /**
   * Undo or Redo of one step of a participant, through the room's door: the change is the participant's, also when
   * it only deletes, and it changes only the participant's own text (what anyone typed since stays). The history
   * files the step on the other stack only if its flag is still on when the transaction ends, after undo()/redo()
   * turned it off: so it is turned on again until then.
   */
  private step(e: Entry, which: "undo" | "redo"): boolean {
    const undo = e.undo!;
    if (!(which == "undo" ? undo.undoStack : undo.redoStack).length || this.room.refusal(e)) return false;
    this.room.as(
      e,
      () => {
        undo[which]();
        if (which == "undo") undo.undoing = true;
        else undo.redoing = true;
      },
      undo
    );
    undo.undoing = undo.redoing = false;
    // A call still under way goes on in a step of its own.
    undo.stopCapturing();
    this.told(e);
    return true;
  }

  /** The user's tabs hear Undo's and Redo's counts as they change. */
  private told(e: Entry): void {
    if (!e.undo) return;
    const { count, redo } = this.undoable(e.act.login);
    this.tell(e.act.login, { type: "undoable", count, redo });
  }

  // ---------------------------------------------------------------- the owner of each participant's work

  /** Takes a step of a participant's work, and does what it says. Answers the effects. */
  private go(e: Entry, event: WorkEvent): WorkEffect[] {
    const { work, effects } = step(e.work, event);
    e.work = work;
    for (const f of effects) {
      if ((f == "stop" || f == "wait") && e.timer) stop(e.timer);
      if (f == "stop") e.timer = null;
      else if (f == "wait")
        e.timer = later(IDLE_MS, () => {
          e.timer = null;
          this.go(e, { on: "idle" });
        });
      else if (f == "ended") {
        // The run of calls ended: the lock for source edits goes, if it had it, and the document cuts a version of it.
        this.room.unlock(e);
        const before = e.lastTurn;
        e.lastTurn = this.host.cutVersion().catch(() => before);
      }
    }
    const on = working(work);
    this.present(e, { busy: on, activity: on ? (e.activity ?? "working") : null });
    return effects;
  }

  /**
   * The presence of a participant with a `via`: its name tag, its caret and whether it works, for every tab. It is a
   * real Awareness with a client number of its own, which renews its state while the room is open; the room's
   * Awareness takes each update, as it takes a tab's.
   */
  private present(e: Entry, patch: Record<string, unknown>): void {
    if (!e.act.via) return;
    let aw = e.presence;
    if (!aw) {
      aw = e.presence = new Awareness(new Y.Doc());
      const mine = aw;
      aw.on("update", ({ added, updated, removed }: AwarenessChange) =>
        applyAwarenessUpdate(this.room.awareness, encodeAwarenessUpdate(mine, [...added, ...updated, ...removed]), e)
      );
      aw.setLocalState({ user: e.author, busy: false, activity: null, cursor: null });
    }
    aw.setLocalState({ ...aw.getLocalState(), user: e.author, ...patch });
  }
}

/** Where an undo step keeps its place in the order of its user's steps. */
const STEP = "step";
