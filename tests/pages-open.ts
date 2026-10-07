#!/usr/bin/env bun
// How fast the editor's pages dropdown (the document's title, top left) opens
// the first time, in headless Chrome, against the real server on
// tests/fixtures/multi, with 100 ms of network latency added (as a real
// connection has). It times from the click to the tree's rows on screen:
//
//   - first open, clicked with no hover first (a keyboard, a touch): the worst case;
//   - first open after the pointer rests on the title for 150 ms;
//   - first open on the next page of the same tab (each page is a page load).
//
// Each case on a fresh editor load, a few seconds after it's up. It checks the
// numbers stay under a bound, and prints them.
//
//   bun tests/pages-open.ts
// covers: src/page/tree.ts tree.ts front.ts

import { cpSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, type Page, ROOT } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const dir = mkdtempSync(join(tmpdir(), "erga-multi-"));
cpSync(join(ROOT, "tests/fixtures/multi"), dir, { recursive: true });
const host = await startHost(dir);
const browser = await Browser.launch();
const editor = (u: string) => u.replace(/#.*$/, "") + "#edit";
const LATENCY = 100;
const info = (await (await fetch(`${host.base}/api/doc`)).json()) as { docName: { address: string } };

/** The editor, up, with latency, and left a moment so its idle work runs. */
async function up(p: Page, url: string, clear: boolean) {
  if (clear) { await p.open(host.root + "/", { clear: true }); await p.eval(`sessionStorage.clear(), true`); }
  await p.open(url, { width: 1200, height: 760, agent: false, clear: false });
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden`), 20_000, "the editor is up with its title");
  await p.send("Network.enable");
  await p.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
  await Bun.sleep(2500);
}
/** Clicks the title (after resting on it for `hover` ms, if any) and times until the tree's rows show. */
const time = (p: Page, hover: number) => p.eval<number>(`(async () => {
  const b = document.getElementById("doc-title");
  if (${hover}) { b.dispatchEvent(new PointerEvent("pointerenter")); b.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); await new Promise((r) => setTimeout(r, ${hover})); }
  const t0 = performance.now();
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); b.click();
  for (let i = 0; !document.querySelector("#pages:not([hidden]) .et-row[data-path]"); i++) { if (performance.now() - t0 > 15000) return "stuck: pages hidden=" + document.getElementById("pages").hidden + " html=" + document.getElementById("pages-tree").innerHTML.slice(0, 300); await new Promise((r) => setTimeout(r, 2)); }
  return Math.round(performance.now() - t0);
})()`);

const results: Record<string, number> = {};
try {
  const p = await browser.page();
  await up(p, editor(host.base), true);
  results["first open, no hover"] = await time(p, 0);
  await up(p, editor(host.base), true);
  results["first open, after a 150 ms hover"] = await time(p, 150);
  // The next page in the same tab: sessionStorage kept.
  await up(p, editor(host.root + info.docName.address + "/about"), false);
  results["first open, next page in the tab"] = await time(p, 0);
  for (const [k, v] of Object.entries(results)) console.log(`${String(v).padStart(5)} ms  ${k}`);
  const bound = Number(process.env.PAGES_OPEN_BOUND ?? 80);
  expect(Object.values(results).every((v) => v < bound), `every first open under ${bound} ms`, results);
  console.log("ok   the pages dropdown opens fast the first time");
} finally {
  await browser.close();
  await host.stop();
}
