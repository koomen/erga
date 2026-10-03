#!/usr/bin/env bun
// A document's page can't act as whoever has it open (src/page/bridge.ts).
// The page here tries everything a page written to steal would: reach the
// editor's window, read the session, call the editor's own site as the
// viewer (their documents, their agent), and forge messages to the shell.
// It writes down what it got, and the test reads that from the page. (It
// can still drive the page editor next to it, which is on its origin: that
// edits this one document as the viewer, and nothing else.)
//
//   bun tests/isolation.ts

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser } from "./cdp";
import { startHost } from "./host";
import { F } from "./tab";
import { expect, until } from "./suite/harness";

const dir = mkdtempSync(join(tmpdir(), "erga-isolation-"));
const host0 = await startHost(null);
const shell = host0.base;
await host0.dispose();

// The page knows the editor's address (anyone can guess erga.dev) and tries its luck there.
writeFileSync(join(dir, "index.html"), `<!doctype html>
<html><head><title>Innocent</title></head>
<body>
<h1>Quarterly notes</h1>
<p>Nothing to see here.</p>
<pre id="loot"></pre>
<script>
(async function () {
  const got = {};
  const tryIt = async (name, f) => { try { got[name] = await f(); } catch (e) { got[name] = "blocked: " + e.name; } };
  await tryIt("topDocument", () => !!window.top.document.body);
  await tryIt("parentOfFrame", () => !!window.parent.parent.document.body);
  await tryIt("topLocation", () => window.top.location.href);
  await tryIt("cookie", () => document.cookie);
  await tryIt("origin", () => self.origin);
  await tryIt("docs", async () => (await fetch("${shell}/docs", { credentials: "include" })).status);
  await tryIt("agent", async () => (await fetch("${shell}/me/x/api/agent", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }) })).status);
  // Forged messages to the editor, as the page editor would send them: from the page's own window, then through its frame's.
  window.top.postMessage({ type: "push", version: 0, changes: [0, [0, "STOLEN"]] }, "*");
  await tryIt("viaFrame", () => { window.parent.postMessage({ type: "notice", message: "forged" }, "*"); return "sent"; });
  document.getElementById("loot").textContent = JSON.stringify(got);
})();
</script>
</body></html>
`);

const host = await startHost(join(dir, "index.html"), { port: new URL(shell).port ? Number(new URL(shell).port) : undefined });
const browser = await Browser.launch();
let passed = 0;
const ok = (what: string) => { passed++; console.log(`ok   ${what}`); };
try {
  const p = await browser.page(await browser.context());
  await p.open(host.base, { clear: false });
  await until(async () => (await p.frame<string>(`${F}?.getElementById("loot")?.textContent ?? ""`)) != "", 10_000, "the page's script ran");
  const loot = JSON.parse(await p.frame<string>(`${F}.getElementById("loot").textContent`)) as Record<string, unknown>;
  const editor = new URL(await p.eval<string>("location.href")).origin;

  expect(typeof loot.origin == "string" && loot.origin != editor && /\.localhost:\d+$/.test(new URL(loot.origin).host), "the page runs on an origin of its own", loot);
  ok("the page runs on its document's own origin, not the editor's");
  expect(String(loot.topDocument).startsWith("blocked") && String(loot.topLocation).startsWith("blocked"), "it can't reach the editor's window", loot);
  ok("it can't reach the editor's window or read its address");
  expect(loot.cookie == "", "it sees no cookies", loot);
  ok("it sees no cookies");
  expect(String(loot.docs).startsWith("blocked") && String(loot.agent).startsWith("blocked"), "the editor's site won't answer it", loot);
  ok("it can't call the editor's site as the viewer: not the documents list, not the agent");

  // The forged edit went nowhere: the editor's text is the file's, and so is the room's.
  await Bun.sleep(500);
  const source = await p.eval<string>("ergaPage.state.doc.toString()");
  expect(source == readFileSync(join(dir, "index.html"), "utf8"), "a forged edit from the page is ignored");
  expect(await p.eval<boolean>(`!document.querySelector("#toast.show")?.textContent.includes("forged")`), "a forged notice is ignored");
  ok("messages the page sends the editor itself are ignored");
  expect(await p.frame<boolean>(`${F}.querySelector("h1").textContent == "Quarterly notes"`), "and the page itself still works");
  ok("and the page still renders as normal");
} catch (e) {
  console.error(`FAIL ${(e as Error).message}`);
  browser.close(); await host.dispose(); rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
browser.close(); await host.dispose(); rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
process.exit(0);
