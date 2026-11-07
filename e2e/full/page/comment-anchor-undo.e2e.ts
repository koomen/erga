// A comment's anchor (libs/text/api/anchors.ts) through a delete and an undo, with real keys in the editor. The
// anchor is taken in another replica of the room, as the server takes it. The editor's undo is CodeMirror's history:
// it puts the word back as new characters, which the old positions don't name. So the positions give an empty range,
// and the quote finds the word again.
import * as Y from "yjs";
import { files } from "../../../document/content";
import { expect, servers, test, until } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";
import { Participant } from "../suite/client";
import { roomOf } from "../versions/versions";
import { anchorFromJSON, anchorOf, anchorToJSON, resolveAnchor } from "../../../libs/text/api/anchors";

await servers.main();

test("Undo of a deleted word: the old positions are empty, and the quote finds the word again", async ({ tab }) => {
  const server = await servers.main();
  const ed = await openEditor(tab, server, "empty");
  await ed.clickEnd("p");
  await ed.idle();
  await ed.type("We go to Lisbon now");
  await ed.press("ArrowLeft");
  await ed.press("ArrowLeft");
  await ed.press("ArrowLeft");
  await ed.press("ArrowLeft");
  for (let i = 0; i < 6; i++) await ed.press("Shift+ArrowLeft");
  await ed.shows(`
    We go to [Lisbon] now
  `);

  const id = (await ed.eval<string>(`document.querySelector('meta[name="erga-base"]').content`)).replace(/^\/d\//, "");
  const room = await Participant.join(roomOf(server, id), "tester");
  try {
    const text = () => files(room.ydoc).get("index.html")!;
    await until(() => text().toString().includes("Lisbon now"), 5000, "the room has the typed text");
    const at = text().toString().indexOf("Lisbon");
    // Stored as the table stores it, and read back.
    const anchor = anchorFromJSON(anchorToJSON(anchorOf(text(), at, at + 6)!));
    expect(anchor.quote).toBe("Lisbon");

    await ed.press("Backspace");
    await ed.shows(`
      We go to | now
    `);
    await until(() => !text().toString().includes("Lisbon"), 5000, "the room has the delete");
    expect(resolveAnchor(text(), anchor)).toEqual({ kind: "deleted" });

    await ed.press("ControlOrMeta+z");
    await ed.shows(`
      We go to [Lisbon] now
    `);
    await until(() => text().toString().includes("Lisbon now"), 5000, "the room has the undo");
    // The finding: the old positions name the deleted characters, not the new ones.
    const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(anchor.start), room.ydoc)!.index;
    const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(anchor.end), room.ydoc)!.index;
    expect(end - start).toBe(0);
    // The quote finds the word again, with new positions to store.
    const found = resolveAnchor(text(), anchor);
    expect(found.kind).toBe("found");
    if (found.kind != "found") return;
    expect(text().toString().slice(found.from, found.to)).toBe("Lisbon");
    expect(found.anchor).not.toBeNull();
    expect(resolveAnchor(text(), found.anchor!)).toEqual({ kind: "found", from: found.from, to: found.to, anchor: null });
  } finally {
    room.destroy();
  }
});
