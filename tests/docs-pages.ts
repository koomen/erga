#!/usr/bin/env bun
// Documents: each document's chevron opens its pages beneath its row, and
// closes them again, the chevron always saying which: for a document with
// pages (tests/fixtures/multi) and for one with none yet ("No other pages
// yet.", with New page and New folder). Open, closed and open again, and
// what's open is kept for the tab across a reload. Screenshots land in
// tests/cdp.ts's SHOTS.
//
//   bun tests/docs-pages.ts

import { cpSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, type Page, SHOTS, ROOT } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const dir = mkdtempSync(join(tmpdir(), "erga-multi-"));
cpSync(join(ROOT, "tests/fixtures/multi"), dir, { recursive: true });
const host = await startHost(dir);
const browser = await Browser.launch();
try {
  const full = ((await (await fetch(`${host.base}/api/doc`)).json()) as { docName: { id: string } }).docName.id;
  const made = (await fetch(`${host.root}/new?template=page`, { redirect: "manual" })).headers.get("location") ?? "";
  expect(made.endsWith("#edit"), "a new document, with no other pages", made);
  const empty = ((await (await fetch(`${host.root}${made.replace(/#edit$/, "")}/api/name`)).json()) as { id: string }).id;

  const p = await browser.page();
  await p.open(`${host.root}/docs`, { width: 1100, height: 760, scale: 2 });
  /** What a document's row shows: whether the chevron says open, it's turned, and its pages show (and how). */
  const state = (id: string) => p.eval<{ expanded: string | null; turned: boolean; shown: boolean; rows: number; text: string }>(`(() => {
    const b = document.querySelector('button.twist[data-id="${id}"]'), sub = document.getElementById("pages-${id}");
    return { expanded: b.getAttribute("aria-expanded"), turned: getComputedStyle(b.querySelector("svg")).transform != "none",
      shown: !!sub && sub.getClientRects().length > 0 && sub.offsetHeight > 0,
      rows: sub ? sub.querySelectorAll(".et-row[data-path]").length : 0, text: sub?.textContent ?? "" };
  })()`);
  const twist = async (id: string) => {
    const r = await p.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('button.twist[data-id="${id}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await p.click(r.x, r.y);
    await Bun.sleep(250); // the chevron turns
  };
  const isOpen = async (id: string, what: string, ready: (s: Awaited<ReturnType<typeof state>>) => boolean) => {
    await until(async () => { const s = await state(id); return s.expanded == "true" && s.turned && s.shown && ready(s); }, 10_000, `${what}: open, its chevron turned down`, () => state(id));
  };
  const isClosed = async (id: string, what: string) => {
    await until(async () => { const s = await state(id); return s.expanded == "false" && !s.turned && !s.shown; }, 3000, `${what}: closed, its chevron pointing right, nothing beneath it`, () => state(id));
  };

  for (const [id, what, ready] of [
    [full, "a document with pages", (s) => s.rows > 0],
    [empty, "a document with no other pages", (s) => /No other pages yet\./.test(s.text) && /New page/.test(s.text) && /New folder/.test(s.text)],
  ] as [string, string, (s: Awaited<ReturnType<typeof state>>) => boolean][]) {
    await isClosed(id, what);
    await twist(id);
    await isOpen(id, what, ready);
    if (id == empty) await p.screenshot(join(SHOTS, "docs-pages-open.png"));
    await twist(id);
    await isClosed(id, what);
    await twist(id);
    await isOpen(id, what + ", again", ready);
    await twist(id);
    await isClosed(id, what + ", again");
    ok(`${what}: the chevron opens and closes its pages, and shows which`);
  }

  // Open one, reload: it stays open for the tab, and still closes.
  await twist(empty);
  await isOpen(empty, "opened before the reload", () => true);
  await p.open(`${host.root}/docs`, { width: 1100, height: 760, scale: 2, clear: false });
  await isOpen(empty, "after the reload", (s) => /No other pages yet\./.test(s.text));
  await isClosed(full, "the other one, after the reload");
  await twist(empty);
  await isClosed(empty, "closed after the reload");
  await p.screenshot(join(SHOTS, "docs-pages-closed.png"));
  ok("what's open is kept for the tab, and it still closes");

  expect(!p.errors.length, "no script errors", p.errors);
  console.log(`\nall passing. Screenshots: ${SHOTS}`);
} finally {
  browser.close();
  await host.dispose();
}
