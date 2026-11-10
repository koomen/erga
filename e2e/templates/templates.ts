// Helpers for the templates' journeys: documents made from a template, opened in the viewer or the editor, and the
// step controls over a presentation, which the page draws itself (libs/steps/ui/steps.ts: <erga-steps>'s shadow root).
// The document's page runs in the tab's frame (#frame), on the document's own origin: `inPage` evaluates in it.

import type { Page } from "playwright-core";
import { settle, until, type Server, type Tab } from "../helpers/fixtures";

/** Makes a document from a template (/new?template=<id>): the answer's status, and the document's address (no ?edit). */
export async function newDoc(server: Server, template: string) {
  const r = await fetch(`${server.root}/new?template=${template}`, { redirect: "manual" });
  const location = r.headers.get("location") ?? "";
  return { status: r.status, address: server.root + location.replace(/[?&]edit=?$/, "") };
}

/**
 * Opens a URL in the journey's tab, as someone who keeps the agent pane closed (it opens by itself in the editor
 * otherwise, and the page slides over), at a window size; the page's errors fail the step.
 */
export async function openTab(tab: Tab, url: string, size?: { width: number; height: number }) {
  tab.strict = true;
  const page = tab.page;
  if (size) await page.setViewportSize(size);
  await page.addInitScript(() => {
    if (window.top != window) return;
    try {
      if (!sessionStorage.getItem("erga-test:agent-seeded")) {
        sessionStorage.setItem("erga-test:agent-seeded", "1");
        if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}');
      }
    } catch {
      /* no storage */
    }
  });
  await page.goto(url);
  await settle(page);
}

/** Evaluates an expression in the document's page; null while the page loads. */
export async function inPage<T = any>(page: Page, expr: string): Promise<T> {
  const f = page.frames().find((f) => f.parentFrame() == page.mainFrame() && /\/t\//.test(f.url()));
  return (f ? await f.evaluate(expr).catch(() => null) : null) as T;
}

/** The editor is in and ready, with its half in the page (a click before that loses the caret to its start). */
export const editorReady = (page: Page) =>
  until(
    async () =>
      (await page.evaluate(
        () => document.body.classList.contains("erga-editor-ready") && document.body.classList.contains("erga-editing")
      )) && (await inPage<boolean>(page, "!!window.ergaFrame?.page")),
    10_000,
    "the editor is ready"
  );

/** The viewer shows the page alone: the editor's controls are gone, and its half is off the page. */
export const viewerBack = (page: Page) =>
  until(
    async () =>
      (await page.evaluate(() => !document.body.classList.contains("erga-editing"))) && (await inPage<boolean>(page, "!window.ergaFrame")),
    10_000,
    "the viewer is back"
  );

export type Bar = {
  shown: boolean;
  at: string;
  back: boolean;
  next: boolean;
  open: boolean;
  items: { n: string; label: string; current: boolean; img: string; drawn: number; first: boolean }[];
};

/** The step controls in the page (<erga-steps>'s shadow root), as an expression in the page. */
const CONTROLS = `document.querySelector("erga-steps")?.shadowRoot`;

/** The step controls: shown, the step they say, back and forward off, the list open, and its steps. */
export const bar = async (page: Page): Promise<Bar> =>
  (await inPage<Bar>(
    page,
    `(() => {
  const c = ${CONTROLS}, b = c?.querySelector(".bar"), panel = c?.querySelector(".panel");
  return { shown: !!b && !b.hidden && getComputedStyle(b).visibility != "hidden" && b.getClientRects().length > 0, at: b?.querySelector(".at").textContent ?? "",
    back: !!b?.querySelector(".back")?.disabled, next: !!b?.querySelector(".next")?.disabled, open: !!panel && !panel.hidden,
    items: [...(panel?.querySelectorAll(".step") ?? [])].map((el) => { const img = el.querySelector("img"); return { n: el.querySelector(".name b").textContent, label: el.querySelector(".name span").textContent, first: el.parentElement.classList.contains("first"),
      current: el.getAttribute("aria-current") == "step", img: img?.src ?? "", drawn: img?.complete ? img.naturalWidth : 0 }; }) };
})()`
  )) ?? { shown: false, at: "", back: false, next: false, open: false, items: [] };

/** Clicks one of the step controls (".next", ".back", ".toggle"; ".step" with `n`: the list's step n) by script. */
export const clickOn = (page: Page, selector: string, n = 0) =>
  inPage(page, `(${CONTROLS}.querySelectorAll(${JSON.stringify(selector)})[${n}].click(), true)`);

/** Whether one of the step controls shows (takes room on the page). */
export const controlShown = (page: Page, selector: string) =>
  inPage<boolean>(page, `${CONTROLS}.querySelector(${JSON.stringify(selector)}).getClientRects().length > 0`);

/** The bar in full screen: on top where it is (its counter's middle hits it), and faded while the pointer is still. */
export const fullBar = (page: Page) =>
  inPage<{ over: boolean; still: boolean }>(
    page,
    `(() => { const c = ${CONTROLS}, b = c.querySelector(".bar"), r = c.querySelector(".at").getBoundingClientRect();
    return { over: !!c.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".bar"), still: b.classList.contains("still") }; })()`
  );

/** Gives one of the step controls the focus, as a click on it would. */
export const focusOn = (page: Page, selector: string) =>
  inPage(page, `(${CONTROLS}.querySelector(${JSON.stringify(selector)}).focus(), true)`);

/** Scrolls the list to its step n. */
export const scrollToStep = (page: Page, n: number) =>
  inPage(page, `(${CONTROLS}.querySelectorAll(".step")[${n}]?.scrollIntoView({ block: "nearest" }), true)`);

/** Where the document's frame sits in the tab (to turn a point in the page into one for the mouse). */
export const frameAt = (page: Page) =>
  page.evaluate(() => {
    const r = document.getElementById("frame")!.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });

/** Where one of the step controls is in the tab (the middle of it), for the mouse. */
export async function controlAt(page: Page, selector: string) {
  const f = await frameAt(page);
  const r = await inPage<{ x: number; y: number }>(
    page,
    `(() => { const r = ${CONTROLS}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
  );
  return { x: f.x + r.x, y: f.y + r.y };
}

/** Waits until the controls say step n + 1 of `of`, and the page says step n. */
export const atStep = (page: Page, n: number, of: number, what = `step ${n + 1} of ${of}`) =>
  until(
    async () => (await bar(page)).at == `${n + 1} / ${of}` && (await inPage<number>(page, "window.ergaSteps?.current()")) == n,
    5000,
    what
  );

const RAW = { End: 35, ArrowLeft: 37, ArrowRight: 39 } as const;
/**
 * A key as DevTools sends it, with no editing command attached: Playwright on a Mac turns End and the arrows into
 * the Mac's own commands (End scrolls and does not move the caret), as e2e/helpers/editor.ts says.
 */
export async function rawKey(page: Page, key: keyof typeof RAW) {
  const cdp = await page.context().newCDPSession(page);
  const k = { key, code: key, windowsVirtualKeyCode: RAW[key] };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  await cdp.detach();
}

/** Clicks just inside the end of the text of the first visible element that matches `selector` in the page. */
export async function clickTextEnd(page: Page, selector: string, back = 2) {
  const f = await frameAt(page);
  const r = await inPage<{ x: number; y: number }>(
    page,
    `(() => { const g = document.createRange(); g.selectNodeContents([...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent)); const r = g.getBoundingClientRect(); return { x: r.right - ${back}, y: r.top + r.height / 2 }; })()`
  );
  await page.mouse.click(f.x + r.x, f.y + r.y);
  await settle(page);
}

/** A click in the page away from its text, and nothing selected: the page has the keys. */
export async function clickAway(page: Page, x: number, y: number) {
  const f = await frameAt(page);
  await page.mouse.click(f.x + x, f.y + y);
  await settle(page);
}

/** "page" while the page is full screen, the frame over all of it. */
export const full = (page: Page) =>
  page.evaluate(() =>
    document.fullscreenElement == document.documentElement && document.documentElement.classList.contains("erga-full") ? "page" : ""
  );

/**
 * Escape in full screen is the browser's own: a key that DevTools sends never reaches it, so this does what the
 * browser does with it (document.exitFullscreen).
 */
export const escape = (page: Page) => page.evaluate(() => document.exitFullscreen());

/** The frame fills the window, in full screen (not a scrolling page's frame, which starts at the window's top too). */
export const fills = (page: Page) =>
  page.evaluate(() => {
    const r = document.getElementById("frame")!.getBoundingClientRect();
    return (
      document.documentElement.classList.contains("erga-full") &&
      r.left == 0 &&
      r.top == 0 &&
      r.width == innerWidth &&
      r.height == innerHeight
    );
  });
