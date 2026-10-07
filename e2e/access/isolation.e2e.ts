// A document's page can't act as whoever has it open (tests/isolation.ts; src/page/bridge.ts). The page here tries
// everything a page written to steal would: reach the editor's window, read the session, call the editor's own site
// as the viewer (their documents, their agent), and forge messages to the shell. It writes down what it got, and the
// test reads that from the page. (It can still drive the page editor next to it, which is on its origin: that edits
// this one document as the viewer, and nothing else.)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editor, F } from "../editor";
import { expect, servers, test, until } from "../fixtures";
import { unique } from "./access";

await servers.main();

// The page knows the editor's address (anyone can guess erga.dev) and tries its luck there.
const thief = (shell: string) => `<!doctype html>
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
`;

// The page's blocked calls print errors of their own (CORS, security errors), so the tab isn't strict here.
test("the page runs on its own origin; it can't reach the editor's window, its cookies or its site; the messages it forges are ignored; it still renders", async ({ tab }) => {
  const s = await servers.main(), page = tab.page;
  const dir = join(s.scratch, "docs", unique("isolation-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.html");
  writeFileSync(file, thief(s.root));
  const address = await s.open(file);
  // Someone who keeps the agent closed (it opens by itself otherwise, and takes the keys typed below).
  await page.addInitScript(() => { if (window.top == window) try { localStorage.setItem("erga:settings:v1", '{"agent":false}'); } catch { /* no storage */ } });
  await page.goto(`${address}#edit`);
  const ed = editor(page, { address, dir, file });
  await ed.loaded();
  await until(async () => (await ed.frame<string>(`${F}?.getElementById("loot")?.textContent ?? ""`)) != "", 10_000, "the page's script ran");
  const loot = JSON.parse(await ed.frame<string>(`${F}.getElementById("loot").textContent`)) as Record<string, unknown>;
  const shell = new URL(page.url()).origin;
  expect(typeof loot.origin, JSON.stringify(loot)).toBe("string");
  expect(loot.origin).not.toBe(shell);
  expect(new URL(String(loot.origin)).host, "an origin of its own").toMatch(/\.localhost:\d+$/);
  expect(String(loot.topDocument)).toMatch(/^blocked/);
  expect(String(loot.topLocation)).toMatch(/^blocked/);
  expect(loot.cookie).toBe("");
  expect(String(loot.docs), "the documents list").toMatch(/^blocked/);
  expect(String(loot.agent), "the agent").toMatch(/^blocked/);
  // The forged edit went nowhere. The page posted it before it wrote its loot; an edit made after that, through the
  // page editor, reaching the shell proves the shell has handled what came before it (tests/isolation.ts waited 500 ms).
  await ed.clickEnd("h1");
  await ed.type("!");
  await until(async () => (await ed.source()).includes("Quarterly notes!</h1>"), 5000, "a real edit reaches the shell");
  const source = await ed.source();
  // (The script itself names STOLEN: the forged edit would have put it first.)
  expect(source.startsWith("STOLEN")).toBe(false);
  expect(source.replace("Quarterly notes!</h1>", "Quarterly notes</h1>")).toBe(thief(s.root));
  expect(await page.evaluate(() => !!document.querySelector("#toast.show")?.textContent?.includes("forged")), "a forged notice").toBe(false);
  expect(await ed.textOf("h1")).toBe("Quarterly notes!");
});
