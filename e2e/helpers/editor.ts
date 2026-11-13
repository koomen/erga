// The page editor in a tab, for the editor's tests: a fixture's copy linked as
// a document on a worker's server, opened in the editor (?edit), with helpers
// to read the page and its source and to click and select by CSS selector.
//
// The tab holds the shell (editor.ts: the source, the selection, the panels),
// and the page in its frame, on the document's own origin; the page editor runs
// in the page itself (frame.ts: its window has `ergaFrame`). Expressions for the
// page are strings evaluated in the page's frame.
//
// Trap: the page's editor has its own socket and replica of the room (libs/text/ui/frame.ts), apart from the shell's.
// An edit typed on the page reaches the shell's replica only through the room, a moment later. A test that reads the
// shell's text waits for it (`ed.source()`); one that reads the editor's selection reads the frame's
// (`ed.selection()`). The editor starts a round trip after the pencil: a test waits for `window.ergaFrame.page` before
// it clicks. The editor's own controls are in a shadow root on the page: a test reaches them with `ed.controls`, never
// in the shell's document. An agent's edit is in the page's text at once (its typing is only an effect,
// libs/text/ui/marks.ts): a test that reads the page's text sees all of it.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Frame, Page } from "playwright-core";
import { ROOT } from "./env";
import { agentClosed, expect, goto, servers, settle, until, type Server, type Tab } from "./fixtures";
import { VISIBLE } from "./visible";

/** A template literal's text without its first newline and its common indent. */
const dedent = (s: string) => {
  const lines = s
    .replace(/^\n/, "")
    .replace(/\n[ \t]*$/, "")
    .split("\n");
  const cut = Math.min(Infinity, ...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  if (cut == Infinity) return lines.join("\n");
  return lines.map((l) => l.slice(cut)).join("\n");
};

/** The page's document and window, as expressions in the page's frame (where the editor runs). */
export const F = `document`;
export const W = `window`;
/** In the page's frame: where the page sits in it (it is it). */
const PAGE_AT = `({ left: 0, top: 0 })`;

/** Keys sent as plain DevTools key events (Editor.press), with their Windows key codes. */
const RAW = { Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 } as const;
const MOD: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8, ControlOrMeta: process.platform == "darwin" ? 4 : 2 };

/** The editor's timers run at this fraction of real time in the tests (libs/text/ui/editor.ts, `ms`). */
export const TIMESCALE = 0.1;
/**
 * How long an edit on disk may take to reach the tab, or the tab's to reach the disk: the file watcher, the dev server
 * and the room. Well under a second alone; seconds while the suite keeps the machine busy.
 */
export const DISK_MS = 15_000;

export interface OpenOptions {
  /** The fixture's file the document is. */
  file?: string;
  /** Added to the document's address (a query, "?..."), before edit. */
  query?: string;
  timescale?: number;
  /** Start as someone who keeps the agent pane closed (true: whatever the editor does by itself). */
  agent?: boolean;
  /** The page has errors on purpose (otherwise any fails the test). */
  allowErrors?: boolean;
}

export type Editor = Awaited<ReturnType<typeof openEditor>>;

/** An empty page in the editor (e2e/fixtures/empty), the caret in its one paragraph. */
export async function openEmpty(tab: Tab) {
  const ed = await openEditor(tab, await servers.main(), "empty");
  await ed.clickEnd("p");
  await ed.idle();
  return ed;
}

/** Opens a copy of e2e/fixtures/<fixture> in the editor, in the test's tab. */
export async function openEditor(tab: Tab, server: Server, fixture: string, opts: OpenOptions = {}) {
  const page = tab.page;
  tab.strict = !opts.allowErrors;
  const { dir, address } = await server.fixture(fixture);
  const file = join(dir, opts.file ?? "index.html");
  const timescale = opts.timescale ?? TIMESCALE;
  // In the tab itself only: the page editor's frame and the page have their own origins.
  await page.addInitScript((timescale) => {
    if (window.top != window) return;
    (window as any).__ergaTimescale = timescale;
    // The page editor checks after each change that the page shows its HTML (libs/text/ui/check.ts).
    (window as any).__ergaCheck = true;
  }, timescale);
  if (!opts.agent) await agentClosed(page);
  await goto(page, `${address}${opts.query ? `${opts.query}&edit` : "?edit"}`);
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
  /**
   * Where the page editor's frame sits in the tab (to turn a point on the page into one for the mouse), once it rests:
   * the agent's pane slides the page aside as it opens and closes, and a click aimed during the slide lands on the pane.
   */
  const frameAt = () =>
    page.evaluate(async () => {
      const el = document.getElementById("frame")!;
      const at = () => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top };
      };
      // A transition that moves the page: one on the frame, on what holds it, or on the agent's pane beside it. (Two
      // equal readings a frame apart do not prove rest on a busy machine: a frame can come late.)
      const moving = () =>
        document.getAnimations().some((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target;
          return a.playState == "running" && !!target && (target.contains(el) || target.id == "agent");
        });
      const frame = () =>
        new Promise((r) => {
          const t = setTimeout(r, 50);
          requestAnimationFrame(() => {
            clearTimeout(t);
            r(0);
          });
        });
      let was = at();
      for (const end = Date.now() + 2000; Date.now() < end; ) {
        await frame();
        const now = at();
        if (now.x == was.x && now.y == was.y && !moving()) break;
        was = now;
      }
      return was;
    });
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
    /**
     * After a (re)load: the shell is up, the editor on the page (its text blocks editable), the agent's status in. Not
     * the old page that is about to load again (ergaFrame.reloading): it stays editable until the new one comes.
     */
    loaded: () =>
      until(
        async () =>
          (await page.evaluate(`!!window.ergaPage && !!document.getElementById("agent-model")?.textContent`)) &&
          (await ed.frame<boolean>(
            `!!window.ergaFrame?.page && !ergaFrame.reloading && !!${F}.querySelector("[data-erga-text]") && ${F}.documentElement.hasAttribute("data-erga-editing")`
          )),
        10_000,
        "the editor loads"
      ),
    /** The tab has drawn what's done, and the editor in the page is up (a page that loads again, made afresh, has come). */
    settle: async () => {
      await settle(page);
      await until(
        async () =>
          !(await page.evaluate(`document.body.classList.contains("erga-editing") && !document.body.classList.contains("source")`)) ||
          (await ed.frame<boolean>("!!window.ergaFrame?.page && !ergaFrame.reloading").catch(() => false)),
        10_000,
        "the page's editor is up"
      );
    },
    /** Whether the page's text has the focus, with the caret (the selection's focus) in an element that matches `sel`. */
    caretIn: (sel: string) =>
      ed.frame<boolean>(
        `(() => { const n = ${F}.getSelection().focusNode, e = n && (n.nodeType == 1 ? n : n.parentElement); return ${F}.hasFocus() && ${F}.activeElement == ${F}.body && ${F}.body.isContentEditable && !!e?.closest(${JSON.stringify(sel)}); })()`
      ),
    /**
     * The page is rendered and has the caret in a unit. Keys never need it (the editor holds keys that come while it
     * renders the page afresh, and applies them after); a click does, after a change that renders the page afresh (an
     * indent in an HTML list): a click on a page between two documents is lost.
     */
    async idle() {
      await settle(page);
      await until(
        () =>
          ed.frame<boolean>(
            `!!window.ergaFrame?.page && !ergaFrame.page.rendering && ${F}.activeElement == ${F}.body && (() => { const n = ${F}.getSelection().focusNode; return !!(n && (n.nodeType == 1 ? n : n.parentElement)?.closest("[data-erga-text]")); })()`
          ),
        5000,
        "the editor to settle"
      );
    },
    /** The file on disk. */
    disk: () => readFileSync(doc.file, "utf8"),
    write: (text: string) => writeFileSync(doc.file, text),
    /**
     * The document's text as the shell's replica of the room has it, once it has the page editor's (the editor's own
     * replica sends its edits to the room, and the room to the shell). The text returned is the one that was compared:
     * after an undo the shell can be two edits behind and still equal the editor's, and a second read gave the text
     * between.
     */
    async source(): Promise<string> {
      const shell = () => page.evaluate("ergaPage.collab.current()") as Promise<string>;
      let same: string | null = null;
      await until(async () => {
        const mine = await ed.frame<string | null>("window.ergaFrame?.page ? ergaFrame.page.state.doc.toString() : null").catch(() => null);
        const theirs = await shell();
        if (mine != null && mine != theirs) return false;
        same = theirs;
        return true;
      }, 3000).catch(() => {});
      return same ?? shell();
    },
    /**
     * In the editor's own controls on the page (libs/text/ui/controls.ts: the style bar, the link bar, the note):
     * `expr` with C, their shadow root; null before the editor has drawn them.
     */
    controls: <T = any>(expr: string) =>
      ed.frame<T | null>(`(() => { const C = ${F}.querySelector("erga-controls")?.shadowRoot; return C ? (${expr}) : null; })()`),
    /** In the comments' own cards on the page (libs/text/ui/comments.ts): `expr` with C, their shadow root; null before they're drawn. */
    comments: <T = any>(expr: string) =>
      ed.frame<T | null>(`(() => { const C = ${F}.querySelector("erga-comments")?.shadowRoot; return C ? (${expr}) : null; })()`),
    /** Clicks the middle of an element in the shadow root of the editor's controls or comments on the page, once it shows, with the mouse. */
    async clickIn(host: "erga-controls" | "erga-comments", selector: string) {
      const r = await toTab(
        await until(
          () =>
            ed.frame<{ x: number; y: number } | null>(
              `(() => { const el = ${F}.querySelector("${host}")?.shadowRoot?.querySelector(${JSON.stringify(selector)}); const r = el?.getBoundingClientRect(); return r?.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`
            ),
          3000,
          `${host}'s ${selector}`
        ).then((at) => at!),
        ["x"],
        ["y"]
      );
      await ed.click(r.x, r.y);
    },
    /** A message from the shell to the page's frame, as the shell sends its words (erga-mode, erga-comments). */
    toFrame: (msg: unknown) =>
      page.evaluate((m) => (document.getElementById("frame") as HTMLIFrameElement).contentWindow!.postMessage(m, "*"), msg),
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
    /** From now on, every mark the page shows on changed text: a CSS highlight, or an element or class that marks it. */
    watchMarks: () =>
      ed.frame<boolean>(
        `(() => { const w = ${W}, seen = w.__ergaMarks = new Set(); const look = () => { for (const name of w.CSS.highlights.keys()) seen.add("highlight " + name); for (const el of ${F}.querySelectorAll("erga-marks, erga-del, .erga-flash, #erga-authors")) seen.add("element " + (el.id || el.localName)); w.requestAnimationFrame(look); }; look(); return true; })()`
      ),
    /** What watchMarks has seen. */
    seenMarks: () => ed.frame<string[]>(`[...(${W}.__ergaMarks ?? [])]`),
    /** The toast: its text and whether it shows. */
    toast: () => page.evaluate(() => { const t = document.getElementById("toast")!; return { text: t.textContent ?? "", shown: t.classList.contains("show") }; }),
    /** The editor's selection, and the text it covers. */
    async selection(): Promise<{ from: number; to: number; head: number; text: string }> {
      const of = (s: string) =>
        `(() => { const st = ${s}, m = st.selection.main; return { from: m.from, to: m.to, head: m.head, text: st.doc.sliceString(m.from, m.to) }; })()`;
      if (await page.evaluate(`document.body.classList.contains("source")`)) return page.evaluate(of("ergaPage.state"));
      return ed.frame(of("ergaFrame.page.state"));
    },
    /** The page as a person sees it, as text (visible.ts): markers, indents, the caret. */
    visible: () => ed.frame<string>(VISIBLE),
    /**
     * Waits until the page shows `expected` (a visible snapshot; a leading newline and the common indent of a template
     * literal are taken off). On a mismatch: a screenshot, its path in the failure, and the diff.
     */
    async shows(expected: string, ms = 3000) {
      const want = dedent(expected);
      let got = "";
      const end = Date.now() + ms;
      while ((got = await ed.visible()) != want && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
      if (got == want) return;
      // In the checkout (.e2e/shots/), where an agent working in it may read it.
      const shots = join(ROOT, ".e2e", "shots");
      mkdirSync(shots, { recursive: true });
      const shot = join(mkdtempSync(join(shots, "visible-")), "page.png");
      await page.screenshot({ path: shot });
      try {
        expect(got).toBe(want);
      } catch (e) {
        (e as Error).message += `\n--- the page shows:\n${got}\n--- expected:\n${want}\n--- screenshot: ${shot}`;
        throw e;
      }
    },
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
