// Helpers for the presentation tests (e2e/templates): documents made from a
// template, opened in the viewer or the editor, and the step controls under
// them (front.ts, STEPS_BOOT; DOCUMENT_PROMPT.md, "Presentations").
//
// The document's page runs in a frame on its own origin: in the viewer the
// host page's visible frame (iframe.on, front.ts), in the editor the page
// editor's frame. `inPage` evaluates an expression in that page.

import type { Page } from "playwright-core";
import { settle, until, type Server, type Tab } from "../../fixtures";

/** Makes a document from a template (/new?template=<id>): the answer, and the document's address (no #edit). */
export async function newDoc(server: Server, template: string) {
  const r = await fetch(`${server.root}/new?template=${template}`, { redirect: "manual" });
  const location = r.headers.get("location") ?? "";
  return { status: r.status, location, address: server.root + location.replace(/#edit$/, "") };
}

/** The document's id, from its address. */
export const idOf = async (address: string) => ((await (await fetch(`${address.replace(/#edit$/, "")}/api/name`)).json()) as { id: string }).id;

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

/** The editor is in and ready (front.ts, ergaShell.ready). */
export const editorReady = (page: Page) => until(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready")), 10_000, "the editor is ready");

/** Evaluates an expression in the document's page (whichever frame shows it): the first answer that isn't null. */
export async function inPage<T = any>(page: Page, expr: string): Promise<T> {
  const wrapped = `(() => { const w = document.querySelector("iframe.on")?.contentWindow; return w ? w.eval(${JSON.stringify(expr)}) : null; })()`;
  for (const f of page.frames()) {
    if (f == page.mainFrame()) continue;
    const v = await f.evaluate(wrapped).catch(() => null);
    if (v != null) return v as T;
  }
  return null as T;
}

export type Bar = {
  shown: boolean; at: string; back: boolean; next: boolean; open: boolean;
  items: { label: string; current: boolean; img: string; drawn: number }[];
};

/** The step controls: shown, the step they say, back and forward disabled, the list open, and its steps. */
export const bar = (page: Page) => page.evaluate(`(() => {
  const b = document.querySelector(".erga-steps"), panel = document.querySelector(".erga-steps-panel");
  return { shown: !!b && !b.hidden && getComputedStyle(b).visibility != "hidden", at: b?.querySelector(".erga-steps-at").textContent ?? "",
    back: !!b?.querySelector(".erga-steps-back")?.disabled, next: !!b?.querySelector(".erga-steps-next")?.disabled, open: !!panel && !panel.hidden,
    items: [...(panel?.querySelectorAll(".erga-step") ?? [])].map((el) => { const img = el.querySelector("img"); return { label: el.querySelector(".erga-step-name span").textContent,
      current: el.getAttribute("aria-current") == "step", img: img?.src ?? "", drawn: img?.complete ? img.naturalWidth : 0 }; }) };
})()`) as Promise<Bar>;

/** Clicks an element of the shell (the step controls) by selector. */
export const clickOn = (page: Page, selector: string) => page.evaluate((s) => (document.querySelector(s) as HTMLElement).click(), selector);

/** Waits until the controls say step n + 1 of `of`, and the page says step n. */
export const atStep = (page: Page, n: number, of: number, what = `step ${n + 1} of ${of}`) =>
  until(async () => (await bar(page)).at == `${n + 1} / ${of}` && (await inPage<number>(page, "window.ergaSteps?.current()")) == n, 5000, what);

const RAW = { End: 35, ArrowLeft: 37, ArrowRight: 39 } as const;
/**
 * A key as DevTools sends it, with no editing command attached: Playwright on a Mac turns End and the arrows into
 * the Mac's own commands (End scrolls instead of moving the caret), as e2e/editor.ts says.
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
