#!/usr/bin/env bun
// A presentation's steps (DOCUMENT_PROMPT.md, "Presentations"; front.ts,
// STEPS_BOOT and HOST_SCRIPT), on a document's page, viewing and editing:
//
//   - a page with window.ergaSteps gets back and forward under it, and the
//     step it's at; a page without has none;
//   - the buttons, the arrow keys (in the page and on the controls) and a
//     click in the list of steps go to a step, and the page says so back;
//   - the list shows the page's own pictures of its steps, keeps them while
//     the page stays the same, and draws them afresh after an edit;
//   - the arrow keys in text being edited move the caret, not the step.
//
//   bun tests/steps.ts            the checks
//   bun tests/steps.ts --shots    and screenshots, in tests/cdp.ts's SHOTS

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, type Page, ROOT, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const keepShots = process.argv.includes("--shots");
const host = await startHost(null);
const browser = await Browser.launch();
const ok = (what: string) => console.log(`ok   ${what}`);

async function shot(p: Page, name: string) {
  if (!keepShots) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = join(SHOTS, `steps-${name}.png`);
  await p.screenshot(file);
  console.log(`shot ${file}`);
}

type Bar = { shown: boolean; at: string; back: boolean; next: boolean; open: boolean; items: { label: string; current: boolean; img: string }[] };
const bar = (p: Page) => p.eval<Bar>(`(() => {
  const b = document.querySelector(".erga-steps"), panel = document.querySelector(".erga-steps-panel");
  return { shown: !!b && !b.hidden && getComputedStyle(b).visibility != "hidden", at: b?.querySelector(".erga-steps-at").textContent ?? "",
    back: !!b?.querySelector(".erga-steps-back").disabled, next: !!b?.querySelector(".erga-steps-next").disabled, open: !!panel && !panel.hidden,
    items: [...(panel?.querySelectorAll(".erga-step") ?? [])].map((el) => ({ label: el.querySelector(".erga-step-name span").textContent,
      current: el.getAttribute("aria-current") == "step", img: el.querySelector("img")?.src ?? "" })) };
})()`);
const pageAt = async (p: Page) => (await p.inPage<number>("ergaSteps.current()")).find((n) => n != null);
async function atStep(p: Page, n: number, what: string) {
  let last: Bar | null = null;
  await until(async () => { last = await bar(p); return last.at == `${n + 1} / 4` && (await pageAt(p)) == n; }, 5000, what, () => JSON.stringify(last));
  ok(what);
}
const click = (p: Page, sel: string) => p.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
/** Clicks the page itself, in the frame, away from its text. */
async function clickPage(p: Page) {
  const r = await p.eval<{ x: number; y: number }>(`(() => { const r = document.getElementById("frame").getBoundingClientRect(); return { x: r.left + 30, y: r.top + 30 }; })()`);
  await p.click(r.x, r.y);
  await p.settle();
}

// A copy: the edit below is saved to the document's folder.
const dir = mkdtempSync(join(tmpdir(), "erga-steps-"));
cpSync(join(ROOT, "tests/fixtures/steps"), dir, { recursive: true });
const address = new URL(await host.open(dir)).pathname.replace(/\/edit$/, "");
const plain = new URL(await host.open(join(ROOT, "tests/fixtures/fade"))).pathname.replace(/\/edit$/, "");
let failed = false;
try {
  const p = await browser.page(await browser.context());

  // A page without steps: no controls.
  await p.open(`${host.root}${plain}`, { agent: false });
  await until(async () => (await p.inPage<string>(`document.querySelector("h1")?.textContent ?? ""`)).some((t) => t), 15_000, "the plain document shows");
  await Bun.sleep(800);
  expect(!(await bar(p)).shown, "a page without steps has no step controls");
  ok("a page without steps has no step controls");

  // Viewing.
  await p.open(`${host.root}${address}`, { agent: false });
  await until(async () => (await bar(p)).shown, 15_000, "the step controls show");
  let b = await bar(p);
  expect(b.at == "1 / 4" && b.back && !b.next, "at the first step, back off", b);
  ok("viewing: the controls show 1 / 4, back off");
  await shot(p, "view");
  await click(p, ".erga-steps-next");
  await atStep(p, 1, "viewing: forward goes to step 2");
  await clickPage(p);
  await p.key("ArrowRight");
  await atStep(p, 2, "viewing: → in the page goes to step 3");
  await p.eval(`document.querySelector(".erga-steps-back").focus()`);
  await p.key("ArrowLeft");
  await atStep(p, 1, "viewing: ← on the controls goes back to step 2");
  await p.inPage("ergaSteps.go(3)");
  await atStep(p, 3, "viewing: the page going to step 4 itself shows on the controls");
  expect((await bar(p)).next, "at the last step, forward off");

  // The list, with the page's own pictures.
  await click(p, ".erga-steps-toggle");
  let first: string[] = [];
  await until(async () => { b = await bar(p); first = b.items.map((i) => i.img); return b.open && b.items.length == 4 && first.every((s) => s.startsWith("blob:")); }, 5000, "the list shows the page's pictures", () => JSON.stringify(b));
  expect(b.items.map((i) => i.label).join("|") == "Owls at night|Where they live|What they eat|How to see one" && b.items[3].current, "the list has each step's label, the current one marked", b);
  ok("the list shows four steps with their labels and the page's pictures");
  await shot(p, "view-list");
  await p.eval(`document.querySelectorAll(".erga-step")[0].click()`);
  await atStep(p, 0, "a click in the list goes to step 1");
  await click(p, ".erga-steps-toggle");
  await click(p, ".erga-steps-toggle");
  await Bun.sleep(600);
  b = await bar(p);
  expect(b.open && b.items.map((i) => i.img).join() == first.join(), "the pictures are kept while the page stays the same", { first, now: b.items.map((i) => i.img) });
  ok("closed and opened again, the list keeps the same pictures");

  // Editing.
  await p.open(`${host.root}${address}#edit`, { agent: false, clear: false });
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready")`), 20_000, "the editor is ready");
  await until(async () => (await bar(p)).shown && (await pageAt(p)) == 0, 10_000, "the step controls show in the editor");
  ok("editing: the controls show");
  await click(p, ".erga-steps-next");
  await atStep(p, 1, "editing: forward goes to step 2");
  // A click in the page puts the caret in the nearest text: out of it, the page has the keys.
  await clickPage(p);
  await p.inPage("document.activeElement.blur(), getSelection().removeAllRanges()");
  await p.key("ArrowRight");
  await atStep(p, 2, "editing: → in the page, outside its text, goes to step 3");
  // Into the heading's text: the arrows move the caret there.
  const h = await p.eval<{ x: number; y: number }>(`(async () => {
    const f = document.getElementById("frame").getBoundingClientRect();
    return { x: f.left + 1, y: f.top + 1 };
  })()`);
  const r = (await p.inPage<{ x: number; y: number }>(`(() => { const g = document.createRange(); g.selectNodeContents([...document.querySelectorAll("h1")].find((e) => e.offsetParent)); const r = g.getBoundingClientRect(); return { x: r.right - 4, y: r.top + r.height / 2 }; })()`)).find(Boolean)!;
  await p.click(h.x + r.x, h.y + r.y);
  await p.settle();
  await p.key("ArrowLeft");
  await Bun.sleep(400);
  expect((await pageAt(p)) == 2 && (await bar(p)).at == "3 / 4", "← in the text being edited stays on the step", { at: await pageAt(p), r, h, active: await p.inPage("[document.activeElement.tagName, document.activeElement.isContentEditable, getSelection().anchorNode?.textContent]") });
  ok("editing: ← in the heading's text moves the caret, not the step");

  // (Still open from viewing: the same page, gone into the editor.)
  if (!(await bar(p)).open) await click(p, ".erga-steps-toggle");
  let before: string[] = [];
  await until(async () => { b = await bar(p); before = b.items.map((i) => i.img); return before.every((s) => s.startsWith("blob:")); }, 5000, "editing: the list shows the pictures", () => JSON.stringify(b));
  ok("editing: the list shows the page's pictures");
  await p.type("s");
  await until(async () => { b = await bar(p); return b.items[2].label.length == 14 && b.items[2].label != "What they eat" && b.items.every((i, k) => i.img.startsWith("blob:") && i.img != before[k]); }, 5000,
    "after an edit, the list has the new label and new pictures", () => JSON.stringify(b));
  ok("editing: after an edit, the list shows the new label and draws the pictures afresh");
  await shot(p, "edit-list");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  browser.close();
  await host.stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
