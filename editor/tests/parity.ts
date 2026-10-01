// Parity suite: runs the same scripted interactions (real CDP input events)
// against the CodeMirror reference (wip/editor-cm) and the new editor
// (wip/editor), and compares the resulting document, selection and any extra
// observations each scenario records.
//
//   bun tests/parity.ts            # all scenarios
//   bun tests/parity.ts link fold  # scenarios whose name contains a filter

import { Browser, Page, MOD, pool, urlFor } from "./cdp";

const M = MOD.Meta; // the suite runs on macOS, where Mod is Cmd

type Obs = Record<string, unknown>;
interface Scenario {
  name: string;
  doc?: string;
  width?: number;
  run(p: Page, h: Helpers): Promise<Obs | void>;
}

class Helpers {
  constructor(readonly p: Page) {}
  doc() { return this.p.eval<string>("scratchEditor.view.state.doc.toString()"); }
  sel() { return this.p.eval<{ anchor: number; head: number; n: number }>("(() => { const s = scratchEditor.view.state.selection; return { anchor: s.main.anchor, head: s.main.head, n: s.ranges.length }; })()"); }
  /** Place the cursor with a direct selection set (setup only, not the behavior under test). */
  async setSel(anchor: number, head = anchor) {
    await this.p.eval(`scratchEditor.view.dispatch({ selection: { anchor: ${anchor}, head: ${head} } }); scratchEditor.view.focus(); true`);
    await Bun.sleep(30);
  }
  async find(needle: string, offset = 0) {
    const i = await this.p.eval<number>(`scratchEditor.view.state.doc.toString().indexOf(${JSON.stringify(needle)})`);
    if (i < 0) throw new Error("not found: " + needle);
    return i + offset;
  }
  async coords(pos: number, side = 1) {
    return this.p.eval<{ x: number; y: number }>(`(() => { const c = scratchEditor.view.coordsAtPos(${pos}, ${side}); return { x: c.left, y: (c.top + c.bottom) / 2 }; })()`);
  }
  /** Screen point in the middle of the character at `pos`. */
  async charPoint(pos: number) {
    const a = await this.coords(pos, 1), b = await this.coords(pos + 1, -1);
    return { x: Math.round((a.x + b.x) / 2), y: Math.round(a.y) };
  }
  lineText(needle: string) {
    return this.p.eval<string>(`[...document.querySelectorAll(".cm-line, .ed-content > .line")].map(l => l.innerText).find(t => t.includes(${JSON.stringify(needle)})) ?? null`);
  }
  bar() {
    return this.p.eval<Obs>(`({ hidden: document.getElementById("format-bar").hidden, bold: document.getElementById("fmt-bold").getAttribute("aria-pressed"), italic: document.getElementById("fmt-italic").getAttribute("aria-pressed"), link: document.getElementById("fmt-link").getAttribute("aria-pressed"), editing: !document.getElementById("format-link").hidden })`);
  }
  async keys(...ks: (string | [string, number])[]) {
    for (const k of ks) {
      if (typeof k == "string") await this.p.key(k);
      else await this.p.key(k[0], k[1]);
    }
    await Bun.sleep(30);
  }
  async paste(text: string) {
    await this.p.eval(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(text)}); const el = document.activeElement; el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    await Bun.sleep(50);
  }
  async copy(type: "copy" | "cut") {
    return this.p.eval<string>(`(() => { const dt = new DataTransfer(); document.activeElement.dispatchEvent(new ClipboardEvent(${JSON.stringify(type)}, { clipboardData: dt, bubbles: true, cancelable: true })); return dt.getData("text/plain"); })()`);
  }
  chromeHidden() { return this.p.eval<boolean>("document.body.classList.contains('chrome-hidden')"); }
}

const LIST = "- one\n- two\n\n1. first\n2. second\n\n> quoted\n\nplain";
const LONG = "This is a fairly long paragraph that should wrap across several visual lines in the editor column so that vertical motion and line-boundary motion have wrapped lines to work with, which is exactly what we want to test here today.\nShort line.\nAnother long line of text that wraps around the column at least once, maybe twice, depending on the width of the column in the page.";
const LINKS = "Before [label](https://example.com) after.\nNext line with [two](https://two.dev) links [here](https://x.y).";

const scenarios: Scenario[] = [
  // ------------------------------------------------ typing & history
  { name: "type at end of welcome", run: async (p, h) => { await p.type("Hello there."); await h.keys("Enter"); await p.type("More"); } },
  { name: "type a list and quote from scratch", doc: "", run: async (p, h) => { await p.type("# Title\n\n- first\nsecond\n\n\n1. one\ntwo\n\n> q\nmore\n\n\nend", 25); } },
  { name: "type replaces selection", doc: "abc def ghi", run: async (p, h) => { await h.setSel(4, 7); await p.type("XYZ"); } },
  { name: "undo groups adjacent typing", doc: "", run: async (p, h) => {
    await p.type("hello world", 20);
    await h.keys(["z", M]);
    const afterOne = await h.doc();
    await p.type("abc", 20);
    await Bun.sleep(700);
    await p.type("def", 20);
    await h.keys(["z", M]);
    const afterPause = await h.doc();
    await h.keys(["z", M, ], ["z", MOD.Meta | MOD.Shift]);
    return { afterOne, afterPause };
  } },
  { name: "undo breaks group on cursor move", doc: "xyz", run: async (p, h) => {
    await h.setSel(3);
    await p.type("abc", 20);
    await h.keys("ArrowLeft");
    await p.type("Q", 20);
    await h.keys(["z", M]);
    const one = await h.doc();
    await h.keys(["z", M]);
    return { one };
  } },
  { name: "redo after undo", doc: "one", run: async (p, h) => { await h.setSel(3); await p.type(" two", 10); await h.keys(["z", M], ["z", M | MOD.Shift]); } },
  { name: "backspace and delete", doc: "abcdef", run: async (p, h) => { await h.setSel(3); await h.keys("Backspace", "Delete", "Backspace"); } },
  { name: "delete by word and line", doc: "one two three four five", run: async (p, h) => {
    await h.setSel(13);
    await h.keys(["Backspace", MOD.Alt]);
    const w = await h.doc();
    await h.keys(["Delete", MOD.Alt]);
    const w2 = await h.doc();
    await h.keys(["Backspace", M]);
    return { w, w2 };
  } },
  { name: "backspace in indentation", doc: "      x", run: async (p, h) => { await h.setSel(6); await h.keys("Backspace"); const a = await h.doc(); await h.keys("Backspace"); return { a }; } },

  // ------------------------------------------------ lists & quotes
  { name: "enter continues bullet list", doc: LIST, run: async (p, h) => { await h.setSel(await h.find("two", 3)); await h.keys("Enter"); await p.type("three"); } },
  { name: "enter continues numbered list", doc: LIST, run: async (p, h) => { await h.setSel(await h.find("second", 6)); await h.keys("Enter"); await p.type("third"); } },
  { name: "enter in middle of numbered list renumbers", doc: LIST, run: async (p, h) => { await h.setSel(await h.find("first", 5)); await h.keys("Enter"); await p.type("new"); } },
  { name: "enter continues quote", doc: LIST, run: async (p, h) => { await h.setSel(await h.find("quoted", 6)); await h.keys("Enter"); await p.type("more"); } },
  { name: "enter on empty item ends list", doc: LIST, run: async (p, h) => { await h.setSel(await h.find("two", 3)); await h.keys("Enter", "Enter"); await p.type("after"); } },
  { name: "enter on empty quote line", doc: LIST, run: async (p, h) => { await h.setSel(await h.find("quoted", 6)); await h.keys("Enter", "Enter", "Enter"); await p.type("x"); } },
  { name: "backspace at item start removes markup", doc: LIST, run: async (p, h) => {
    await h.setSel(await h.find("two"));
    await h.keys("Backspace");
    const a = await h.doc();
    await h.keys("Backspace");
    const b = await h.doc();
    await h.keys("Backspace");
    return { a, b };
  } },
  { name: "backspace after quote mark", doc: LIST, run: async (p, h) => { await h.setSel(await h.find("quoted")); await h.keys("Backspace", "Backspace"); } },
  { name: "tab indents list item", doc: LIST, run: async (p, h) => {
    await h.setSel(await h.find("two", 1));
    await h.keys("Tab");
    const a = await h.doc();
    await h.keys(["Tab", MOD.Shift]);
    return { a };
  } },
  { name: "nested list enter", doc: "- a\n  - b", run: async (p, h) => { await h.setSel(9); await h.keys("Enter"); await p.type("c"); await h.keys("Enter", "Enter"); await p.type("d"); } },
  { name: "task list enter", doc: "- [x] done", run: async (p, h) => { await h.setSel(10); await h.keys("Enter"); await p.type("next"); } },
  { name: "enter plain keeps indent", doc: "    indented code\nx", run: async (p, h) => { await h.setSel(17); await h.keys("Enter"); await p.type("y"); } },
  { name: "shift-enter", doc: "- item", run: async (p, h) => { await h.setSel(6); await h.keys(["Enter", MOD.Shift]); await p.type("z"); } },

  // ------------------------------------------------ formatting shortcuts
  { name: "cmd-b toggles bold", doc: "make this bold", run: async (p, h) => {
    await h.setSel(10, 14);
    await h.keys(["b", M]);
    const a = await h.doc();
    await h.keys(["b", M]);
    return { a };
  } },
  { name: "cmd-i on bold makes bold italic", doc: "a **word** b", run: async (p, h) => {
    await h.setSel(4, 8);
    await h.keys(["i", M]);
    const a = await h.doc();
    await h.keys(["i", M]);
    const b = await h.doc();
    await h.keys(["b", M]);
    return { a, b };
  } },
  { name: "cmd-i unwrap inside", doc: "x *it* y ***bi*** z", run: async (p, h) => {
    await h.setSel(2, 6);
    await h.keys(["i", M]);
    const a = await h.doc();
    const i = await h.find("***bi***");
    await h.setSel(i, i + 8);
    await h.keys(["i", M]);
    const b = await h.doc();
    await h.keys(["b", M]);
    return { a, b };
  } },
  { name: "cmd-e inline code", doc: "run the thing", run: async (p, h) => { await h.setSel(4, 7); await h.keys(["e", M]); const a = await h.doc(); await h.setSel(0); await h.keys(["e", M]); return { a }; } },
  { name: "headings cmd-alt-1..3 and 0", doc: "Title\nbody", run: async (p, h) => {
    await h.setSel(2);
    const out: string[] = [];
    for (const k of ["1", "2", "3", "3", "2", "0"]) { await h.keys([k, M | MOD.Alt]); out.push(await h.doc()); }
    return { out };
  } },
  { name: "cmd-k without selection", doc: "text ", run: async (p, h) => { await h.setSel(5); await h.keys(["k", M]); await p.type("lbl"); } },
  { name: "multi-cursor via cmd-alt-down then type", doc: "aaa\nbbb\nccc", run: async (p, h) => { await h.setSel(1); await h.keys(["ArrowDown", M | MOD.Alt], ["ArrowDown", M | MOD.Alt]); await p.type("X"); } },
  { name: "move and copy lines", doc: "one\ntwo\nthree", run: async (p, h) => {
    await h.setSel(5);
    await h.keys(["ArrowUp", MOD.Alt]);
    const a = await h.doc();
    await h.keys(["ArrowDown", MOD.Alt | MOD.Shift]);
    const b = await h.doc();
    await h.keys(["k", M | MOD.Shift]);
    return { a, b };
  } },
  { name: "select all and type", run: async (p, h) => { await h.keys(["a", M]); await p.type("new"); } },
  { name: "escape simplifies selection", doc: "abc def", run: async (p, h) => { await h.setSel(0, 3); await h.keys("Escape"); return { hidden: await h.chromeHidden() }; } },
  { name: "transpose ctrl-t and ctrl-k", doc: "abcd efgh", run: async (p, h) => { await h.setSel(2); await h.keys(["t", MOD.Ctrl]); const a = await h.doc(); await h.keys(["k", MOD.Ctrl]); return { a }; } },

  // ------------------------------------------------ navigation
  { name: "arrows and word moves", doc: "The **bold** word, and punctuation... here.", run: async (p, h) => {
    await h.setSel(0);
    const trail: number[] = [];
    for (let i = 0; i < 8; i++) { await h.keys(["ArrowRight", MOD.Alt]); trail.push((await h.sel()).head); }
    for (let i = 0; i < 8; i++) { await h.keys(["ArrowLeft", MOD.Alt]); trail.push((await h.sel()).head); }
    for (let i = 0; i < 3; i++) { await h.keys("ArrowRight"); trail.push((await h.sel()).head); }
    return { trail };
  } },
  { name: "shift selection by char and word", doc: "alpha beta gamma", run: async (p, h) => {
    await h.setSel(6);
    await h.keys(["ArrowRight", MOD.Shift], ["ArrowRight", MOD.Shift | MOD.Alt], ["ArrowLeft", MOD.Shift | MOD.Alt], ["ArrowLeft", MOD.Shift | MOD.Alt]);
  } },
  { name: "cmd line moves on wrapped lines", doc: LONG, run: async (p, h) => {
    await h.setSel(60);
    const trail: [number, number][] = [];
    const s = async () => { const x = await h.sel(); trail.push([x.anchor, x.head]); };
    await h.keys(["ArrowRight", M]); await s();
    await h.keys(["ArrowRight", M]); await s();
    await h.keys(["ArrowLeft", M]); await s();
    await h.keys(["ArrowLeft", M]); await s();
    await h.keys(["ArrowRight", M | MOD.Shift]); await s();
    await h.keys("End"); await s();
    await h.keys("Home"); await s();
    await h.keys(["ArrowDown", M]); await s();
    await h.keys(["ArrowUp", M | MOD.Shift]); await s();
    return { trail };
  } },
  { name: "up and down across wrapped lines", doc: LONG, run: async (p, h) => {
    await h.setSel(40);
    const trail: number[] = [];
    for (let i = 0; i < 7; i++) { await h.keys("ArrowDown"); trail.push((await h.sel()).head); }
    for (let i = 0; i < 8; i++) { await h.keys("ArrowUp"); trail.push((await h.sel()).head); }
    await h.keys(["ArrowDown", MOD.Shift], ["ArrowDown", MOD.Shift]);
    return { trail };
  } },
  { name: "vertical motion through headings and lists", run: async (p, h) => {
    await h.setSel(5);
    const trail: number[] = [];
    for (let i = 0; i < 16; i++) { await h.keys("ArrowDown"); trail.push((await h.sel()).head); }
    for (let i = 0; i < 16; i++) { await h.keys("ArrowUp"); trail.push((await h.sel()).head); }
    return { trail };
  } },
  { name: "page down and doc start/end", doc: LONG + "\n" + LONG + "\n" + LONG, run: async (p, h) => {
    await h.setSel(10);
    await h.keys("PageDown"); const a = (await h.sel()).head;
    await h.keys(["ArrowDown", M]); const b = (await h.sel()).head;
    await h.keys(["ArrowUp", M]); const c = (await h.sel()).head;
    return { a, b, c };
  } },

  // ------------------------------------------------ links
  { name: "link renders folded", doc: LINKS, run: async (p, h) => { await h.setSel(0); return { line: await h.lineText("Before"), line2: await h.lineText("Next") }; } },
  { name: "arrow right into folded link", doc: LINKS, run: async (p, h) => {
    await h.setSel(5);
    const trail: [number, string][] = [];
    for (let i = 0; i < 12; i++) { await h.keys("ArrowRight"); trail.push([(await h.sel()).head, await h.lineText("Before")]); }
    return { trail };
  } },
  { name: "arrow left into folded link", doc: LINKS, run: async (p, h) => {
    const end = await h.find(" after");
    await h.setSel(end + 2);
    const trail: [number, string][] = [];
    for (let i = 0; i < 6; i++) { await h.keys("ArrowLeft"); trail.push([(await h.sel()).head, await h.lineText("Before")]); }
    return { trail };
  } },
  { name: "word moves across folded links", doc: LINKS, run: async (p, h) => {
    await h.setSel(0);
    const trail: number[] = [];
    for (let i = 0; i < 10; i++) { await h.keys(["ArrowRight", MOD.Alt]); trail.push((await h.sel()).head); }
    return { trail };
  } },
  { name: "down into folded link line", doc: LINKS, run: async (p, h) => {
    await h.setSel(12);
    await h.keys("ArrowDown");
    const a = (await h.sel()).head;
    await h.keys("ArrowUp");
    return { a, line: await h.lineText("Before") };
  } },
  { name: "click into link reveals markdown", doc: LINKS, run: async (p, h) => {
    await h.setSel(0);
    const pt = await h.charPoint(await h.find("label", 2));
    await p.click(pt.x, pt.y);
    return { line: await h.lineText("Before") };
  } },
  { name: "click at link edges", doc: LINKS, run: async (p, h) => {
    await h.setSel(0);
    const out: unknown[] = [];
    for (const [needle, off, dx] of [["label", 0, -3], ["label", 4, 4], ["label", 4, 30]] as const) {
      const pt = await h.charPoint(await h.find(needle, off));
      await p.click(pt.x + dx, pt.y);
      out.push([(await h.sel()).head, await h.lineText("Before")]);
      await h.setSel(0);
    }
    return { out };
  } },
  { name: "cmd-click on folded link does not move caret", doc: LINKS, run: async (p, h) => {
    await h.setSel(0);
    await p.eval("window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; true");
    const pt = await h.charPoint(await h.find("label", 2));
    await p.click(pt.x, pt.y, 1, MOD.Meta);
    return { opened: await p.eval("window.__opened"), title: await p.eval(`document.querySelector(".cm-md-link-rendered, .md-link-rendered")?.title`) };
  } },
  { name: "type after link keeps it folded", doc: "See ", run: async (p, h) => {
    await h.setSel(4);
    await h.keys(["k", M]);
    await p.type("x");
    await h.keys("ArrowRight", "ArrowRight");
    await p.type("https://a.b");
    await h.keys(["ArrowRight", M]);
    await p.type(" more");
    return { line: await h.lineText("See") };
  } },

  // ------------------------------------------------ mouse selection & format bar
  { name: "double and triple click", run: async (p, h) => {
    const pt = await h.charPoint(await h.find("concept", 2));
    await p.click(pt.x, pt.y, 2);
    const dbl = await h.sel();
    await p.click(pt.x, pt.y, 3);
    const tpl = await h.sel();
    const pt2 = await h.charPoint(await h.find("**bold**", 4));
    await p.click(pt2.x, pt2.y, 2);
    return { dbl, tpl, bold: await h.sel() };
  } },
  { name: "drag select shows bar", run: async (p, h) => {
    const a = await h.charPoint(await h.find("pleasant")), b = await h.charPoint(await h.find("pleasant", 7));
    await p.drag(a.x - 3, a.y, b.x + 4, b.y);
    await Bun.sleep(120);
    return { bar: await h.bar() };
  } },
  { name: "drag across lines", run: async (p, h) => {
    const a = await h.charPoint(await h.find("Saves", 2)), b = await h.charPoint(await h.find("fade away", 3));
    await p.drag(a.x, a.y, b.x, b.y, 12);
    return { bar: await h.bar() };
  } },
  { name: "shift-click extends", run: async (p, h) => {
    const a = await h.charPoint(await h.find("concept")), b = await h.charPoint(await h.find("Scratchwork"));
    await p.click(a.x, a.y);
    await p.click(b.x, b.y, 1, MOD.Shift);
  } },
  { name: "click below text goes to end, above to start", run: async (p, h) => {
    await p.click(700, 850);
    const below = await h.sel();
    await p.eval("window.scrollTo(0, 0)");
    await p.click(700, 40);
    return { below };
  } },
  { name: "format bar bold italic buttons", run: async (p, h) => {
    const pt = await h.charPoint(await h.find("quiet", 2));
    await p.click(pt.x, pt.y, 2);
    await Bun.sleep(100);
    const b0 = await h.bar();
    await p.eval(`document.getElementById("fmt-bold").click()`); await Bun.sleep(80);
    const b1 = await h.bar();
    await p.eval(`document.getElementById("fmt-italic").click()`); await Bun.sleep(80);
    const d1 = await h.doc();
    await p.eval(`document.getElementById("fmt-italic").click()`); await Bun.sleep(80);
    await p.eval(`document.getElementById("fmt-bold").click()`); await Bun.sleep(80);
    return { b0, b1, d1, b2: await h.bar() };
  } },
  { name: "format bar link apply, edit, unlink", run: async (p, h) => {
    const pt = await h.charPoint(await h.find("quiet", 2));
    await p.click(pt.x, pt.y, 2);
    await Bun.sleep(100);
    await p.eval(`document.getElementById("fmt-link").click()`); await Bun.sleep(80);
    const focused = await p.eval("document.activeElement.id");
    await p.type("example.com");
    await h.keys("Enter");
    await Bun.sleep(100);
    const d1 = await h.doc();
    const line = await h.lineText("place to write");
    // select the label and edit the URL
    const pt2 = await h.charPoint(await h.find("[quiet]", 3));
    await p.click(pt2.x, pt2.y, 2);
    await Bun.sleep(100);
    const barOnLink = await h.bar();
    await h.keys(["k", M]);
    await Bun.sleep(50);
    const url = await p.eval("document.getElementById('format-url').value");
    await p.eval("document.getElementById('format-url').select()");
    await p.type("https://changed.dev");
    await h.keys("Enter");
    await Bun.sleep(80);
    const d2 = await h.doc();
    const i = await h.find("[quiet]");
    await h.setSel(i + 1, i + 6);
    await Bun.sleep(80);
    await p.eval(`document.getElementById("fmt-link").click()`); await Bun.sleep(80);
    await p.eval("document.getElementById('format-url').value = ''");
    await h.keys("Enter");
    await Bun.sleep(80);
    return { focused, d1, line, barOnLink, url, d2 };
  } },
  { name: "format link escape cancels", run: async (p, h) => {
    const pt = await h.charPoint(await h.find("Light", 2));
    await p.click(pt.x, pt.y, 2);
    await Bun.sleep(100);
    await p.eval(`document.getElementById("fmt-link").click()`); await Bun.sleep(80);
    await p.type("zzz");
    await h.keys("Escape");
    await Bun.sleep(80);
    return { focus: await p.eval("scratchEditor.view.hasFocus"), bar: await h.bar(), hidden: await h.chromeHidden() };
  } },

  // ------------------------------------------------ paste & clipboard
  { name: "paste url over plain selection", run: async (p, h) => { const i = await h.find("start over"); await h.setSel(i, i + 5); await h.paste("https://blank.page"); } },
  { name: "paste url over bold text", run: async (p, h) => { const i = await h.find("bold**"); await h.setSel(i, i + 4); await h.paste("https://x.dev"); } },
  { name: "paste www url", doc: "go here now", run: async (p, h) => { await h.setSel(3, 7); await h.paste("www.site.org"); } },
  { name: "paste plain text multi-line", doc: "ab", run: async (p, h) => { await h.setSel(1); await h.paste("x\r\ny\nz"); } },
  { name: "copy and cut linewise", doc: "one\ntwo\nthree", run: async (p, h) => {
    await h.setSel(5);
    const c = await h.copy("copy");
    const x = await h.copy("cut");
    await h.setSel(0);
    await h.paste(x);
    return { c, x };
  } },
  { name: "copy selection", doc: "one\ntwo", run: async (p, h) => { await h.setSel(1, 6); return { c: await h.copy("copy") }; } },

  // ------------------------------------------------ IME composition
  { name: "ime composition commit", doc: "ab", run: async (p, h) => {
    await h.setSel(1);
    await p.send("Input.imeSetComposition", { text: "k", selectionStart: 1, selectionEnd: 1 });
    await p.send("Input.imeSetComposition", { text: "かn", selectionStart: 2, selectionEnd: 2 });
    await p.send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 });
    const mid = await h.doc();
    await p.send("Input.insertText", { text: "仮名" });
    await Bun.sleep(80);
    const after = await h.doc();
    await h.keys(["z", M]);
    return { mid, after };
  } },
  { name: "dead key accent", doc: "caf", run: async (p, h) => {
    await h.setSel(3);
    await p.send("Input.imeSetComposition", { text: "´", selectionStart: 1, selectionEnd: 1 });
    await p.send("Input.insertText", { text: "é" });
    await Bun.sleep(50);
    await p.type(" ok");
  } },
  { name: "ime over selection", doc: "hello world", run: async (p, h) => {
    await h.setSel(6, 11);
    await p.send("Input.imeSetComposition", { text: "w", selectionStart: 1, selectionEnd: 1 });
    await p.send("Input.imeSetComposition", { text: "wö", selectionStart: 2, selectionEnd: 2 });
    await p.send("Input.insertText", { text: "wörld" });
    await Bun.sleep(50);
  } },
  { name: "ime in list item then enter", doc: "- a", run: async (p, h) => {
    await h.setSel(3);
    await p.send("Input.imeSetComposition", { text: "ü", selectionStart: 1, selectionEnd: 1 });
    await p.send("Input.insertText", { text: "ü" });
    await Bun.sleep(50);
    await h.keys("Enter");
    await p.type("b");
  } },
  { name: "ime in empty document", doc: "", run: async (p, h) => {
    await h.setSel(0);
    await p.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
    await p.send("Input.insertText", { text: "日本" });
    await Bun.sleep(50);
    return { placeholder: await p.eval(`!!document.querySelector(".cm-placeholder, .ed-placeholder")`) };
  } },

  // ------------------------------------------------ more commands
  { name: "home and end with indentation", doc: "    indented line here\nnext", run: async (p, h) => {
    await h.setSel(12);
    const t: number[] = [];
    for (const k of ["Home", "Home", "Home", "End", ["Home", MOD.Shift]] as const) { await h.keys(k as any); t.push((await h.sel()).head); }
    return { t };
  } },
  { name: "emacs keys ctrl-a ctrl-e ctrl-d ctrl-h ctrl-o ctrl-b ctrl-f", doc: "abc def\nghi", run: async (p, h) => {
    await h.setSel(5);
    const t: unknown[] = [];
    for (const k of ["e", "a", "f", "d", "h", "o", "b", "n", "p"]) { await h.keys([k, MOD.Ctrl]); t.push([(await h.sel()).head, await h.doc()]); }
    return { t };
  } },
  { name: "select line and indent keys", doc: "one\ntwo\nthree", run: async (p, h) => {
    await h.setSel(5);
    await h.keys(["l", MOD.Ctrl]); const a = await h.sel();
    await h.keys(["]", M]); const b = await h.doc();
    await h.keys(["]", M], ["[", M]); const c = await h.doc();
    await h.keys(["Enter", M]); await p.type("blank");
    return { a, b, c };
  } },
  { name: "block comment and matching bracket", doc: "a (b [c] d) e", run: async (p, h) => {
    await h.setSel(2);
    await h.keys(["\\", M | MOD.Shift]); const a = (await h.sel()).head;
    await h.setSel(4, 9);
    await h.keys(["a", MOD.Ctrl | MOD.Shift]); const b = await h.doc();
    await h.keys(["a", MOD.Ctrl | MOD.Shift]);
    return { a, b };
  } },
  { name: "syntax moves ctrl-arrow", doc: "Some **bold** and `code` and [a](b).", run: async (p, h) => {
    await h.setSel(0);
    const t: number[] = [];
    for (let i = 0; i < 6; i++) { await h.keys(["ArrowRight", MOD.Ctrl]); t.push((await h.sel()).head); }
    for (let i = 0; i < 6; i++) { await h.keys(["ArrowLeft", MOD.Ctrl]); t.push((await h.sel()).head); }
    return { t };
  } },
  { name: "undo selection cmd-u", doc: "abc def ghi", run: async (p, h) => {
    await h.setSel(1);
    await h.keys(["ArrowRight", MOD.Alt], ["ArrowRight", MOD.Alt]);
    await h.keys(["u", M]); const a = await h.sel();
    await h.keys(["u", M | MOD.Shift]);
    return { a };
  } },
  { name: "cmd-click adds a cursor", doc: "first line\nsecond line", run: async (p, h) => {
    await h.setSel(2);
    const pt = await h.charPoint(await h.find("second", 3));
    await p.click(pt.x, pt.y, 1, MOD.Meta);
    await p.type("Z");
    return { n: (await h.sel()).n };
  } },
  { name: "triple-click drag selects lines", run: async (p, h) => {
    const a = await h.charPoint(await h.find("Saves", 1)), b = await h.charPoint(await h.find("Light and", 1));
    await p.mouse("mouseMoved", a.x, a.y);
    for (let c = 1; c <= 2; c++) { await p.mouse("mousePressed", a.x, a.y, { clickCount: c, buttons: 1 }); await p.mouse("mouseReleased", a.x, a.y, { clickCount: c }); }
    await p.mouse("mousePressed", a.x, a.y, { clickCount: 3, buttons: 1 });
    for (let i = 1; i <= 6; i++) await p.mouse("mouseMoved", a.x, a.y + ((b.y - a.y) * i) / 6, { buttons: 1, button: "left" });
    await p.mouse("mouseReleased", b.x, b.y, { clickCount: 3 });
    await Bun.sleep(80);
  } },
  { name: "click in selection collapses on mouseup", run: async (p, h) => {
    const i = await h.find("pleasant to read");
    await h.setSel(i, i + 16);
    const pt = await h.charPoint(i + 5);
    await p.click(pt.x, pt.y);
  } },
  { name: "delete to line boundary on wrapped line", doc: LONG, run: async (p, h) => { await h.setSel(120); await h.keys(["Backspace", M]); const a = await h.doc(); await h.keys(["Delete", M]); return { a }; } },
  { name: "cut then paste restores", doc: "hello brave new world", run: async (p, h) => { await h.setSel(6, 12); const x = await h.copy("cut"); await h.setSel(0); await h.paste(x); await h.keys(["z", M]); return { x }; } },
  { name: "drag selected text to move it", doc: "move THIS word here", run: async (p, h) => {
    await h.setSel(5, 9);
    await p.send("Input.setInterceptDrags", { enabled: true });
    const dragData = new Promise<any>((res) => p.onEvent("Input.dragIntercepted", (e: any) => res(e.data)));
    const a = await h.charPoint(6), b = await h.charPoint(await h.find("here", 3));
    await p.mouse("mouseMoved", a.x, a.y);
    await p.mouse("mousePressed", a.x, a.y, { clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 10; i++) await p.mouse("mouseMoved", a.x + ((b.x + 3 - a.x) * i) / 10, a.y, { buttons: 1, button: "left" });
    const data = await Promise.race([dragData, Bun.sleep(1500).then(() => null)]);
    if (data) {
      await p.send("Input.dispatchDragEvent", { type: "dragEnter", x: b.x + 3, y: b.y, data });
      await p.send("Input.dispatchDragEvent", { type: "dragOver", x: b.x + 3, y: b.y, data });
      await p.send("Input.dispatchDragEvent", { type: "drop", x: b.x + 3, y: b.y, data });
    }
    await p.mouse("mouseReleased", b.x + 3, b.y, { clickCount: 1 });
    await Bun.sleep(100);
    return { dragged: !!data };
  } },
  { name: "drop text (synthetic drag events)", doc: "move THIS word here", run: async (p, h) => {
    await h.setSel(5, 9);
    const b = await h.charPoint(await h.find("here", 3));
    await p.eval(`(() => { const c = document.querySelector(".cm-content, .ed-content"); const dt = new DataTransfer();
      c.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true, cancelable: true }));
      c.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: ${b.x + 3}, clientY: ${b.y}, bubbles: true, cancelable: true }));
      c.dispatchEvent(new DragEvent("dragend", { bubbles: true })); return true; })()`);
    await Bun.sleep(50);
    const moved = await h.doc();
    const a = await h.charPoint(0);
    await p.eval(`(() => { const c = document.querySelector(".cm-content, .ed-content"); const dt = new DataTransfer(); dt.setData("text/plain", "EXT ");
      c.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: ${a.x - 2}, clientY: ${a.y}, bubbles: true, cancelable: true })); return true; })()`);
    await Bun.sleep(50);
    return { moved };
  } },
  // ------------------------------------------------ chrome, stats, misc
  { name: "controls fade on typing and return on mouse", run: async (p, h) => {
    const before = await h.chromeHidden();
    await p.type("x");
    const typed = await h.chromeHidden();
    await Bun.sleep(700);
    for (let i = 0; i < 10; i++) { await p.mouse("mouseMoved", 700 + i * 12, 400); await Bun.sleep(16); }
    const after = await h.chromeHidden();
    await h.keys(["z", M]);
    const undo = await h.chromeHidden();
    return { before, typed, after, undo };
  } },
  { name: "stats with selection and modes", run: async (p, h) => {
    const s0 = await p.eval("document.getElementById('stat').textContent");
    const i = await h.find("quiet place");
    await h.setSel(i, i + 11);
    await Bun.sleep(30);
    const s1 = await p.eval("document.getElementById('stat').textContent");
    await p.eval("document.getElementById('stat').click()");
    const s2 = await p.eval("document.getElementById('stat').textContent");
    await p.eval("document.getElementById('stat').click()");
    const s3 = await p.eval("document.getElementById('stat').textContent");
    await p.eval("document.getElementById('stat').click()");
    return { s0, s1, s2, s3, title: await p.eval("document.title") };
  } },
  { name: "empty doc placeholder and title", doc: "", run: async (p, h) => {
    return { title: await p.eval("document.title"), ph: await p.eval(`(() => { const e = document.querySelector(".cm-placeholder") || document.querySelector(".ed-placeholder"); return e ? (e.textContent || getComputedStyle(e, "::before").content.replace(/^"|"$/g, "")) : null; })()`) };
  } },
  { name: "autosave and restore selection", doc: "saved text here", run: async (p, h) => {
    await h.setSel(6, 10);
    await p.type("TEXT");
    await Bun.sleep(600);
    const stored = await p.eval(`localStorage.getItem("scratchwork-editor:doc:v1")`);
    await p.send("Page.reload");
    await Bun.sleep(700);
    return { stored, sel: await h.sel(), doc: await h.doc(), focus: await p.eval("scratchEditor.view.hasFocus") };
  } },
  { name: "preview toggle and escape", run: async (p, h) => {
    await h.keys(["p", M | MOD.Shift]);
    const on = await p.eval(`document.body.classList.contains("previewing") && !!document.querySelector("#preview h1")`);
    await h.keys("Escape");
    return { on, off: await p.eval(`document.body.classList.contains("previewing")`), focus: await p.eval("scratchEditor.view.hasFocus") };
  } },
  { name: "help panel", run: async (p, h) => {
    await h.keys(["/", M]);
    const open = await p.eval(`!document.getElementById("help").hidden`);
    await h.keys("Escape");
    return { open, closed: await p.eval(`document.getElementById("help").hidden`) };
  } },
  { name: "cmd-s flashes", run: async (p, h) => { await h.keys(["s", M]); return { toast: await p.eval(`document.getElementById("toast").textContent`) }; } },
  { name: "typing scrolls caret above bottom margin", doc: Array.from({ length: 40 }, (_, i) => "Line " + i).join("\n"), run: async (p, h) => {
    await h.setSel(0);
    for (let i = 0; i < 30; i++) await h.keys("ArrowDown");
    await Bun.sleep(100);
    await p.type("x");
    return { scroll: await p.eval("Math.round(window.scrollY)") };
  } },
  { name: "tab sync from another tab", doc: "mine", run: async (p, h) => {
    await h.setSel(2);
    await p.eval(`window.dispatchEvent(new StorageEvent("storage", { key: "scratchwork-editor:doc:v1", newValue: "theirs changed" })); true`);
    await Bun.sleep(50);
    await h.keys(["z", M]);
  } },
];

function stable(v: unknown) { return JSON.stringify(v); }

const filters = process.argv.slice(2);
let pass = 0, fail = 0;
// Scenarios run side by side, each in one of a few browsers (cdp.ts, `pool`);
// within a scenario the two editors still run one after the other.
const chosen = scenarios.filter((s) => !filters.length || filters.some((f) => s.name.includes(f)));
await pool(chosen, async (s: Scenario, browser: Browser) => {
  // A difference counts only if it happens again: the CodeMirror reference
  // reads typed text back from the DOM asynchronously and, on a busy
  // machine, occasionally drops a synthetic keystroke.
  let a = "", b = "";
  for (let attempt = 0; attempt < 3 && (attempt == 0 || a != b); attempt++) [a, b] = await runBoth(s, browser);
  if (a == b) { pass++; console.log("MATCH  " + s.name + (process.env.VERBOSE ? "  " + b : "")); }
  else { fail++; console.log("DIFF   " + s.name + "\n   cm:  " + a + "\n   new: " + b); }
});

async function runBoth(s: Scenario, browser: Browser): Promise<[string, string]> {
  const results: Record<string, unknown> = {};
  for (const which of ["editor-cm", "editor"] as const) {
    const page = await browser.page();
    try {
      await page.open(urlFor(which), { doc: s.doc, width: s.width });
      const h = new Helpers(page);
      let obs: Obs | void;
      try { obs = await s.run(page, h); } catch (e) { obs = { threw: String(e) }; }
      await Bun.sleep(50);
      results[which] = { doc: await h.doc(), sel: await h.sel(), obs: obs ?? null, errors: page.errors };
    } finally { page.close(); }
  }
  return [stable(results["editor-cm"]), stable(results["editor"])];
}
console.log(`\n${pass} matching, ${fail} differing`);
process.exit(fail ? 1 : 0);
