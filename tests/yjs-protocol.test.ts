// shared/yjs-protocol.ts: the wire format of y-protocols and lib0, byte for byte (checked against them before they went).

import { expect, test } from "bun:test";
import * as Y from "yjs";
import { applyAwarenessUpdate, Awareness, Decoder, Encoder, encodeAwarenessUpdate, removeAwarenessStates } from "../shared/yjs-protocol";

test("numbers are varints, strings and bytes come after their length", () => {
  const e = new Encoder();
  e.writeUint(300);
  e.writeUint(2 ** 32 - 1);
  e.writeString("é");
  e.writeBytes(new Uint8Array([7]));
  expect([...e.toBytes()]).toEqual([172, 2, 255, 255, 255, 255, 15, 2, 195, 169, 1, 7]);
  const d = new Decoder(e.toBytes());
  expect([d.peekUint(), d.readUint(), d.readUint(), d.readString(), [...d.readBytes()]]).toEqual([300, 300, 2 ** 32 - 1, "é", [7]]);
  expect(() => d.readUint()).toThrow("Unexpected end of array");
  expect(() => new Decoder(new Uint8Array([5, 1])).readBytes()).toThrow("Unexpected end of array");
});

test("awareness: a newer state wins, and a client that leaves is gone", () => {
  const a = new Awareness(new Y.Doc()),
    b = new Awareness(new Y.Doc());
  const seen: unknown[] = [];
  b.on("change", (change) => seen.push(change));
  a.setLocalState({ user: "Ada" });
  applyAwarenessUpdate(b, encodeAwarenessUpdate(a, [a.clientID]), "net");
  // The same state again: an update, but no change.
  applyAwarenessUpdate(b, encodeAwarenessUpdate(a, [a.clientID]), "net");
  a.setLocalState({ user: "Ada" });
  applyAwarenessUpdate(b, encodeAwarenessUpdate(a, [a.clientID]), "net");
  expect(b.getStates().get(a.clientID)).toEqual({ user: "Ada" });
  removeAwarenessStates(a, [a.clientID], "left");
  applyAwarenessUpdate(b, encodeAwarenessUpdate(a, [a.clientID]), "net");
  expect(b.getStates().has(a.clientID)).toBe(false);
  expect(seen).toEqual([
    { added: [a.clientID], updated: [], removed: [] },
    { added: [], updated: [], removed: [a.clientID] },
  ]);
  a.destroy();
  b.destroy();
});
