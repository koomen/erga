// A doc joined to a room in process, as a tab joins it over its socket: the same sync and awareness messages,
// delivered on the microtask queue (in order, never re-entrantly). For the tests of the room without a browser.

import * as Y from "yjs";
import type { Connection, Participant, Room } from "../../document/room/room";
import {
  Awareness,
  Decoder,
  Encoder,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  readSyncMessage,
  removeAwarenessStates,
  writeSyncStep1,
  writeUpdate,
  type AwarenessChange,
} from "../../shared/yjs-protocol";

const MSG_SYNC = 0,
  MSG_AWARENESS = 1;

const message = (type: number, write: (e: Encoder) => void) => {
  const e = new Encoder();
  e.writeUint(type);
  write(e);
  return e.toBytes();
};

/**
 * A tab's connection to the room, which hears the room's messages as a participant's tabs do. (The room keeps no list
 * of them: participants.ts does, and a test without it takes the room's messages here.)
 */
export function connect(room: Room, by: Participant, send: (m: Uint8Array) => void): Connection {
  const conn = room.connect(by, send)!;
  const next = room.tell;
  let open = true;
  room.tell = (m, except) => {
    next(m, except);
    if (open && except !== conn) send(m);
  };
  return {
    ...conn,
    close: () => {
      open = false;
      conn.close();
    },
  };
}

/** Joins `doc` to the room as a tab of `by`. Returns how it leaves. */
export function joinLocal(room: Room, doc: Y.Doc, awareness: Awareness, by: Participant = participant("tab")): { leave: () => void } {
  let open = true;
  const conn = connect(room, by, (m) =>
    queueMicrotask(() => {
      if (open) receive(m);
    })
  );
  const toRoom = (m: Uint8Array) =>
    queueMicrotask(() => {
      if (open) conn.receive(m);
    });
  const presence = (clients: number[]) => message(MSG_AWARENESS, (e) => e.writeBytes(encodeAwarenessUpdate(awareness, clients)));
  function receive(m: Uint8Array) {
    const decoder = new Decoder(m);
    const type = decoder.readUint();
    if (type == MSG_SYNC) {
      const reply = new Encoder();
      reply.writeUint(MSG_SYNC);
      readSyncMessage(decoder, reply, doc, conn);
      if (reply.length > 1) toRoom(reply.toBytes());
    } else if (type == MSG_AWARENESS) applyAwarenessUpdate(awareness, decoder.readBytes(), conn);
  }
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== conn) toRoom(message(MSG_SYNC, (e) => writeUpdate(e, update)));
  };
  const onAwareness = ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
    if (origin !== conn) toRoom(presence([...added, ...updated, ...removed]));
  };
  doc.on("update", onUpdate);
  awareness.on("update", onAwareness);
  toRoom(message(MSG_SYNC, (e) => writeSyncStep1(e, doc)));
  if (awareness.getLocalState()) toRoom(presence([doc.clientID]));
  return {
    leave: () => {
      removeAwarenessStates(awareness, [doc.clientID], "leave");
      queueMicrotask(() => {
        open = false;
        conn.close();
      });
      doc.off("update", onUpdate);
      awareness.off("update", onAwareness);
    },
  };
}

/** A participant for a test: a user in person who may edit, or one via `via`. */
export const participant = (login: string, via?: string): Participant => ({
  act: via ? { login, via } : { login },
  author: {
    user: login,
    name: via ? `${login}, via ${via}` : login,
    color: "#2f6fec",
    kind: via ? "agent" : "person",
    ...(via ? { via } : {}),
  },
  canEdit: () => true,
});
