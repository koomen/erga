#!/usr/bin/env bun
// Someone else's page on erga.dev doesn't run its scripts until you say so
// (src/page/main.ts): your own does, theirs waits behind the pill, and
// "Run them" holds for the tab. Needs signing in, so it runs against the
// Worker (`bun run dev:worker`, with DEV_LOGIN in .dev.vars):
//
//   bun tests/scripts-gate.ts [http://localhost:5173]

import { Browser, type Page } from "./cdp";
import { expect } from "./suite/harness";

const base = (process.argv[2] || process.env.ERGA_WORKER_URL || "http://localhost:5173").replace(/\/+$/, "");
const browser = await Browser.launch();

const ready = async (p: Page) => {
  for (let i = 0; i < 200; i++) {
    if (await p.eval<boolean>(`!!document.getElementById("frame")?.contentDocument?.querySelector("[data-erga-id]")`).catch(() => false)) return;
    await Bun.sleep(50);
  }
  throw new Error("the editor never loaded");
};
/** Where the tab is, and whether the page's scripts ran (the editor's own watcher is one). */
const look = (p: Page) => p.eval<{ url: string; ran: boolean; pill: boolean }>(`({
  url: location.pathname,
  ran: Array.isArray(document.getElementById("frame").contentWindow.__ergaProblems),
  pill: !document.getElementById("scripts-pill").hidden,
})`);
/** How the tab looks once it does as `want` says, or after a few seconds if it never does. */
async function lookFor(p: Page, want: (l: Awaited<ReturnType<typeof look>>) => boolean) {
  let l = await look(p);
  for (let i = 0; i < 100 && !want(l); i++) { await Bun.sleep(50); l = await look(p); }
  return l;
}
/** A private window signed in as `who`, opening `path`. */
async function as(who: string, path: string): Promise<Page> {
  const p = await browser.page(await browser.context());
  await p.open(`${base}/auth/github?as=${who}&next=${encodeURIComponent(path)}`, { clear: false });
  await ready(p);
  return p;
}

let passed = 0;
const ok = (what: string) => { passed++; console.log(`ok   ${what}`); };
try {
  const alice = await as("alice", "/new?from=demo");
  const own = await lookFor(alice, (l) => l.ran && !l.pill);
  expect(own.ran && !own.pill, "your own page runs its scripts", own);
  ok("your own page runs its scripts");

  const bob = await as("bob", own.url);
  const theirs = await lookFor(bob, (l) => !l.ran && l.pill);
  expect(!theirs.ran && theirs.pill, "someone else's page doesn't, and says so", theirs);
  ok("someone else's page doesn't run its scripts, and offers to");

  await bob.eval(`document.getElementById("scripts-pill").click(), true`);
  const run = await lookFor(bob, (l) => l.ran && !l.pill);
  expect(run.ran && !run.pill, "Run them runs them", run);
  await bob.navigate(base + own.url); await ready(bob);
  expect((await lookFor(bob, (l) => l.ran)).ran, "and the tab remembers");
  ok("Run them runs them, and the tab remembers");

  const fresh = await lookFor(await as("bob", own.url), (l) => !l.ran && l.pill);
  expect(!fresh.ran && fresh.pill, "another window asks again", fresh);
  ok("another window asks again");
} catch (e) {
  console.error(`FAIL ${(e as Error).message}`);
  browser.close();
  process.exit(1);
}
browser.close();
console.log(`\n${passed} passed`);
process.exit(0);
