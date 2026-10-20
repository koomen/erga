// The page editor in a tab, for the editor's tests: a fixture's copy linked as
// a document on a worker's server, opened in the editor (#edit), with helpers
// to read the page and its source and to click and select by CSS selector.
//
// The tab holds the shell (editor.ts: the source, the selection, the panels).
// The page editor runs in a frame on the document's own origin (frame.ts, its
// window has `ergaFrame`), and the page itself in a frame inside that one (F).
// Expressions for the page are strings evaluated in the page editor's frame.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Frame, Page } from "playwright-core";
import { settle, until, type Server, type Tab } from "./fixtures";

/** The page's document and window, as expressions in the page editor's frame. */
export const F = `document.getElementById("page").contentDocument`;
export const W = `document.getElementById("page").contentWindow`;
/** In the page editor's frame: where the page sits in it. */
const PAGE_AT = `document.getElementById("page").getBoundingClientRect()`;

/** Keys sent as plain DevTools key events (Editor.press), with their Windows key codes. */
const RAW = { Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 } as const;
const MOD: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8, ControlOrMeta: process.platform == "darwin" ? 4 : 2 };

/** The editor's timers run at this fraction of real time in the tests (client/editor.ts, `ms`). */
export const TIMESCALE = 0.1;

export interface OpenOptions {
  /** The fixture's file the document is. */
  file?: string;
  /** Added to the document's address, before #edit. */
  query?: string;
  timescale?: number;
  /** Start as someone who keeps the agent pane closed (true: whatever the editor does by itself). */
  agent?: boolean;
  /** The page has errors on purpose (otherwise any fails the test). */
  allowErrors?: boolean;
}

export type Editor = Awaited<ReturnType<typeof openEditor>>;

/** Opens a copy of e2e/fixtures/<fixture> in the editor, in the test's tab. */
export async function openEditor(tab: Tab, server: Server, fixture: string, opts: OpenOptions = {}) {
  const page = tab.page;
  tab.strict = !opts.allowErrors;
  const { dir, address } = await server.fixture(fixture);
  const file = join(dir, opts.file ?? "index.html");
  const timescale = opts.timescale ?? TIMESCALE;
  // In the tab itself only: the page editor's frame and the page have their own origins.
  await page.addInitScript(({ timescale, agent }) => {
    if (window.top != window) return;
    (window as any).__ergaTimescale = timescale;
    // Someone who keeps the agent pane closed (it opens by itself in the editor otherwise): set once, so the tab can still open it.
    if (!agent) try {
      if (!sessionStorage.getItem("erga-test:agent-seeded")) {
        sessionStorage.setItem("erga-test:agent-seeded", "1");
        if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}');
      }
    } catch { /* no storage */ }
  }, { timescale, agent: opts.agent ?? false });
  await page.goto(`${address}${opts.query ?? ""}#edit`);
  const ed = editor(page, { address, dir, file });
  await ed.loaded();
  // The page's own fonts too: text measured before they load moves when they do.
  await ed.frame(`${F}.fonts.ready.then(() => true)`);
  await settle(page);
  return ed;
}

/** Helpers for an editor tab. */
export function editor(page: Page, doc: { address: string; dir: string; file: string }) {
  let cached: Frame | null = null;
  /** The page editor's frame (found again after a reload or a fresh render). */
  const editorFrame = () => until<Frame | null>(async () => {
    if (cached && !cached.isDetached()) return cached;
    for (const f of page.frames()) {
      if (f == page.mainFrame()) continue;
      if (await f.evaluate("!!window.ergaFrame").catch(() => false)) return (cached = f);
    }
    return null;
  }, 10_000, "the page editor's frame");

  /** Reads a value off the page again if its element was gone for a moment (the page renders afresh at times). */
  const settled = async <T>(read: () => Promise<T>, ms = 3000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      try { return await read(); } catch (e) { if (Date.now() > end || !/of null|of undefined|detached|destroyed/.test((e as Error).message)) throw e; await new Promise((r) => setTimeout(r, 30)); }
    }
  };
  /** Where the page editor's frame sits in the tab (to turn a point on the page into one for the mouse). */
  const frameAt = () => page.evaluate(() => { const r = document.getElementById("frame")!.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  const toTab = async <T extends Record<string, number>>(r: T, xs: (keyof T)[], ys: (keyof T)[]): Promise<T> => {
    const f = await frameAt();
    const out = { ...r } as Record<string, number>;
    for (const k of xs) out[k as string] += f.x;
    for (const k of ys) out[k as string] += f.y;
    return out as T;
  };

  const ed = {
    page, F, W, ...doc,
    /** Evaluates an expression in the tab (the shell). */
    eval: <T = any>(expr: string) => page.evaluate(expr) as Promise<T>,
    /** Evaluates an expression in the page editor's frame; again in a fresh frame if it was replaced meanwhile. */
    async frame<T = any>(expr: string): Promise<T> {
      for (let i = 0; ; i++) {
        const f = (await editorFrame())!;
        try { return await f.evaluate(expr) as T; }
        catch (e) { if (i > 20 || !/detached|destroyed|Target closed/.test((e as Error).message)) throw e; cached = null; }
      }
    },
    /** After a (re)load: the shell is up, the page rendered and shown (the page inline gone from over it), the agent's status in. */
    loaded: () => until(async () => await page.evaluate(`!!window.ergaPage && !!document.getElementById("agent-model")?.textContent && !document.getElementById("erga-inline")`) && await ed.frame<boolean>(`!!${F}?.querySelector("[data-erga-id]")`), 10_000, "the editor loads"),
    settle: () => settle(page),
    /**
     * The page is rendered and has the caret in a unit. Keys never need it (the editor holds keys that come while it
     * renders the page afresh, and applies them after); a click does, after a change that renders the page afresh (an
     * indent in an HTML list): a click on a page between two documents is lost.
     */
    async idle() {
      await settle(page);
      await until(() => ed.frame<boolean>(`!ergaFrame.page.rendering && (!ergaFrame.relay || ergaFrame.relay.idle) && !!${F}.activeElement?.closest("[data-erga-id]")`), 5000, "the editor to settle");
    },
    /** The file on disk. */
    disk: () => readFileSync(doc.file, "utf8"),
    write: (text: string) => writeFileSync(doc.file, text),
    /** The document's text as the shell has it, once the page editor's frame has no edits on their way to it. */
    async source(): Promise<string> {
      await until(() => ed.frame<boolean>("!window.ergaFrame?.relay || ergaFrame.relay.idle").catch(() => true), 2000).catch(() => {});
      return page.evaluate("ergaPage.state.doc.toString()") as Promise<string>;
    },
    textOf: (selector: string) => ed.frame<string>(`${F}.querySelector(${JSON.stringify(selector)}).textContent`),
    count: (selector: string) => ed.frame<number>(`${F}.querySelectorAll(${JSON.stringify(selector)}).length`),
    frameAt,
    /** Scrolls an element into view and returns a point in the tab inside it, `at` along its width. */
    async rectOf(selector: string, at = 0.5) {
      return toTab(await settled(() => ed.frame<{ x: number; y: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); const f = ${PAGE_AT}; return { x: f.left + r.left + r.width * ${at}, y: f.top + r.top + r.height / 2 }; })()`)), ["x"], ["y"]);
    },
    /** A point in the tab at character `i` of an element's first text node. */
    async charAt(selector: string, i: number) {
      return toTab(await settled(() => ed.frame<{ x: number; y: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); const t = ${F}.createTreeWalker(el, 4).nextNode(); const rg = ${F}.createRange(); rg.setStart(t, ${i}); rg.setEnd(t, ${i} + 1); const r = rg.getBoundingClientRect(); const f = ${PAGE_AT}; return { x: f.left + r.left + 1, y: f.top + r.top + r.height / 2 }; })()`)), ["x"], ["y"]);
    },
    /** Clicks at a point in the tab, then lets the page catch up. */
    async click(x: number, y: number, opts: { clickCount?: number; modifiers?: ("Shift" | "Alt" | "ControlOrMeta")[] } = {}) {
      for (const m of opts.modifiers ?? []) await page.keyboard.down(m);
      await page.mouse.click(x, y, { clickCount: opts.clickCount ?? 1 });
      for (const m of opts.modifiers ?? []) await page.keyboard.up(m);
      await settle(page);
    },
    /** Clicks just past the end of an element's text. */
    async clickEnd(selector: string) {
      const r = await ed.rectOf(selector, 0.98);
      await ed.click(r.x + 2, r.y);
    },
    async drag(x1: number, y1: number, x2: number, y2: number, steps = 8) {
      await page.mouse.move(x1, y1);
      await page.mouse.down();
      await page.mouse.move(x2, y2, { steps });
      await page.mouse.up();
      await settle(page);
    },
    /** Drags across the first `n` characters of an element's first text node. */
    async selectChars(selector: string, n: number) {
      const r = await toTab(await settled(() => ed.frame<{ a: number; b: number; y: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const t = el.firstChild; const rg = ${F}.createRange(); rg.setStart(t, 0); rg.setEnd(t, ${n}); const r = rg.getBoundingClientRect(); const f = ${PAGE_AT}; return { a: f.left + r.left + 1, b: f.left + r.right, y: f.top + r.top + r.height / 2 }; })()`)), ["a", "b"], ["y"]);
      await ed.drag(r.a, r.y, r.b, r.y);
    },
    /** Drags across all of an element's text. */
    async selectAllOf(selector: string) {
      const r = await toTab(await settled(() => ed.frame<{ a: number; ay: number; b: number; by: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const rg = ${F}.createRange(); rg.selectNodeContents(el); const rs = [...rg.getClientRects()].filter((r) => r.width), first = rs[0], last = rs[rs.length - 1]; const f = ${PAGE_AT}; return { a: f.left + first.left + 1, ay: f.top + first.top + first.height / 2, b: f.left + last.right, by: f.top + last.top + last.height / 2 }; })()`)), ["a", "b"], ["ay", "by"]);
      await ed.drag(r.a, r.ay, r.b, r.by);
    },
    /**
     * Presses a key or a combination ("Enter", "ControlOrMeta+b", "Shift+Tab"). Home, End and the arrows go as plain
     * key events (rawKey) through DevTools: Playwright on a Mac turns them into the Mac's own editing
     * commands (Home scrolls instead of moving the caret, Shift+ArrowUp selects by its own rules).
     */
    async press(combo: string) {
      const parts = combo.split("+"), key = parts.pop()!;
      if (key in RAW) return ed.rawKey(key as keyof typeof RAW, parts);
      await page.keyboard.press(combo);
    },
    /** A key as the browser gets it from DevTools, with no editing command attached. */
    async rawKey(key: keyof typeof RAW, modifiers: string[] = []) {
      const cdp = await page.context().newCDPSession(page);
      const bits = modifiers.reduce((m, k) => m | (MOD[k] ?? 0), 0);
      const k = { key, code: key, windowsVirtualKeyCode: RAW[key], modifiers: bits };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
      await cdp.detach();
    },
    /** IME composition, as DevTools sends it (Playwright has no API for it). */
    async compose(steps: string[], commit: string) {
      const cdp = await page.context().newCDPSession(page);
      for (const text of steps) await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      await cdp.send("Input.insertText", { text: commit });
      await cdp.detach();
    },
    /** Types text as input events, a character at a time ("\n" presses Enter). */
    async type(text: string) {
      for (const ch of text) {
        if (ch == "\n") await page.keyboard.press("Enter");
        else await page.keyboard.insertText(ch);
      }
    },
    /** Added text (the highlights, by name) and removed text (the notches' hover text). */
    marks: () => ed.frame<{ added: string[]; gone: string[]; names: string[] }>(`(() => { const w = ${W}; const added = [], names = []; for (const [name, h] of w.CSS.highlights) { if (!/^erga-(add|a\\d+)-\\d$/.test(name)) continue; for (const r of h) { added.push(r.toString()); names.push(name); } } return { added, names, gone: [...${F}.querySelectorAll("erga-del erga-tip")].map((e) => e.textContent) }; })()`),
    /** The toast: its text and whether it shows. */
    toast: () => page.evaluate(() => { const t = document.getElementById("toast")!; return { text: t.textContent ?? "", shown: t.classList.contains("show") }; }),
    /** The editor's selection, and the text it covers. */
    selection: () => page.evaluate(`(() => { const m = ergaPage.state.selection.main; return { from: m.from, to: m.to, head: m.head, text: ergaPage.state.doc.sliceString(m.from, m.to) }; })()`) as Promise<{ from: number; to: number; head: number; text: string }>,
    /** The agent pane open, its input focused (it may open by itself first). */
    async openAgent() {
      // Someone who keeps it closed finds it closed; anyone else, opening by itself as the editor comes up.
      const kept = await page.evaluate(`(() => { try { return JSON.parse(localStorage.getItem("erga:settings:v1") || "{}").agent === false; } catch { return false; } })()`);
      if (!kept) await until(() => page.evaluate(`document.body.classList.contains("agent-open")`), 2000).catch(() => {});
      await page.evaluate(`document.body.classList.contains("agent-open") ? document.getElementById("agent-input").focus() : document.getElementById("agent-fab").click()`);
      await settle(page);
    },
  };
  return ed;
}
