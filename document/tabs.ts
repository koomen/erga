// A document's tabs, over WebSockets that outlive the open document. A
// Durable Object that holds its sockets with the hibernation API sleeps
// while they're idle, and wakes for their next message with nothing in
// memory: no room, no document. So each socket carries what it is (its
// attachment: read-only or not, the epoch of the history it holds, and
// whose events it hears), and this hub joins every socket to the document
// each time the document opens, and lets them wait while it's closed:
//
// - a tab's edit (any message but presence) opens the document again, from
//   its journal, and every socket joins it: each tab then gets the room's
//   sync step 1 and sends back anything the room lacks;
// - presence alone (carets, awareness) never opens it: while it's closed,
//   a tab's presence goes straight to the other tabs;
// - a message for every tab (the homepage's deploy status) reaches the
//   tabs that hear events while it's closed, too.
//
// One socket is a whole tab (an editor's: ?events=1): the room's Yjs
// messages travel as binary frames, its person's events (the agent's, a
// rename, the tree) as text frames of JSON. A socket without events (a
// headless participant, y-websocket's client) gets the binary frames only.
//
// Platform-neutral on purpose (sockets are anything with send and close), so
// the tests can put a document to sleep and wake it.

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { Person } from "./access.ts";
import type { Document } from "./document.ts";
import type { Opened } from "./open.ts";
import type { StoreError } from "./room.ts";
import { isAwareness, readsAsAwareness } from "./room.ts";
import { PING, PONG } from "../shared/room-socket.ts";
import type { Asker, Role } from "./access.ts";

/**
 * What a socket is, kept with it: read-only or not; `epoch`, the history the tab holds, once it has one; `events`,
 * whether it hears its person's events (and the document's details as it joins: Document.joinRoom).
 */
export type Tab = {
  id: string;
  readOnly: boolean;
  epoch: string | null;
  person: Person;
  events: boolean;
  watch?: boolean;
  who?: Asker;
  /** It hears that the document's comments changed (?comments=1: the page's editor, libs/text/ui/comments.ts). */
  comments?: boolean;
};

/** A socket call that may find it closed already: nothing to do then. */
const quietly = (f: () => void) => void Result.try(f);

export interface TabSocket {
  send(message: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}


export class Tabs<S extends TabSocket> {
  /** The sockets joined to the open document, by id: what to do with their messages, and their going. */
  private joined = new Map<string, { receive: (data: Uint8Array) => boolean; leave: () => void }>();

  constructor(private o: {
    document: () => Document;
    /** Every socket the document has (a Durable Object's, asleep or not). */
    sockets: () => S[];
    /** What a socket is (its attachment); null for one that isn't a tab. */
    tabOf: (socket: S) => Tab | null;
    /** Keeps what a socket is with it. */
    keep: (socket: S, tab: Tab) => void;
  }) {}

  /** A new socket, or one waiting, joins the open document; false if it holds another epoch's history (it's refused). */
  join(socket: S, opened: Opened, tab = this.o.tabOf(socket)): boolean {
    if (!tab || this.joined.has(tab.id)) return true;
    const send = (m: string | Uint8Array) => quietly(() => socket.send(m));
    const joined = this.o.document().joinRoom(opened, { epoch: tab.epoch, readOnly: tab.readOnly, send, events: tab.events ? tab.person : null, watch: tab.watch });
    if (!joined) return false;
    if (tab.watch) { this.joined.set(tab.id, { receive: joined.receive, leave: joined.left }); return true; }
    // From now on it holds this history: after a sleep, it may only join this epoch again.
    if (tab.epoch != opened.room.epoch) this.o.keep(socket, { ...tab, epoch: opened.room.epoch });
    this.joined.set(tab.id, { receive: joined.receive, leave: joined.left });
    return true;
  }

  /**
   * A viewer's page (a watcher) connects. On an open document it joins as any tab does. A closed document stays closed,
   * with no room loaded for someone who only reads: the page hears the version kept with the files, and joins when
   * the document opens (attachAll). `accept` makes the socket, once there is a document; null: there's none.
   */
  watch(tab: Tab, accept: () => S): Effect.Effect<S | null, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const document = self.o.document();
      if (!document.isOpen()) {
        const ver = yield* document.viewed();
        if (ver == null) return null;
        // (Still closed: with no version kept, working it out opened the document.)
        if (!document.isOpen()) {
          const socket = accept();
          quietly(() => socket.send(JSON.stringify({ type: "view", ver })));
          return socket;
        }
      }
      const opened = yield* document.reopen();
      if (!opened) return null;
      const socket = accept();
      self.join(socket, opened, tab);
      return socket;
    });
  }

  /** The document opened (again): every socket joins it; one holding another history is closed (the tab reloads). */
  attachAll(opened: Opened): void {
    for (const socket of this.o.sockets()) {
      if (!this.join(socket, opened)) quietly(() => socket.close(4409, "stale epoch"));
    }
  }

  /** The document closed: the sockets wait for it to open again. */
  detachAll(): void {
    this.joined.clear();
  }

  /** A message from a tab: binary, the room's; text, only PING (where nothing answered it for us). */
  message(socket: S, data: Uint8Array | string): Effect.Effect<void, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const tab = self.o.tabOf(socket);
      if (!tab) return;
      if (typeof data == "string") {
        if (data == PING) quietly(() => socket.send(PONG));
        return;
      }
      // A watcher only listens.
      if (tab.watch) return;
      const document = self.o.document();
      let joined = self.joined.get(tab.id);
      if (!joined) {
        // Presence while the document is closed: to the other tabs, and nothing opens. Bytes that are no presence
        // close their socket, as the open room does, and reach no other tab.
        if (isAwareness(data) && !document.isOpen())
          return readsAsAwareness(data) ? self.relay(socket, tab.id, data) : quietly(() => socket.close(4400, "malformed message"));
        const opened = yield* document.reopen();
        if (!opened) return quietly(() => socket.close(4404, "document deleted"));
        // Joined as it opened (attachAll); one refused there is closed.
        joined = self.joined.get(tab.id);
        if (!joined && !self.join(socket, opened)) return quietly(() => socket.close(4409, "stale epoch"));
        joined = self.joined.get(tab.id);
      }
      if (!joined) return;
      if (!joined.receive(data)) return quietly(() => socket.close(4400, "malformed message"));
      if (!isAwareness(data)) document.activity();
    });
  }

  /** A socket closed. */
  closed(socket: S): void {
    const tab = this.o.tabOf(socket);
    if (!tab) return;
    const joined = this.joined.get(tab.id);
    this.joined.delete(tab.id);
    joined?.leave();
  }

  /**
   * The document's permissions changed: a tab whose person may no longer open it is closed (4403: the page opens again,
   * and says so); one whose person may edit now, or no longer, is closed to join again as they may now (4408: the tab
   * comes back by itself); every other tab hears it ({ type: "access" }).
   */
  async permissionsChanged(roleOf: (who: Asker) => Promise<Role | null>): Promise<void> {
    for (const socket of this.o.sockets()) {
      const tab = this.o.tabOf(socket);
      if (!tab?.who) continue;
      const role = await roleOf(tab.who);
      const edits = role == "owner" || role == "editor";
      if (!role) quietly(() => socket.close(4403, "not shared"));
      else if (!tab.watch && edits == tab.readOnly) quietly(() => socket.close(4408, "role changed"));
    }
    this.notify({ type: "access" });
  }

  /** A message for every tab (the homepage's deploy status): through the document if it's open, else to the tabs that hear events. */
  notify(msg: unknown): void {
    const document = this.o.document();
    if (document.isOpen()) return document.notify(msg);
    for (const socket of this.o.sockets()) {
      if (this.o.tabOf(socket)?.events) quietly(() => socket.send(JSON.stringify(msg)));
    }
  }

  /** The document's comments changed: the tabs that hear it read them again. Opens nothing. */
  commentsChanged(): void {
    for (const socket of this.o.sockets())
      if (this.o.tabOf(socket)?.comments) quietly(() => socket.send(JSON.stringify({ type: "comments" })));
  }

  private relay(from: S, id: string, data: Uint8Array): void {
    for (const socket of this.o.sockets()) {
      if (socket === from) continue;
      const tab = this.o.tabOf(socket);
      if (tab && tab.id != id) quietly(() => socket.send(data));
    }
  }
}
