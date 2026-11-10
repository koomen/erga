// Someone in a document's room with no browser: a Yjs replica joined over a real WebSocket, with the sync messages that
// a tab sends. The agent's journey uses it to see what the other people get of an agent's edit: the text, and who made
// each change.
import * as Y from "yjs";
import { authorOf, colorFor, files, introduce, stamp, type Author } from "../../document/content";
import { Decoder, Encoder, readSyncMessage, SYNC_STEP2, writeSyncStep1, writeUpdate } from "../../shared/yjs-protocol";
import { until } from "../helpers/fixtures";

const MSG_SYNC = 0;

/** A change to the page's text by someone else, as this replica got it: who made it, and the text that it put in. */
export interface Seen {
  author: string | null;
  kind: string | null;
  inserted: string;
}

/** Joins the room of the document at `address` as `name` (local development's ?user=), and waits for the first sync. */
export async function joinRoom(address: string, name: string, path = "index.html") {
  const ydoc = new Y.Doc();
  const me: Author = { user: name.toLowerCase(), name, color: colorFor(name.toLowerCase()), kind: "person" };
  const local = {};
  const seen: Seen[] = [];
  let synced = false;
  const ws = new WebSocket(`${address.replace(/^http/, "ws")}/api/room/doc?user=${encodeURIComponent(name)}`);
  ws.binaryType = "arraybuffer";
  const send = (bytes: Uint8Array<ArrayBuffer>) => {
    if (ws.readyState == WebSocket.OPEN) ws.send(bytes);
  };
  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === ws) return;
    const e = new Encoder();
    e.writeUint(MSG_SYNC);
    writeUpdate(e, update);
    send(e.toBytes());
  });
  ws.onopen = () => {
    const e = new Encoder();
    e.writeUint(MSG_SYNC);
    writeSyncStep1(e, ydoc);
    send(e.toBytes());
  };
  ws.onmessage = (m) => {
    if (typeof m.data == "string") return;
    const d = new Decoder(new Uint8Array(m.data as ArrayBuffer));
    if (d.readUint() != MSG_SYNC) return;
    const reply = new Encoder();
    reply.writeUint(MSG_SYNC);
    if (readSyncMessage(d, reply, ydoc, ws) == SYNC_STEP2) synced = true;
    if (reply.length > 1) send(reply.toBytes());
  };
  await until(() => synced, 10_000, `${name} syncs with the room`);
  introduce(ydoc, me);
  const text = () => files(ydoc).get(path)!;
  text().observe((ev, tr) => {
    if (tr.origin === local) return;
    const a = authorOf(ydoc, tr);
    seen.push({
      author: a?.name ?? null,
      kind: a?.kind ?? null,
      inserted: ev.delta.map((op) => (typeof op.insert == "string" ? op.insert : "")).join(""),
    });
  });
  return {
    seen,
    /** The page's text, as this replica has it. */
    str: () => text().toString(),
    /** Types `s` after the first `anchor`, as this person. */
    insertAfter(anchor: string, s: string) {
      const i = text().toString().indexOf(anchor);
      if (i < 0) throw new Error(`${name}: "${anchor}" isn't in ${path}`);
      ydoc.transact(() => {
        const before = Y.getState(ydoc.store, ydoc.clientID);
        text().insert(i + anchor.length, s);
        if (Y.getState(ydoc.store, ydoc.clientID) == before) stamp(ydoc, me);
      }, local);
    },
    leave() {
      ws.close();
      ydoc.destroy();
    },
  };
}
export type Joined = Awaited<ReturnType<typeof joinRoom>>;

/**
 * The document's events for `name`, as a tab of theirs gets them (the text frames of /api/room?events=1): all of them
 * so far as one text, a line each.
 */
export async function eventsOf(address: string, name: string) {
  let text = "";
  const ws = new WebSocket(`${address.replace(/^http/, "ws")}/api/room?events=1&user=${encodeURIComponent(name)}`);
  ws.onmessage = (e) => {
    if (typeof e.data == "string") text += `${e.data}\n`;
  };
  await until(() => ws.readyState == WebSocket.OPEN, 5000, `${name}'s event channel opens`);
  return { text: () => text, close: () => ws.close() };
}
