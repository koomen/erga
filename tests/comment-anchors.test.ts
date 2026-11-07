// A comment's anchor (libs/text/api/anchors.ts) through the edits a document gets: typing, an agent's write (merged
// word by word, as agents/document/workspace.ts does), a delete, an undo (Yjs's own, and the editor's, which puts the
// text back as new characters), and a rename (new characters at another path).
import { expect, test } from "bun:test";
import * as Y from "yjs";
import { applyChanges, files } from "../document/content";
import { changesBetween } from "../document/merge";
import { anchorFromJSON, anchorOf, anchorToJSON, resolveAnchor, type Anchor } from "../libs/text/api/anchors";

const QUOTE = "Lisbon in May";
const TEXT = "<p>We go to Lisbon in May, before the crowds.</p>";

/** A document with one page, and an anchor on QUOTE. */
function setup(text = TEXT) {
  const doc = new Y.Doc();
  const t = new Y.Text();
  doc.transact(() => {
    t.insert(0, text);
    files(doc).set("index.html", t);
  });
  const at = text.indexOf(QUOTE);
  return { doc, t, anchor: anchorOf(t, at, at + QUOTE.length)! };
}

/** The anchor's text now, and whether it gave a new anchor to keep; "deleted" if it's gone. */
function shown(t: Y.Text, a: Anchor): { text: string; renewed: boolean } | "deleted" {
  const r = resolveAnchor(t, a);
  return r.kind == "deleted" ? "deleted" : { text: t.toString().slice(r.from, r.to), renewed: r.anchor != null };
}

/** An agent's write of the whole file: the changes between the texts, word by word. */
const agentWrites = (t: Y.Text, content: string) => t.doc!.transact(() => applyChanges(t, changesBetween(t.toString(), content)));

test("an anchor takes the selected text, and goes to JSON and back", () => {
  const { t, anchor } = setup();
  expect(anchor.quote).toBe(QUOTE);
  const back = anchorFromJSON(anchorToJSON(anchor));
  expect(typeof anchorToJSON(anchor).start).toBe("string");
  expect(shown(t, back)).toEqual({ text: QUOTE, renewed: false });
  expect(anchorOf(t, 5, 5)).toBeNull();
});

test("typing before and just after the anchor moves it, and stays outside it", () => {
  const { t, anchor } = setup();
  t.insert(0, "<h1>Trip</h1>");
  const end = t.toString().indexOf(QUOTE) + QUOTE.length;
  t.insert(end, " or June");
  t.insert(end - QUOTE.length, "to ");
  expect(t.toString()).toContain("to to Lisbon in May or June");
  expect(shown(t, anchor)).toEqual({ text: QUOTE, renewed: false });
});

test("an edit inside the anchor keeps it, and the quote becomes the text now", () => {
  const { t, anchor } = setup();
  t.insert(t.toString().indexOf("May"), "early ");
  const r = resolveAnchor(t, anchor);
  expect(r).toMatchObject({ kind: "found", anchor: { quote: "Lisbon in early May" } });
  // The new anchor keeps the positions: it resolves the same, with nothing more to change.
  if (r.kind == "found") expect(shown(t, r.anchor!)).toEqual({ text: "Lisbon in early May", renewed: false });
});

test("an agent's write that changes a word inside and the text around keeps the anchor on its words", () => {
  const { t, anchor } = setup();
  agentWrites(t, "<h1>Trip</h1>\n<p>We fly to Lisbon by May, before the summer crowds.</p>");
  expect(shown(t, anchor)).toEqual({ text: "Lisbon by May", renewed: true });
});

test("an agent's write that replaces the anchor's last word leaves the anchor on the words before it", () => {
  // The last character is deleted, and the new word comes after it: outside, as typing just after the anchor is.
  const { t, anchor } = setup();
  agentWrites(t, "<p>We go to Lisbon in June, before the crowds.</p>");
  expect(shown(t, anchor)).toEqual({ text: "Lisbon in ", renewed: false });
});

test("an agent's write that leaves the anchored words keeps the anchor as it is", () => {
  const { t, anchor } = setup();
  agentWrites(t, "<p>We go to Lisbon in May! Before the crowds.</p>");
  expect(shown(t, anchor)).toEqual({ text: QUOTE, renewed: false });
});

test("a delete of the anchored text gives deleted, even with the same words elsewhere", () => {
  const { t, anchor } = setup("<p>We go to Lisbon in May, before the crowds.</p><p>Lisbon in May is warm.</p>");
  t.delete(t.toString().indexOf(QUOTE), QUOTE.length);
  expect(shown(t, anchor)).toBe("deleted");
});

test("a delete of part of the anchor keeps the rest, and the quote", () => {
  const { t, anchor } = setup();
  t.delete(t.toString().indexOf(" in May"), " in May".length);
  expect(shown(t, anchor)).toEqual({ text: "Lisbon", renewed: false });
});

test("the editor's undo puts the text back as new characters: the quote finds it at the old place", () => {
  const { t, anchor } = setup();
  const at = t.toString().indexOf(QUOTE);
  t.delete(at, QUOTE.length);
  expect(shown(t, anchor)).toBe("deleted");
  t.insert(at, QUOTE);
  const r = resolveAnchor(t, anchor);
  expect(r).toMatchObject({ kind: "found", from: at, to: at + QUOTE.length });
  // Its new positions name the new characters.
  if (r.kind == "found") expect(shown(t, r.anchor!)).toEqual({ text: QUOTE, renewed: false });
});

test("the editor's undo of a delete of part of the anchor gives the whole again", () => {
  const { t, anchor } = setup();
  const at = t.toString().indexOf(" in May");
  t.delete(at, " in May".length);
  t.insert(at, " in May");
  expect(shown(t, anchor)).toEqual({ text: QUOTE, renewed: true });
});

test("Y.UndoManager's undo: its link to the text it put back stays in its own replica, so the quote finds the text", () => {
  const { doc, t, anchor } = setup();
  const undo = new Y.UndoManager(t);
  t.delete(t.toString().indexOf(QUOTE), QUOTE.length);
  undo.undo();
  // The server's replica, which never undid.
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
  const st = files(server).get("index.html")!;
  expect(Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(anchor.start), server, true)!.index).toBe(
    Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(anchor.end), server, true)!.index
  );
  // Both replicas decide the same.
  expect(shown(st, anchor)).toEqual({ text: QUOTE, renewed: true });
  expect(shown(t, anchor)).toEqual({ text: QUOTE, renewed: true });
});

test("a rename loses the positions: the quote finds the text at its new path", () => {
  const { doc, t, anchor } = setup("<p>Lisbon is far.</p><p>We go to Lisbon in May.</p><p>Lisbon in May is warm.</p>");
  // As the room moves a file (document/room.ts, move): its text at the new path, the old one removed.
  const moved = new Y.Text();
  doc.transact(() => {
    moved.insert(0, t.toString());
    files(doc).set("trip.html", moved);
    files(doc).delete("index.html");
  });
  const r = resolveAnchor(moved, anchor);
  expect(r).toMatchObject({ kind: "found", from: moved.toString().indexOf(QUOTE) });
  if (r.kind == "found") expect(shown(moved, r.anchor!)).toEqual({ text: QUOTE, renewed: false });
});

test("lost positions and no quote in the text give deleted", () => {
  const { anchor } = setup();
  const other = new Y.Doc();
  const t = new Y.Text();
  files(other).set("index.html", t);
  t.insert(0, "<p>A new room, other text.</p>");
  expect(shown(t, anchor)).toBe("deleted");
});
