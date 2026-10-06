#!/usr/bin/env bun
// The GitHub mirror's dialog on the Source page (source/page.ts), in headless
// Chrome on a dev server of its own (tests/host.ts):
//
//   - the GitHub status in the board's row opens it;
//   - while the mirror is on (locally: the pretend GitHub), it says so and
//     Push now pushes;
//   - while it's off (no GITHUB_MIRROR_TOKEN; the page is told so here, as
//     local development always has the pretend GitHub), it shows the steps
//     that turn it on: the token, the secret on this server's Worker, Push now.
//
// Screenshots land in tests/cdp.ts's SHOTS.
//
//   bun tests/source-mirror.ts

import { join } from "node:path";
import { Browser, SHOTS, type Page } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const host = await startHost(null, { env: { ERGA_DEPLOY_TARGET: "staging" } });
const root = host.root;
// The mirror's state as the page gets it, off: GET /api/source/branches answers what a server with no token would.
const OFF = `(() => { const f = window.fetch; window.fetch = async (u, o) => { const r = await f(u, o);
  if (!String(u).includes("/api/source/branches")) return r;
  const b = await r.json(); b.mirror = { url: "https://github.com/koomen/erga.git", lastPushAt: null, error: null, state: "off" };
  return new Response(JSON.stringify(b), { status: r.status, headers: { "Content-Type": "application/json" } }); }; })()`;

let browser: Browser | null = null;
try {
  browser = await Browser.launch();
  const pill = (p: Page) => p.eval<string>(`(() => { const m = document.getElementById("mirror-pill"); return m && !m.hidden ? m.textContent : ""; })()`);
  const shown = (p: Page) => p.eval<{ open: boolean; on: boolean; off: boolean; push: boolean; text: string }>(`(() => { const d = document.getElementById("mirror-dlg"), v = (id) => !document.getElementById(id).hidden && document.getElementById(id).getBoundingClientRect().height > 0;
    return { open: d.open, on: v("mirror-on"), off: v("mirror-off"), push: v("mirror-push"), text: d.innerText }; })()`);

  // On: the pretend GitHub.
  const p = await browser.page(await browser.context());
  await p.open(`${root}/admin/factory`, { width: 1280, height: 900, scale: 2, clear: false });
  await until(async () => (await pill(p)).startsWith("GitHub:") && !(await pill(p)).includes("loading"), 15_000, "the GitHub status shows", () => pill(p));
  await p.eval(`document.getElementById("mirror-pill").click()`);
  let s = await shown(p);
  expect(s.open && s.on && !s.off && s.push && s.text.includes("GitHub sync is on"), "on: the dialog says the sync is on, with Push now", s);
  await p.eval(`document.getElementById("mirror-push").click()`);
  await until(async () => (await p.eval<string>(`document.getElementById("mirror-state").textContent`)).includes("Last pushed just now") && !(await p.eval<boolean>(`document.getElementById("mirror-push").disabled`)), 15_000, "Push now pushes", () => shown(p));
  await p.screenshot(join(SHOTS, "source-mirror-on.png"));
  await p.eval(`document.getElementById("mirror-close").click()`);
  expect(!(await shown(p)).open, "Close closes it");
  ok("on: the GitHub status opens a dialog that says the sync is on; Push now pushes; Close closes it");

  // Off: the steps.
  const q = await browser.page(await browser.context());
  await q.send("Page.addScriptToEvaluateOnNewDocument", { source: OFF });
  await q.open(`${root}/admin/factory`, { width: 1280, height: 900, scale: 2, clear: false });
  await until(async () => (await pill(q)) == "GitHub: off", 15_000, "the GitHub status says off", () => pill(q));
  expect(!(await q.eval<boolean>(`document.getElementById("mirror-pill").disabled`)), "off: the status can still be clicked");
  await q.eval(`document.getElementById("mirror-pill").click()`);
  s = await shown(q);
  expect(s.open && s.off && !s.on && !s.push, "off: the dialog shows the steps, no Push now", s);
  for (const want of ["personal-access-tokens/new", "Contents, read and write", "koomen/erga", "bunx cf workers secrets update GITHUB_MIRROR_TOKEN --name erga-staging", "GITHUB_MIRROR_URL"])
    expect(s.text.includes(want) || (await q.eval<string>(`document.getElementById("mirror-dlg").innerHTML`)).includes(want), `the steps name ${want}`, s.text);
  await q.screenshot(join(SHOTS, "source-mirror-off.png"));
  await q.open(`${root}/admin/factory`, { width: 1280, height: 900, scale: 2, clear: false, dark: true });
  await until(async () => (await pill(q)) == "GitHub: off", 15_000, "the GitHub status says off (dark)", () => pill(q));
  await q.eval(`document.getElementById("mirror-pill").click()`);
  await q.screenshot(join(SHOTS, "source-mirror-off-dark.png"));
  await q.open(`${root}/admin/factory`, { width: 390, height: 844, scale: 2, clear: false });
  await until(async () => (await pill(q)) == "GitHub: off", 15_000, "the GitHub status says off (phone)", () => pill(q));
  await q.eval(`document.querySelector(".tabs [data-tab=tasks]").click(); document.getElementById("mirror-pill").click()`);
  s = await shown(q);
  expect(s.open && s.off, "on a phone too", s);
  await q.screenshot(join(SHOTS, "source-mirror-off-phone.png"));
  expect(!p.errors.length && !q.errors.length, "no errors on the page", [...p.errors, ...q.errors]);
  ok(`off: the GitHub status opens the steps that turn the sync on, light, dark and a phone (screenshots in ${SHOTS})`);
} finally {
  browser?.close();
  await host.dispose();
}
