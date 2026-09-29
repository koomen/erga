import { test, expect } from "bun:test";
import { ChangeSet } from "../src/changes";
import { Doc } from "../src/text";
import { EditorState } from "../src/state";
import { EditorSelection } from "../src/selection";
import { undo, redo } from "../src/history";
import { Vendor } from "./reference";

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const int = (n: number) => Math.floor(rand() * n);
const words = ["a", "bc", "\n", "xyz", "", "é", "\n\n", "hello "];

function randomSpecs(len: number) {
  const specs: { from: number; to: number; insert: string }[] = [];
  let pos = 0;
  for (let i = int(4); i >= 0 && pos <= len; i--) {
    const from = pos + int(Math.max(1, len - pos + 1));
    if (from > len) break;
    const to = from + int(Math.min(4, len - from + 1));
    specs.push({ from, to: Math.min(to, len), insert: words[int(words.length)] });
    pos = Math.min(to, len) + 1;
  }
  return specs;
}
const cmJSON = (cs: any) => JSON.stringify(cs.toJSON());
const ourJSON = (cs: ChangeSet) => {
  const parts: unknown[] = [];
  for (let i = 0; i < cs.sections.length; i += 2) {
    const len = cs.sections[i], ins = cs.sections[i + 1];
    parts.push(ins < 0 ? len : ins == 0 ? [len] : [len, ...cs.inserted[i >> 1].split("\n")]);
  }
  return JSON.stringify(parts);
};

test("change sets match CodeMirror's (apply, compose, map, invert, mapPos)", () => {
  for (let round = 0; round < 3000; round++) {
    const text = Array.from({ length: int(6) }, () => words[int(words.length)]).join("");
    const cmState = Vendor.EditorState.create({ doc: text });
    const doc = Doc.of(text);
    const sa = randomSpecs(text.length), sb = randomSpecs(text.length);
    const a = ChangeSet.of(sa, text.length), b = ChangeSet.of(sb, text.length);
    const ca = cmState.changes(sa), cb = cmState.changes(sb);
    expect(ourJSON(a)).toBe(cmJSON(ca));
    expect(a.apply(doc).toString()).toBe(ca.apply(cmState.doc).toString());
    expect(ourJSON(b.map(a))).toBe(cmJSON(cb.map(ca)));
    expect(ourJSON(b.map(a, true))).toBe(cmJSON(cb.map(ca, true)));
    expect(ourJSON(a.compose(b.map(a)))).toBe(cmJSON(ca.compose(cb.map(ca))));
    expect(ourJSON(a.invert(doc))).toBe(cmJSON(ca.invert(cmState.doc)));
    for (let p = 0; p <= text.length; p++) for (const assoc of [-1, 1]) expect(a.mapPos(p, assoc)).toBe(ca.mapPos(p, assoc));
  }
});

test("history matches CodeMirror's grouping and undo/redo", () => {
  const { EditorState: CMState, EditorSelection: CMSel } = Vendor;
  const cmHistory = Vendor.history();
  for (let round = 0; round < 300; round++) {
    let ours = EditorState.create({ doc: "start" });
    let theirs = CMState.create({ doc: "start", extensions: [cmHistory] });
    const t0 = Date.now();
    for (let step = 0; step < 12; step++) {
      const kind = int(6);
      const len = ours.doc.length;
      if (kind < 3) {
        const pos = int(len + 1), ev = ["input.type", "delete.backward", "input", "input.paste"][int(4)];
        const del = ev.startsWith("delete") ? Math.min(pos, 1) : 0;
        const spec = { changes: { from: pos - del, to: pos, insert: del ? "" : words[int(words.length)] }, userEvent: ev };
        ours = ours.update(spec).state;
        theirs = theirs.update(spec).state;
      } else if (kind == 3) {
        const pos = int(len + 1);
        ours = ours.update({ selection: EditorSelection.single(pos), userEvent: "select" }).state;
        theirs = theirs.update({ selection: CMSel.single(pos), userEvent: "select" }).state;
      } else {
        const fn = kind == 4 ? undo : redo;
        const cmFn = kind == 4 ? Vendor.historyKeymap[0].run : null;
        let ourTr: any = null;
        fn({ state: ours, dispatch: (tr) => (ourTr = tr) });
        if (ourTr) ours = ourTr.state;
        if (kind == 4) cmFn({ state: theirs, dispatch: (tr: any) => (theirs = tr.state) });
        else Vendor.historyKeymap.find((k: any) => k.mac == "Mod-Shift-z").run({ state: theirs, dispatch: (tr: any) => (theirs = tr.state) });
      }
      expect(ours.doc.toString()).toBe(theirs.doc.toString());
      expect([ours.selection.main.anchor, ours.selection.main.head]).toEqual([theirs.selection.main.anchor, theirs.selection.main.head]);
    }
    void t0;
  }
});
