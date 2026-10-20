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

import type { Document, Opened, Person } from "./document.ts";
import { isAwareness } from "./room.ts";
import { PING, PONG } from "../shared/room-socket.ts";

/**
 * What a socket is, kept with it: read-only or not; `epoch`, the history the tab holds, once it has one; `events`,
 * whether it hears its person's events (and the document's details as it joins: Document.joinRoom).
 */
export type Tab = { id: string; readOnly: boolean; epoch: string | null; person: Person; events: boolean };

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
    const send = (m: string | Uint8Array) => { try { socket.send(m); } catch { /* already closed */ } };
    const joined = this.o.document().joinRoom(opened, { epoch: tab.epoch, readOnly: tab.readOnly, send, events: tab.events ? tab.person : null });
    if (!joined) return false;
    // From now on it holds this history: after a sleep, it may only join this epoch again.
    if (tab.epoch != opened.room.epoch) this.o.keep(socket, { ...tab, epoch: opened.room.epoch });
    this.joined.set(tab.id, { receive: joined.receive, leave: joined.left });
    return true;
  }

  /** The document opened (again): every socket joins it; one holding another history is closed (the tab reloads). */
  attachAll(opened: Opened): void {
    for (const socket of this.o.sockets()) {
      if (!this.join(socket, opened)) { try { socket.close(4409, "stale epoch"); } catch { /* gone */ } }
    }
  }

  /** The document closed: the sockets wait for it to open again. */
  detachAll(): void {
    this.joined.clear();
  }

  /** A message from a tab: binary, the room's; text, only PING (where nothing answered it for us). */
  async message(socket: S, data: Uint8Array | string): Promise<void> {
    const tab = this.o.tabOf(socket);
    if (!tab) return;
    if (typeof data == "string") { if (data == PING) { try { socket.send(PONG); } catch { /* gone */ } } return; }
    const document = this.o.document();
    let joined = this.joined.get(tab.id);
    if (!joined) {
      // Presence while the document is closed: to the other tabs, and nothing opens.
      if (isAwareness(data) && !document.isOpen()) return this.relay(socket, tab.id, data);
      const opened = await document.reopen();
      if (!opened) { try { socket.close(4404, "document deleted"); } catch { /* gone */ } return; }
      // Joined as it opened (attachAll); one refused there is closed.
      joined = this.joined.get(tab.id);
      if (!joined && !this.join(socket, opened)) { try { socket.close(4409, "stale epoch"); } catch { /* gone */ } return; }
      joined = this.joined.get(tab.id);
    }
    if (!joined) return;
    if (!joined.receive(data)) { try { socket.close(4400, "malformed message"); } catch { /* gone */ } return; }
    if (!isAwareness(data)) document.activity();
  }

  /** A socket closed. */
  closed(socket: S): void {
    const tab = this.o.tabOf(socket);
    if (!tab) return;
    const joined = this.joined.get(tab.id);
    this.joined.delete(tab.id);
    joined?.leave();
  }

  /** A message for every tab (the homepage's deploy status): through the document if it's open, else to the tabs that hear events. */
  notify(msg: unknown): void {
    const document = this.o.document();
    if (document.isOpen()) return document.notify(msg);
    for (const socket of this.o.sockets()) {
      if (this.o.tabOf(socket)?.events) { try { socket.send(JSON.stringify(msg)); } catch { /* gone */ } }
    }
  }

  private relay(from: S, id: string, data: Uint8Array): void {
    for (const socket of this.o.sockets()) {
      if (socket === from) continue;
      const tab = this.o.tabOf(socket);
      if (tab && tab.id != id) { try { socket.send(data); } catch { /* gone */ } }
    }
  }
}
