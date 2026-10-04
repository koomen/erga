#!/usr/bin/env bun
// The viewer's controls fade once the page is scrolled (front.ts, FADE), on a
// document's page (the page in a frame on its own origin) and on the
// homepage (served directly, its controls in a shadow root: home.ts). In both:
//
//   - whole at the top; faded (FADED) once scrolled; whole again at the top;
//   - whole while the pointer is near them (over the band, or over the page
//     in the frame), faded again when it goes;
//   - whole while one of them has keyboard focus, or the account's menu is open;
//   - with prefers-reduced-motion, no transition, the same opacity;
//   - on a phone, faded once scrolled; a tap near them (a touch screen) brings
//     them back until the page scrolls again;
//   - the band behind them keeps its colour, every frame of the fade.
//
//   bun tests/fade.ts            the checks
//   bun tests/fade.ts --shots    and screenshots, in tests/cdp.ts's SHOTS

import { mkdirSync } from "fs";
import { join } from "path";
import { Browser, type Page, ROOT, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";
import { FADED, FADE_NEAR } from "../front";

const keepShots = process.argv.includes("--shots");
const host = await startHost(null);
const browser = await Browser.launch();
const docAddress = new URL(await host.open(join(ROOT, "tests/fixtures/fade"))).pathname.replace(/\/edit$/, "");

type Mode = "doc" | "home";
const ROOT_EXPR: Record<Mode, string> = { doc: "document", home: `document.querySelector("erga-controls").shadowRoot` };
type Rect = { l: number; t: number; r: number; b: number };

/** The controls' opacities, as shown (the computed value, mid-transition too), and their boxes. */
const controls = (p: Page, mode: Mode) => p.eval<{ opacity: number[]; rects: Rect[] }>(`(() => {
  const els = [...${ROOT_EXPR[mode]}.querySelectorAll(".erga-view-buttons > *, .erga-account-btn")];
  return { opacity: els.map((el) => Number(getComputedStyle(el).opacity)),
    rects: els.map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }) };
})()`);
const scrollTop = (p: Page, mode: Mode) => mode == "home" ? p.eval<number>("scrollY") : p.inPage<number>("scrollY").then((a) => a[0] ?? 0);

async function opacityIs(p: Page, mode: Mode, want: number, what: string) {
  let last: number[] = [];
  await until(async () => { last = (await controls(p, mode)).opacity; return last.length >= 2 && last.every((o) => Math.abs(o - want) < 0.01); }, 5000, what, () => JSON.stringify(last));
  console.log(`ok   ${what} (${last.map((o) => o.toFixed(2)).join(", ")})`);
}

const wheel = async (p: Page, x: number, y: number, deltaY: number) => {
  await p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
  await Bun.sleep(150);
  await p.settle();
};

async function shot(p: Page, name: string) {
  if (!keepShots) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = join(SHOTS, `fade-${name}.png`);
  await p.screenshot(file);
  console.log(`shot ${file}`);
}

/** The band's colour at a point clear of the controls, in each of `pngs`. */
function bandColours(p: Page, pngs: string[], x: number, y: number) {
  return p.eval<string[]>(`Promise.all(${JSON.stringify(pngs)}.map(async (b64) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    return [...g.getImageData(${x}, ${y}, 1, 1).data].slice(0, 3).join(",");
  }))`);
}

async function open(mode: Mode, opts: { width?: number; height?: number; reduced?: boolean; touch?: boolean } = {}) {
  const ctx = await browser.context();
  const p = await browser.page(ctx);
  await p.open(`${host.root}${mode == "home" ? "/" : docAddress}`, { width: opts.width, height: opts.height, agent: false });
  if (opts.reduced) await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  if (mode == "home") expect(await p.eval<boolean>(`!!document.querySelector("erga-controls")`), "the homepage is served directly");
  else await until(async () => (await p.inPage<string>(`document.querySelector("h1")?.textContent ?? ""`)).includes("A long page"), 15_000, "the document shows");
  await p.settle();
  return p;
}

async function viewer(mode: Mode) {
  const name = mode == "home" ? "homepage" : "document's page";
  const W = 1300, H = 860;
  const p = await open(mode, { width: W, height: H });
  await opacityIs(p, mode, 1, `${name}: whole at the top`);
  await shot(p, `${mode}-top`);

  // Scrolled: faded, and the band keeps its colour in every frame of the fade.
  const frames: string[] = [];
  p.onEvent("Page.screencastFrame", (f: { data: string; sessionId: number }) => { frames.push(f.data); p.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
  await p.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: W, maxHeight: H });
  const before = (await p.send("Page.captureScreenshot", { format: "png" })).data as string;
  await wheel(p, W / 2, H / 2, 900);
  await opacityIs(p, mode, FADED, `${name}: faded once scrolled`);
  await Bun.sleep(150);
  await p.send("Page.stopScreencast");
  expect((await scrollTop(p, mode)) > 0, `${name}: the page scrolled`);
  const after = (await p.send("Page.captureScreenshot", { format: "png" })).data as string;
  const colours = await bandColours(p, [before, ...frames, after], 24, 20);
  expect(frames.length >= 3 && new Set(colours).size == 1, `${name}: the band keeps its colour through the fade`, { frames: frames.length, colours: [...new Set(colours)] });
  console.log(`ok   ${name}: the band is ${colours[0]} in all ${colours.length} frames`);
  await shot(p, `${mode}-scrolled`);

  // The pointer: near (over the page, below the band, and over the band), then far.
  const { rects } = await controls(p, mode);
  const left = Math.min(...rects.map((r) => r.l)), bottom = Math.max(...rects.map((r) => r.b));
  await p.mouse("mouseMoved", left - 40, bottom + 50);
  await p.settle();
  await opacityIs(p, mode, 1, `${name}: whole with the pointer ${Math.round(Math.hypot(40, 50))}px from them, over the page`);
  await shot(p, `${mode}-scrolled-near`);
  await p.mouse("mouseMoved", left - FADE_NEAR - 60, 20);
  await p.settle();
  await opacityIs(p, mode, FADED, `${name}: faded with the pointer ${FADE_NEAR + 60}px to their left`);
  await p.mouse("mouseMoved", left - 20, 20);
  await p.settle();
  await opacityIs(p, mode, 1, `${name}: whole with the pointer over the band beside them`);
  await p.mouse("mouseMoved", W / 2, H - 100);
  await p.settle();
  await opacityIs(p, mode, FADED, `${name}: faded with the pointer far below`);

  // Keyboard focus: Tab from the first control to the next.
  const R = ROOT_EXPR[mode];
  await p.eval(`${R}.querySelector(".erga-view-buttons > *").focus()`);
  await p.key("Tab");
  await p.settle();
  expect(await p.eval<boolean>(`!!${R}.activeElement?.closest(".erga-view-buttons, .erga-account")`), `${name}: Tab moved focus to a control`);
  await opacityIs(p, mode, 1, `${name}: whole while a control has keyboard focus`);
  await p.eval(`${R}.activeElement.blur()`);
  await opacityIs(p, mode, FADED, `${name}: faded again once focus leaves`);

  // The account's menu open, the pointer far away.
  await p.eval(`${R}.querySelector(".erga-account-btn").click()`);
  await p.settle();
  expect(await p.eval<boolean>(`${R}.querySelector(".erga-account-btn").getAttribute("aria-expanded") == "true"`), `${name}: the account's menu opened`);
  await p.mouse("mouseMoved", W / 2, H - 100);
  await opacityIs(p, mode, 1, `${name}: whole while the account's menu is open`);
  await p.click(W / 2, H - 100);
  await p.eval(`${R}.activeElement?.blur?.()`);
  await opacityIs(p, mode, FADED, `${name}: faded once the menu closes`);

  // Back to the top.
  await wheel(p, W / 2, H / 2, -5000);
  expect((await scrollTop(p, mode)) == 0, `${name}: back at the top`);
  await opacityIs(p, mode, 1, `${name}: whole again at the top`);
  await p.send("Page.close").catch(() => {});
}

async function reduced(mode: Mode) {
  const name = mode == "home" ? "homepage" : "document's page";
  const p = await open(mode, { reduced: true });
  const transition = await p.eval<string>(`getComputedStyle(${ROOT_EXPR[mode]}.querySelector(".erga-view-buttons > *")).transitionProperty`);
  expect(!transition.includes("opacity"), `${name}, reduced motion: no transition on the opacity`, { transition });
  await p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 650, y: 430, deltaX: 0, deltaY: 900 });
  // The first frame after the scroll is heard shows it whole or faded, never between.
  const seen: number[] = [];
  for (let i = 0; i < 12; i++) { seen.push(...(await controls(p, mode)).opacity); await p.eval(`new Promise((r) => requestAnimationFrame(() => r(true)))`); }
  expect(seen.every((o) => Math.abs(o - 1) < 0.01 || Math.abs(o - FADED) < 0.01), `${name}, reduced motion: never between whole and faded`, { seen: [...new Set(seen)] });
  await opacityIs(p, mode, FADED, `${name}, reduced motion: faded once scrolled`);
  await p.send("Page.close").catch(() => {});
}

async function phone(mode: Mode) {
  const name = mode == "home" ? "homepage" : "document's page";
  const W = 390, H = 844;
  const p = await open(mode, { width: W, height: H });
  await p.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await opacityIs(p, mode, 1, `${name}, phone: whole at the top`);
  await wheel(p, W / 2, H / 2, 900);
  await opacityIs(p, mode, FADED, `${name}, phone: faded once scrolled`);
  if (mode == "doc") {
    // A tap near the controls (just below them, on the page) brings them back, until the page scrolls again.
    const { rects } = await controls(p, mode);
    const x = Math.min(...rects.map((r) => r.l)) + 10, y = Math.max(...rects.map((r) => r.b)) + 40;
    const touch = (type: string, pts: { x: number; y: number }[]) => p.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
    await touch("touchStart", [{ x, y }]);
    await touch("touchEnd", []);
    await p.settle();
    await opacityIs(p, mode, 1, `${name}, phone: a tap near them brings them back`);
    await shot(p, `${mode}-phone-tapped`);
    await wheel(p, W / 2, H / 2, 300);
    await opacityIs(p, mode, FADED, `${name}, phone: faded again once the page scrolls`);
    await touch("touchStart", [{ x: W / 2, y: H - 100 }]);
    await touch("touchEnd", []);
    await p.settle();
    await opacityIs(p, mode, FADED, `${name}, phone: a tap far from them leaves them faded`);
  }
  await wheel(p, W / 2, H / 2, -9000);
  await opacityIs(p, mode, 1, `${name}, phone: whole again at the top`);
  await p.send("Page.close").catch(() => {});
}

try {
  // The homepage is served directly once its first deploy is done (the first / starts it).
  await fetch(host.root + "/");
  await until(async () => (await (await fetch(host.root + "/")).text()).includes("<erga-controls"), 20_000, "the homepage is served directly");
  for (const mode of ["doc", "home"] as Mode[]) {
    await viewer(mode);
    await reduced(mode);
    await phone(mode);
  }
  console.log("\nall fade checks passed");
} finally {
  await browser.close();
  await host.dispose();
}
