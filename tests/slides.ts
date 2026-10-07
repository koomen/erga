#!/usr/bin/env bun
// The Slides template (templates/slides, the Presentation group in
// templates.ts), made with /new?template=slides, viewing and editing:
//
//   - two 16:9 slides, one at a time, as large as the window allows (at two
//     window sizes);
//   - one step for each slide (window.ergaSteps), labelled with its title:
//     the buttons and the arrow keys step through them;
//   - the list of steps shows each slide drawn small (its image()), and a
//     click there goes to that slide; an edit to a title shows in the list.
//
//   bun tests/slides.ts            the checks
//   bun tests/slides.ts --shots    and screenshots, in tests/cdp.ts's SHOTS
// covers: templates/slides/ templates.ts front.ts

import { mkdirSync } from "fs";
import { join } from "path";
import { Browser, type Page, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const keepShots = process.argv.includes("--shots");
const host = await startHost(null);
const browser = await Browser.launch();
const ok = (what: string) => console.log(`ok   ${what}`);
const LABELS = "Untitled presentation|Second slide";

async function shot(p: Page, name: string) {
  if (!keepShots) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = join(SHOTS, `slides-${name}.png`);
  await p.screenshot(file);
  console.log(`shot ${file}`);
}

type Bar = { shown: boolean; at: string; open: boolean; items: { label: string; current: boolean; img: string; drawn: number }[] };
const bar = (p: Page) => p.eval<Bar>(`(() => {
  const b = document.querySelector(".erga-steps"), panel = document.querySelector(".erga-steps-panel");
  return { shown: !!b && !b.hidden && getComputedStyle(b).visibility != "hidden", at: b?.querySelector(".erga-steps-at").textContent ?? "",
    open: !!panel && !panel.hidden,
    items: [...(panel?.querySelectorAll(".erga-step") ?? [])].map((el) => { const img = el.querySelector("img"); return { label: el.querySelector(".erga-step-name span").textContent,
      current: el.getAttribute("aria-current") == "step", img: img?.src ?? "", drawn: img?.complete ? img.naturalWidth : 0 }; }) };
})()`);
const pageAt = async (p: Page) => (await p.inPage<number>("ergaSteps.current()")).find((n) => n != null);
async function atStep(p: Page, n: number, what: string) {
  let last: Bar | null = null;
  await until(async () => { last = await bar(p); return last.at == `${n + 1} / 2` && (await pageAt(p)) == n; }, 5000, what, () => JSON.stringify(last));
  ok(what);
}
const click = (p: Page, sel: string) => p.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
/** The slide shown: its size, its place in the frame, and the frame's size. */
const slide = async (p: Page) => (await p.inPage<{ w: number; h: number; x: number; y: number; vw: number; vh: number; shown: number } | null>(`(() => {
  const all = [...document.querySelectorAll(".slide")], s = all.find((e) => !e.hidden);
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { w: r.width, h: r.height, x: r.left, y: r.top, vw: innerWidth, vh: innerHeight, shown: all.filter((e) => e.getClientRects().length).length };
})()`)).find(Boolean)!;
function fits(s: Awaited<ReturnType<typeof slide>>, where: string) {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
  expect(s && s.shown == 1 && near(s.w / s.h, 16 / 9) && (near(s.w, s.vw) || near(s.h, s.vh)) && s.w <= s.vw + 1 && s.h <= s.vh + 1
    && near(s.x, (s.vw - s.w) / 2) && near(s.y, (s.vh - s.h) / 2), `${where}: one 16:9 slide, as large as the frame allows, in the middle`, s);
}
async function list(p: Page, where: string) {
  if (!(await bar(p)).open) await click(p, ".erga-steps-toggle");
  let b: Bar | null = null;
  await until(async () => { b = await bar(p); return b.open && b.items.length == 2 && b.items.every((i) => i.img.startsWith("blob:") && i.drawn > 0); }, 8000, `${where}: the list shows each slide drawn small`, () => JSON.stringify(b));
  expect(b!.items.map((i) => i.label).join("|") == LABELS, `${where}: the list has each slide's title`, b);
  ok(`${where}: the list shows both slides drawn small, with their titles`);
  return b!;
}

let failed = false;
try {
  const made = await fetch(host.root + "/new?template=slides", { redirect: "manual" });
  const address = made.headers.get("location")!.replace(/#edit$/, "");
  expect(made.status == 302, "/new?template=slides makes a document", made.status);
  const p = await browser.page(await browser.context());

  // Viewing.
  await p.open(`${host.root}${address}`, { agent: false, width: 1200, height: 800 });
  await until(async () => (await bar(p)).shown, 15_000, "the step controls show");
  await atStep(p, 0, "viewing: the controls show 1 / 2");
  fits(await slide(p), "viewing, 1200 × 800");
  await shot(p, "view");
  await click(p, ".erga-steps-next");
  await atStep(p, 1, "viewing: forward goes to slide 2");
  await p.key("ArrowLeft");
  await atStep(p, 0, "viewing: ← goes back to slide 1");
  await p.key("ArrowRight");
  await atStep(p, 1, "viewing: → goes to slide 2");
  await list(p, "viewing");
  await shot(p, "view-list");
  await p.eval(`document.querySelectorAll(".erga-step")[0].click()`);
  await atStep(p, 0, "viewing: a click in the list goes to slide 1");
  // A tall, narrow window: the slide takes its width.
  await p.open(`${host.root}${address}`, { agent: false, width: 600, height: 900, clear: false });
  await until(async () => (await bar(p)).shown, 15_000, "the step controls show");
  fits(await slide(p), "viewing, 600 × 900");

  // Editing.
  await p.open(`${host.root}${address}#edit`, { agent: false, width: 1200, height: 800, clear: false });
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready")`), 20_000, "the editor is ready");
  await until(async () => (await bar(p)).shown && (await pageAt(p)) == 0, 10_000, "the step controls show in the editor");
  fits(await slide(p), "editing");
  await click(p, ".erga-steps-next");
  await atStep(p, 1, "editing: forward goes to slide 2");
  await click(p, ".erga-steps-back");
  await atStep(p, 0, "editing: back goes to slide 1");
  await p.inPage("document.activeElement.blur(), getSelection().removeAllRanges()");
  await p.key("ArrowRight");
  await atStep(p, 1, "editing: → outside the text goes to slide 2");
  const before = await list(p, "editing");
  await shot(p, "edit-list");
  // Type into the second slide's title: the list's label and picture follow.
  const f = await p.eval<{ x: number; y: number }>(`(() => { const r = document.getElementById("frame").getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  const r = (await p.inPage<{ x: number; y: number }>(`(() => { const g = document.createRange(); g.selectNodeContents([...document.querySelectorAll("h2")].find((e) => e.offsetParent)); const r = g.getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 }; })()`)).find(Boolean)!;
  await p.click(f.x + r.x, f.y + r.y);
  await p.settle();
  await p.key("End");
  await p.type("!");
  let b: Bar | null = null;
  await until(async () => { b = await bar(p); return b.items[1]?.label == "Second slide!" && b.items[1].img.startsWith("blob:") && b.items[1].img != before.items[1].img && b.items[1].drawn > 0; }, 8000,
    "after an edit, the list has the new title and a new picture", () => JSON.stringify(b));
  ok("editing: after an edit to a title, the list shows the new title and draws the slide afresh");
  if (p.errors.length) throw new Error("errors on the page: " + p.errors.join("\n"));
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  browser.close();
  await host.stop();
}
process.exit(failed ? 1 : 0);
