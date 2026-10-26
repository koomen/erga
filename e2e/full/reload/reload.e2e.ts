// Live reload (`bun start --reload`, dev/reload.ts): an open tab reloads by itself, showing the
// change, when the Worker's front door changes (Vite restarts the server), when another Worker module changes (Vite
// reloads the Worker), when the editor's own files change (dev/start.ts rebuilds them), and the page editor too. The edits
// are made in a copy of this checkout, with a server of its own for this file: each test makes
// its own change, with a mark of its own, and waits for that.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { beforeTests, expect, test, until, withoutOutage, type Page } from "../../helpers/fixtures";
import { copyCheckout, startIn, upAt, type Started } from "../../helpers/checkout";

let scratch = "", copy = "", root = "", server: Started | null = null;

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

// As the worker imports this file, outside any test's time limit.
await beforeTests(async () => {
  scratch = mkdtempSync(join(realpathSync(tmpdir()), "erga-reload-"));
  copy = join(scratch, "erga");
  copyCheckout(copy);
  mkdirSync(join(scratch, "env"));
  writeFileSync(join(scratch, "env", ".dev.vars"), `DEV_LOGIN=tester\nSESSION_SECRET=${crypto.randomUUID()}\n`);
  const port = await freePort();
  root = `http://127.0.0.1:${port}`;
  // Its own state, settings and Vite cache; the editor's files built and watched (no ERGA_BUILT).
  server = startIn(copy, ["--port", String(port), "--no-open", "--reload"], { ERGA_STATE_DIR: join(scratch, "state"), ERGA_ENV_DIR: join(scratch, "env"), ERGA_VITE_CACHE: join(scratch, "vite"), ERGA_INSPECTOR: "0" });
  await upAt(server, () => `${root}/docs`, 120_000);
});

test.afterAll(async () => {
  await server?.stop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** Changes a file of the copy: `from` (a string or a pattern) to `to`. */
function edit(file: string, from: string | RegExp, to: string) {
  const path = join(copy, file), text = readFileSync(path, "utf8");
  if (!(typeof from == "string" ? text.includes(from) : from.test(text))) throw new Error(`${file} has no ${from}`);
  writeFileSync(path, text.replace(from, to));
}
/** The front door's title for a document, whatever an earlier test made it. */
const TITLE = /<title>\$\{esc\(title\)\} · Erga[^<]*<\/title>/;

/** An expression: the page's stylesheets have a rule for the class. */
const hasRule = (cls: string) => `[...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.selectorText == ".${cls}"); } catch { return false; } })`;

/** Opens Documents in the tab. */
async function docs(page: Page) {
  await page.goto(`${root}/docs`);
  await until(() => page.evaluate(`document.readyState == "complete" && document.title.startsWith("Documents · Erga")`), 10_000, "the docs page is open");
}

/** Marks the page, makes `change`, and waits for a fresh page (no mark) for which `ready` holds. */
async function reloads(page: Page, change: () => void, ready: string, ms = 30_000) {
  await page.evaluate(`window.__before = true`);
  change();
  await until(() => page.evaluate(`!window.__before && document.readyState == "complete" && (${ready})`).catch(() => false), ms, "a fresh page", () => server!.output().split("\n").slice(-8).join("\n"));
}

// Vite restarts the server (seconds; more on a busy machine) before the tab can reload.
test("the Worker's front door changes (server/pages/chrome.ts: Vite restarts the server): the page reloads, showing it", { timeout: 45_000 }, async ({ tab }) => {
  tab.strict = true;
  await docs(tab.page);
  await reloads(tab.page, () => edit("server/pages/chrome.ts", TITLE, "<title>${esc(title)} · Erga, front</title>"), `document.title == "Documents · Erga, front"`);
  withoutOutage(tab.errors);
});

test("another Worker module changes (cloudflare/index.ts: Vite reloads the Worker): the page reloads", { timeout: 45_000 }, async ({ tab }) => {
  tab.strict = true;
  await docs(tab.page);
  await reloads(tab.page, () => edit("cloudflare/index.ts", "\n", `\n// edited ${crypto.randomUUID()}\n`), "true");
});

/** The editor's stylesheet as the server names it now (each build's has its own address: client/build.ts). */
const styleUrl = async () => `${root}${((await (await fetch(`${root}/api/release`)).json()) as { files: Record<string, string> }).files["style.css"]}`;

// The editor's files are rebuilt before the tab reloads.
test("the editor's own files change (client/style.css: they're rebuilt): the page reloads, with them, and they're what's served", { timeout: 45_000 }, async ({ tab }) => {
  tab.strict = true;
  await docs(tab.page);
  const rule = `erga-reload-${crypto.randomUUID().slice(0, 8)}`;
  await reloads(tab.page, () => edit("client/style.css", "\n", `\n.${rule} { color: red; }\n`), hasRule(rule));
  expect(await (await fetch(await styleUrl())).text()).toContain(`.${rule}`);
});

// Both at once, as an agent's edit often is: the restart and the rebuild end in one good page, never an error page.
test("the front door and the editor's files change together: the page comes back with both, and stays", { timeout: 45_000 }, async ({ tab }) => {
  tab.strict = true;
  await docs(tab.page);
  const rule = `erga-reload-${crypto.randomUUID().slice(0, 8)}`;
  await reloads(tab.page, () => { edit("server/pages/chrome.ts", TITLE, "<title>${esc(title)} · Erga, together</title>"); edit("client/style.css", "\n", `\n.${rule} { color: red; }\n`); }, `document.title == "Documents · Erga, together"`);
  // The server has done both (restarted, rebuilt), and whatever reload that set off, the tab is on the good page, with both.
  await until(async () => (await (await fetch(await styleUrl())).text()).includes(`.${rule}`), 30_000, "the rebuilt files are served");
  await until(() => tab.page.evaluate(`document.readyState == "complete" && document.title == "Documents · Erga, together" && ${hasRule(rule)}`).catch(() => false), 30_000, "the tab is on the good page, with both changes");
  withoutOutage(tab.errors);
});

test("the editor's code changes (client/shell/main.ts): the editor reloads, on the same document", { timeout: 45_000 }, async ({ tab }) => {
  tab.strict = true;
  const page = tab.page;
  await page.goto(`${root}/new`);
  await until(
    () => page.evaluate(`!!document.querySelector("iframe") && /^\\/tester\\/./.test(location.pathname)`).catch(() => false),
    10_000,
    "a new document opens in the editor"
  );
  const doc = (await page.evaluate(`location.pathname`)) as string;
  await reloads(
    page,
    () => edit("client/shell/main.ts", "\n", `\n// edited ${crypto.randomUUID()}\n`),
    `location.pathname == ${JSON.stringify(doc)} && !!document.querySelector("iframe")`
  );
});

test("only top-level pages get the reload script, not a frame or a fetch", async () => {
  const get = async (dest: string) => (await (await fetch(`${root}/docs`, { headers: { "sec-fetch-dest": dest } })).text()).includes("erga live reload");
  expect(await get("document")).toBe(true);
  expect(await get("iframe")).toBe(false);
  expect(await get("empty")).toBe(false);
});
