#!/usr/bin/env bun
// The Solar system tour template (templates/solar-system): made from
// /new?template=solar-system, it's a presentation (DOCUMENT_PROMPT.md,
// "Presentations") of nine steps, the overview and one for each planet,
// viewing and editing alike; going to a step flies the camera there, and the
// list of steps shows the view from each step's camera.
//
//   bun tests/solar-system.ts            the checks
//   bun tests/solar-system.ts --shots    and screenshots, in tests/cdp.ts's SHOTS

import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { Browser, type Page, ROOT, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const keepShots = process.argv.includes("--shots");
const ok = (what: string) => console.log(`ok   ${what}`);
const LABELS = "The solar system|Mercury|Venus|Earth|Mars|Jupiter|Saturn|Uranus|Neptune";

const host = await startHost(null);
const browser = await Browser.launch();

async function shot(p: Page, name: string) {
  if (!keepShots) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = join(SHOTS, `solar-system-${name}.png`);
  await p.screenshot(file);
  console.log(`shot ${file}`);
}
type Bar = { shown: boolean; at: string; items: { label: string; img: string }[] };
const bar = (p: Page) => p.eval<Bar>(`(() => {
  const b = document.querySelector(".erga-steps"), panel = document.querySelector(".erga-steps-panel");
  return { shown: !!b && !b.hidden && getComputedStyle(b).visibility != "hidden", at: b?.querySelector(".erga-steps-at").textContent ?? "",
    items: [...(panel?.querySelectorAll(".erga-step") ?? [])].map((el) => ({ label: el.querySelector(".erga-step-name span").textContent, img: el.querySelector("img")?.src ?? "" })) };
})()`);
const inPage = async <T>(p: Page, expr: string) => (await p.inPage<T>(expr)).find((v) => v != null) as T;
async function atStep(p: Page, n: number, what: string) {
  let last: Bar | null = null;
  await until(async () => { last = await bar(p); return last.at == `${n + 1} / 9` && (await inPage<number>(p, "window.ergaSteps?.current()")) == n; }, 5000, what, () => JSON.stringify(last));
  ok(what);
}
/** What the page shows: the note on screen, and a few of the canvas's pixels (to tell the camera moved). */
const view = (p: Page) => inPage<{ note: string; pixels: string }>(p, `(() => {
  const c = document.getElementById("space"), d = document.createElement("canvas");
  d.width = 16; d.height = 9; d.getContext("2d").drawImage(c, 0, 0, 16, 9);
  return { note: [...document.querySelectorAll(".note")].filter((n) => !n.hidden).map((n) => n.querySelector("h1").textContent).join(),
    pixels: [...d.getContext("2d").getImageData(0, 0, 16, 9).data].join() };
})()`);

let failed = false;
try {
  const made = await fetch(host.root + "/new?template=solar-system", { redirect: "manual" });
  const at = made.headers.get("location")!;
  expect(made.status == 302 && at.endsWith("#edit"), "/new?template=solar-system opens a new document in the editor", at);
  const id = ((await (await fetch(`${host.root}${at.replace(/#edit$/, "")}/api/name`)).json()) as { id: string }).id;
  expect((await (await fetch(`${host.root}/d/${id}/doc/index.html`)).text()) == readFileSync(join(ROOT, "templates/solar-system/index.html"), "utf8"), "the document is templates/solar-system");
  ok("/new?template=solar-system makes the document");

  const p = await browser.page(await browser.context());
  // Viewing.
  await p.open(host.root + at.replace(/#edit$/, ""), { agent: false, width: 1200, height: 760 });
  await until(async () => (await bar(p)).shown, 15_000, "the step controls show");
  await atStep(p, 0, "viewing: nine steps, at the overview");
  await Bun.sleep(300);
  const a = await view(p);
  await Bun.sleep(400);
  expect(a.note == "The solar system" && (await view(p)).pixels != a.pixels, "the overview shows its note, and the planets move", a.note);
  ok("viewing: the overview's note shows, and the model moves");
  await shot(p, "overview");

  for (let k = 1; k <= 3; k++) await p.eval(`document.querySelector(".erga-steps-next").click()`), await Bun.sleep(150);
  await atStep(p, 3, "viewing: forward three times goes to Earth");
  const mid = await view(p);
  await Bun.sleep(700);
  const later = await view(p);
  expect(mid.note == "Earth" && later.pixels != mid.pixels, "the Earth's note shows, and the camera flies there", mid.note);
  await Bun.sleep(1800);
  ok("viewing: Earth's step shows its note while the camera flies to it");
  await shot(p, "earth");

  await p.eval(`document.querySelector(".erga-steps-toggle").click()`);
  let b: Bar = await bar(p);
  // (It asks for the pictures of the steps in sight: scrolled down, the rest.)
  await until(async () => { b = await bar(p); return b.items.length == 9 && b.items.slice(0, 5).every((i) => i.img.startsWith("blob:")); }, 8000, "the list shows the pictures in sight", () => JSON.stringify(b));
  await p.eval(`document.querySelector(".erga-steps-panel").scrollTop = 1e6, document.querySelector(".erga-steps-panel").dispatchEvent(new Event("scroll"))`);
  await until(async () => { b = await bar(p); return b.items.every((i) => i.img.startsWith("blob:")); }, 8000, "scrolled down, the list shows all nine pictures", () => JSON.stringify(b));
  await p.eval(`document.querySelector(".erga-steps-panel").scrollTop = 0`);
  expect(b.items.map((i) => i.label).join("|") == LABELS, "the list labels each step", b.items.map((i) => i.label));
  // Each picture is the view from its own camera: no two the same.
  const sums = await p.eval<string[]>(`Promise.all([...document.querySelectorAll(".erga-steps-panel .erga-step img")].map((img) => fetch(img.src).then((r) => r.arrayBuffer()).then((b) => b.byteLength + ":" + new Uint8Array(b).slice(-64).join(""))))`);
  expect(new Set(sums).size == 9, "each step's picture is a different view", sums.length);
  ok("viewing: the list has the nine steps, each with the view from its camera");
  await shot(p, "list");
  await p.eval(`document.querySelectorAll(".erga-step")[6].click()`);
  await atStep(p, 6, "viewing: a click in the list goes to Saturn");
  await p.eval(`document.querySelector(".erga-steps-toggle").click()`);
  await Bun.sleep(2200);
  await shot(p, "saturn");

  // Editing.
  await p.open(`${host.root}${at}`, { agent: false, clear: false, width: 1200, height: 760 });
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready")`), 20_000, "the editor is ready");
  await until(async () => (await bar(p)).shown, 10_000, "the step controls show in the editor");
  await p.eval(`document.querySelector(".erga-steps-next").click()`);
  await atStep(p, 1, "editing: forward goes to Mercury");
  expect((await view(p)).note == "Mercury", "editing: Mercury's note shows");
  await Bun.sleep(2000);
  await shot(p, "edit-mercury");
  ok("editing: the steps work, and the notes show");
  if (p.errors.length) throw new Error("errors on the page: " + p.errors.join("\n"));
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  browser.close();
  await host.dispose();
}
process.exit(failed ? 1 : 0);
