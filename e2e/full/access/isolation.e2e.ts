// A document's page can't act as whoever has it open. The page here tries
// everything a page written to steal would: reach the editor's window, read the session, call the editor's own site
// as the viewer (their documents, their agent), and forge messages to the shell. It writes down what it got, and the
// test reads that from the page. (It can still drive the page editor, which runs in it: that edits this one document
// as the viewer, and nothing else; and what it says to the shell is its own word, which the shell treats as such.)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editor, F } from "../../editor";
import { expect, servers, test, until } from "../../fixtures";
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
test("the page runs on its own origin; it can't reach the editor's window, its cookies or its site; the edit it forges goes nowhere; it still renders", async ({ tab }) => {
  const s = await servers.main(), page = tab.page;
  const dir = join(s.scratch, "docs", unique("isolation-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.html");
  writeFileSync(file, thief(s.root));
  const address = await s.open(file);
  // Someone who keeps the agent closed (it opens by itself otherwise, and takes the keys typed below).
  await page.addInitScript(() => { if (window.top == window) try { localStorage.setItem("erga:settings:v1", '{"agent":false}'); } catch { /* no storage */ } });
  await page.goto(`${address}?edit`);
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
  // page editor, reaching the shell proves the shell has handled what came before it (the old harness waited 500 ms).
  await ed.clickEnd("h1");
  await ed.type("!");
  await until(async () => (await ed.source()).includes("Quarterly notes!</h1>"), 5000, "a real edit reaches the shell");
  const source = await ed.source();
  // (The script itself names STOLEN: the forged edit would have put it first.)
  expect(source.startsWith("STOLEN")).toBe(false);
  expect(source.replace("Quarterly notes!</h1>", "Quarterly notes</h1>")).toBe(thief(s.root));
  // (Its forged notice is its own word, shown as the page's, with nothing behind it: the editor in it says the same things.)
  expect(await ed.textOf("h1")).toBe("Quarterly notes!");
});

// The viewer holds the same page, on its own origin: there it reaches nothing either, and its storage is its own.
test("in the viewer the page runs on its own origin: no reach into the viewer's window, its cookies or its site, no storage of the site's (its own works)", async ({ tab }) => {
  const s = await servers.main(), page = tab.page;
  const dir = join(s.scratch, "docs", unique("isolation-view-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.html");
  writeFileSync(file, thief(s.root).replace("document.getElementById(\"loot\")", "(localStorage.setItem(\"k\", \"v\"), got.storage = localStorage.getItem(\"k\"), document.getElementById(\"loot\"))"));
  const address = await s.open(file);
  await page.goto(address);
  const frame = () => page.frames().find((f) => f.parentFrame() == page.mainFrame());
  let text = "";
  await until(async () => (text = (await frame()?.evaluate(() => document.getElementById("loot")?.textContent ?? "").catch(() => "")) ?? "") != "", 10_000, "the page's script ran");
  const loot = JSON.parse(text) as Record<string, unknown>;
  expect(new URL(String(loot.origin)).host, JSON.stringify(loot)).toMatch(/\.localhost:\d+$/);
  expect(loot.origin).not.toBe(new URL(page.url()).origin);
  expect(String(loot.topDocument)).toMatch(/^blocked/);
  expect(String(loot.topLocation)).toMatch(/^blocked/);
  expect(loot.cookie).toBe("");
  expect(String(loot.docs), "the documents list").toMatch(/^blocked/);
  expect(String(loot.agent), "the agent").toMatch(/^blocked/);
  expect(loot.storage, "its own storage").toBe("v");
  expect(await page.evaluate(() => localStorage.getItem("k")), "not the viewer's").toBeNull();
  expect(await page.evaluate(() => !!document.querySelector("#toast.show")), "a forged notice").toBe(false);
  expect(await frame()!.evaluate(() => document.querySelector("h1")!.textContent)).toBe("Quarterly notes");
});
