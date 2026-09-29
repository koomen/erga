// Input paths that only a real OS/IME produces and that CodeMirror handles by
// reading DOM mutations (so they can't be driven identically in both). These
// check the new editor's beforeinput handling directly.
//   bun tests/input.ts
import { Browser, urlFor } from "./cdp";

const browser = await Browser.launch();
let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) == JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};
// Fire a beforeinput whose target range covers [from, to) of the document.
const fire = (inputType: string, from: number, to: number, data: string | null) => `(() => {
  const v = scratchEditor.view, a = v.domAtPos(${from}, 1), b = v.domAtPos(${to}, -1);
  const r = new StaticRange({ startContainer: a.node, startOffset: a.offset, endContainer: b.node, endOffset: b.offset });
  const init = { inputType: ${JSON.stringify(inputType)}, data: ${JSON.stringify(data)}, targetRanges: [r], bubbles: true, cancelable: true };
  const e = new InputEvent("beforeinput", init);
  v.contentDOM.dispatchEvent(e);
  return { prevented: e.defaultPrevented, doc: v.state.doc.toString(), sel: [v.state.selection.main.anchor, v.state.selection.main.head] };
})()`;
try {
  const p = await browser.page();
  await p.open(urlFor("editor"), { doc: "I recieve teh mail" });
  await p.eval("scratchEditor.view.dispatch({ selection: { anchor: 18 } }); true");
  check("spellcheck replacement (insertReplacementText)", await p.eval(fire("insertReplacementText", 2, 9, "receive")), { prevented: true, doc: "I receive teh mail", sel: [9, 9] });
  check("autocorrect replacement elsewhere keeps working", await p.eval(fire("insertReplacementText", 10, 13, "the")), { prevented: true, doc: "I receive the mail", sel: [13, 13] });
  await p.eval("scratchEditor.view.dispatch({ selection: { anchor: 18 } }); true");
  check("press-and-hold accent replaces the previous character", await p.eval(fire("insertText", 17, 18, "ł")), { prevented: true, doc: "I receive the maił", sel: [18, 18] });
  const undo = await p.eval(`(() => { const e = new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true }); scratchEditor.view.contentDOM.dispatchEvent(e); return scratchEditor.view.state.doc.toString(); })()`);
  check("Edit menu undo (historyUndo)", undo, "I receive the mail");
  await p.eval("scratchEditor.view.dispatch({ selection: { anchor: 13 } }); true");
  check("word deletion from a target range", await p.eval(fire("deleteWordBackward", 10, 13, null)), { prevented: true, doc: "I receive  mail", sel: [10, 10] });
  check("rich-text formatting is refused", await p.eval(`(() => { const e = new InputEvent("beforeinput", { inputType: "formatBold", bubbles: true, cancelable: true }); scratchEditor.view.contentDOM.dispatchEvent(e); return [e.defaultPrevented, scratchEditor.view.state.doc.toString()]; })()`), [true, "I receive  mail"]);
  // Safety net: text the browser inserts without a cancellable beforeinput is read back.
  const readback = await p.eval(`new Promise((res) => { const v = scratchEditor.view; const t = v.lineDOM(1).firstChild; t.nodeValue = t.nodeValue + "!"; v.contentDOM.dispatchEvent(new InputEvent("input", { inputType: "insertText", bubbles: true })); setTimeout(() => res(v.state.doc.toString()), 20); })`);
  check("unexpected DOM edits are read back into the model", readback, "I receive  mail!");
  check("no page errors", p.errors, []);
} finally { browser.close(); }
process.exit(failed ? 1 : 0);
