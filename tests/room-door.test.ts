// One door for each change of the room's doc on the server: room.as(participant, change) (document/room/room.ts). It
// checks the participant's right and the lock, and its origin names the change. A transaction that goes around it has
// no name in the history, and no check. So no file of the document but the room starts a transaction on a Y.Doc.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");
/** The room itself; and the shared doc's shape, whose `introduce` is the browser's (a tab writes its own name tag). */
const MAY = new Set(["room.ts", "content.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : name.endsWith(".ts") ? [p] : [];
  });
}

test("only the room starts a transaction on the shared doc: every other change goes through its door", () => {
  const around = sources(join(ROOT, "document"))
    .filter((f) => !MAY.has(f.split("/").pop()!) && /\.transact\(/.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f));
  expect(around).toEqual([]);
});

test("one record of who is in a document: the participants' one map, and no list in the room", () => {
  /** The maps and sets that a class of document/room keeps. */
  const kept = (file: string) =>
    [
      ...readFileSync(join(ROOT, "document/room", file), "utf8").matchAll(
        /^ {2}(?:private |readonly )*(\w+)[^=\n]*= new (?:Map|Set|WeakMap)\b/gm
      ),
    ].map((m) => m[1]);
  expect(kept("participants.ts")).toEqual(["all"]);
  // The room keeps its files and who hears of its tree: it asks the participants to send its messages (`tell`).
  expect(kept("room.ts")).toEqual(["stored", "filed", "treeListeners"]);
});
