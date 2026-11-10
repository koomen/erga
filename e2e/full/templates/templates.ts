// Helpers for the presentation tests: documents made from a
// template, opened in the viewer or the editor, and the step controls over
// them, which the page draws itself (libs/steps/ui/steps.ts: <erga-steps>'s shadow root).
//
// The document's page runs in a frame: in the viewer the viewer's frame itself
// (inline, an opaque origin), in the editor the host page's visible frame on the
// document's own origin (iframe.on, server/pages/viewer.ts). `inPage`
// evaluates an expression in that page.

import type { Page } from "playwright-core";
import { settle, until, type Server, type Tab } from "../../helpers/fixtures";

/** Makes a document from a template (/new?template=<id>): the answer, and the document's address (no ?edit). */
export async function newDoc(server: Server, template: string) {
  const r = await fetch(`${server.root}/new?template=${template}`, { redirect: "manual" });
  const location = r.headers.get("location") ?? "";
  return { status: r.status, location, address: server.root + location.replace(/[?&]edit=?$/, "") };
}

/** The document's id, from its address. */
export { idOf } from "../../helpers/tools";

/**
 * Opens a URL in the test's tab, as someone who keeps the agent pane closed (it opens by itself in the editor
 * otherwise, sliding the page over), at a window size; the page's errors fail the test.
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
    } catch { /* no storage */ }
  });
  await page.goto(url);
  await settle(page);
}

/** The editor is in and ready. */
export const editorReady = (page: Page) =>
  until(
    // (And its half in the page, which starts after the shell's: a click before it is there loses the caret to its start.)
    async () =>
      (await page.evaluate(() => document.body.classList.contains("erga-editor-ready"))) &&
      (await inPage<boolean>(page, "!!window.ergaFrame?.page")),
    10_000,
    "the editor is ready"
  );

/** Evaluates an expression in the document's page (whichever frame shows it): the first answer that isn't null. */
export async function inPage<T = any>(page: Page, expr: string): Promise<T> {
  const wrapped = `(() => { if (parent == top && !document.querySelector('meta[name="erga-shell"]')) return window.eval(${JSON.stringify(expr)}); const w = document.querySelector("iframe.on")?.contentWindow; return w ? w.eval(${JSON.stringify(expr)}) : null; })()`;
  for (const f of page.frames()) {
    if (f == page.mainFrame()) continue;
    const v = await f.evaluate(wrapped).catch(() => null);
    if (v != null) return v as T;
  }
  return null as T;
}

export type Bar = {
  shown: boolean; at: string; back: boolean; next: boolean; open: boolean;
  items: { n: string; label: string; current: boolean; img: string; drawn: number; first: boolean }[];
};

/** The step controls in the page (<erga-steps>'s shadow root), as an expression in the page. */
const CONTROLS = `document.querySelector("erga-steps")?.shadowRoot`;

/** The step controls: shown, the step they say, back and forward disabled, the list open, and its steps. */
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

/** Clicks one of the step controls (".next", ".back", ".toggle", ".exit"; ".step" with `n`: the list's step n) by script. */
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
  until(async () => (await bar(page)).at == `${n + 1} / ${of}` && (await inPage<number>(page, "window.ergaSteps?.current()")) == n, 5000, what);

const RAW = { End: 35, ArrowLeft: 37, ArrowRight: 39 } as const;
/**
 * A key as DevTools sends it, with no editing command attached: Playwright on a Mac turns End and the arrows into
 * the Mac's own commands (End scrolls instead of moving the caret), as e2e/helpers/editor.ts says.
 */
export async function rawKey(page: Page, key: keyof typeof RAW) {
  const cdp = await page.context().newCDPSession(page);
  const k = { key, code: key, windowsVirtualKeyCode: RAW[key] };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  await cdp.detach();
}

/** Where the document's frame sits in the tab (to turn a point in the page into one for the mouse). */
export const frameAt = (page: Page) => page.evaluate(() => {
  const r = document.getElementById("frame")!.getBoundingClientRect();
  return { x: r.left, y: r.top };
});

/** Clicks just inside the end of the text of the first visible element matching `selector` in the page. */
export async function clickTextEnd(page: Page, selector: string, back = 2) {
  const f = await frameAt(page);
  const r = await inPage<{ x: number; y: number }>(page, `(() => { const g = document.createRange(); g.selectNodeContents([...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent)); const r = g.getBoundingClientRect(); return { x: r.right - ${back}, y: r.top + r.height / 2 }; })()`);
  await page.mouse.click(f.x + r.x, f.y + r.y);
  await settle(page);
}
