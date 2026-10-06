#!/usr/bin/env bun
// The Canvas presentation template (templates/canvas, templates.ts): frames
// on one large canvas, each a step of the presentation contract
// (DOCUMENT_PROMPT.md, "Presentations"), viewing and editing:
//
//   - /new?template=canvas makes it; the step controls show 1 / 4, with each
//     frame's heading as its label and a picture of each frame;
//   - going to the next step zooms out to show the whole canvas, then in on
//     the next frame, which ends in the middle of the window;
//   - in the editor the steps work the same, and the frames' text is editable.
//
//   bun tests/canvas-template.ts            the checks
//   bun tests/canvas-template.ts --shots    and screenshots, in tests/cdp.ts's SHOTS

import { mkdirSync } from "fs";
import { join } from "path";
import { Browser, type Page, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";
import { templateById } from "../templates";

const keepShots = process.argv.includes("--shots");
const ok = (what: string) => console.log(`ok   ${what}`);
const LABELS = "One big canvas|Zoom out, zoom in|Make it yours|Add a frame";

async function shot(p: Page, name: string) {
  if (!keepShots) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = join(SHOTS, `canvas-${name}.png`);
  await p.screenshot(file);
  console.log(`shot ${file}`);
}
const bar = (p: Page) => p.eval<{ shown: boolean; at: string; items: { label: string; img: string }[] }>(`(() => {
  const b = document.querySelector(".erga-steps"), panel = document.querySelector(".erga-steps-panel");
  return { shown: !!b && !b.hidden, at: b?.querySelector(".erga-steps-at").textContent ?? "",
    items: [...(panel?.querySelectorAll(".erga-step") ?? [])].map((el) => ({ label: el.querySelector(".erga-step-name span").textContent, img: el.querySelector("img")?.src ?? "" })) };
})()`);
const inPage = async <T>(p: Page, js: string) => (await p.inPage<T>(js)).find((v) => v != null) as T;
/** The camera's zoom, and where the current frame's middle is against the window's (0, 0 when centred). */
const camera = (p: Page) => inPage<{ s: number; dx: number; dy: number; at: number } | null>(p, `window.ergaSteps && document.querySelector(".canvas") ? (() => {
  const m = new DOMMatrix(getComputedStyle(document.querySelector(".canvas")).transform), f = document.querySelector(".frame.current").getBoundingClientRect();
  return { s: m.a, dx: Math.round(f.left + f.width / 2 - innerWidth / 2), dy: Math.round(f.top + f.height / 2 - innerHeight / 2), at: ergaSteps.current() };
})() : null`);

/** Goes forward one step, sampling the zoom on the way: it must drop below both ends (the whole canvas), and end on the frame, centred. */
async function flies(p: Page, from: number, where: string) {
  const start = (await camera(p))!;
  await p.eval(`document.querySelector(".erga-steps-next").click()`);
  let least = start.s, end = start;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const c = await camera(p);
    if (c) { least = Math.min(least, c.s); end = c; }
    if (c && c.at == from + 1 && Date.now() - t0 > 1700) break;
    await Bun.sleep(40);
  }
  expect(end.at == from + 1 && (await bar(p)).at == `${from + 2} / 4`, `${where}: forward goes to frame ${from + 2}`, { end, bar: await bar(p) });
  expect(least < start.s * 0.6 && least < end.s * 0.6, `${where}: on the way, the camera zooms out to the whole canvas`, { start: start.s, least, end: end.s });
  expect(Math.abs(end.dx) <= 2 && Math.abs(end.dy) <= 2, `${where}: it ends on frame ${from + 2}, in the middle of the window`, end);
  ok(`${where}: forward zooms out (×${start.s.toFixed(2)} → ×${least.toFixed(2)}), then in on frame ${from + 2} (×${end.s.toFixed(2)}), centred`);
}

const host = await startHost(null);
const browser = await Browser.launch();
let failed = false;
try {
  expect(templateById("canvas")?.group == "Presentation", "the template is in the Presentation group");
  const made = await fetch(host.root + "/new?template=canvas", { redirect: "manual" });
  const at = made.headers.get("location")!.replace(/#edit$/, "");
  expect(made.status == 302, "/new?template=canvas makes a document", made.status);
  ok("/new?template=canvas makes a document, in the Presentation group");

  const p = await browser.page(await browser.context());
  // Viewing.
  await p.open(host.root + at, { width: 1100, height: 720, agent: false });
  await until(async () => (await bar(p)).shown && (await bar(p)).at == "1 / 4", 15_000, "the step controls show 1 / 4");
  let c = (await camera(p))!;
  expect(c.at == 0 && Math.abs(c.dx) <= 2 && Math.abs(c.dy) <= 2, "it opens on frame 1, centred", c);
  ok("viewing: the controls show 1 / 4, and frame 1 fills the window");
  await shot(p, "view");
  await p.eval(`document.querySelector(".erga-steps-toggle").click()`);
  let b = await bar(p);
  await until(async () => { b = await bar(p); return b.items.length == 4 && b.items.every((i) => i.img.startsWith("blob:")); }, 8000, "the list shows a picture of each frame", () => JSON.stringify(b));
  expect(b.items.map((i) => i.label).join("|") == LABELS, "each step is labelled with its frame's heading", b);
  ok("viewing: the list has four steps, labelled, each with a picture of its frame");
  await shot(p, "view-list");
  await p.eval(`document.querySelector(".erga-steps-toggle").click()`);
  await flies(p, 0, "viewing");
  await flies(p, 1, "viewing");
  await shot(p, "view-3");

  // Editing.
  await p.open(`${host.root}${at}#edit`, { width: 1100, height: 720, agent: false, clear: false });
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready")`), 20_000, "the editor is ready");
  await until(async () => (await bar(p)).shown && (await camera(p))?.at == 0, 10_000, "the step controls show in the editor");
  ok("editing: the controls show");
  await flies(p, 0, "editing");
  const editable = await inPage<boolean>(p, `(() => { const h = document.querySelector(".frame.current h2"); return h ? h.isContentEditable : null; })()`);
  expect(editable, "the current frame's heading is editable", editable);
  ok("editing: the frames' text is editable");
  await shot(p, "edit");
  if (p.errors.length) throw new Error("errors on the page: " + p.errors.join("\n"));
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  browser.close();
  await host.stop();
}
process.exit(failed ? 1 : 0);
