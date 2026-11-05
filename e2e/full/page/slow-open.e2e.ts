// A document slow to open (the server waits seconds on its database): the editor says it's still opening, waits for the
// room's hello however long it takes, and starts when it comes. Only the server's word that there's no such document
// (GET /api/start: 404) shows "Nothing to edit here". Before, the editor gave the hello 8 s, then said "Nothing to edit
// here" for good.
import { join } from "node:path";
import type { Page } from "playwright-core";
import { expect, servers, test, until } from "../../helpers/fixtures";
import { editor, TIMESCALE } from "../../helpers/editor";
import { idOf, runTool } from "../../helpers/tools";

await servers.main();

/**
 * Holds the editor's start (GET /api/start) and everything the room sends on the shell's socket until `release()`:
 * a server that stalls before it answers. What the tab sends still reaches the room.
 */
async function hold(page: Page) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/start/, async (route) => {
    await released;
    await route.continue().catch(() => {});
  });
  await page.routeWebSocket(/\/api\/room\?events=1/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => void released.then(() => ws.send(m)));
  });
  return release;
}

/** The text of the editor's welcome element, if a person sees it: shown, not transparent, and on top at its middle. */
const welcome = (page: Page) =>
  page.evaluate(() => {
    const w = document.getElementById("welcome")?.querySelector("p");
    if (!w?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return "";
    const r = w.getBoundingClientRect();
    return w.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) ? (w.parentElement!.textContent ?? "") : "";
  });

/** Opens the fixture's copy in the editor (?edit), without waiting for the editor. */
async function open(page: Page, fixture: string) {
  const server = await servers.main();
  const { dir, address } = await server.fixture(fixture);
  await page.addInitScript((timescale) => {
    if (window.top == window) (window as any).__ergaTimescale = timescale;
  }, TIMESCALE);
  await page.goto(`${address}?edit`);
  return { server, dir, address };
}

test("a room that stays silent for a long time: the editor says the document is still opening, offers a reload, and starts when the hello comes", {
  timeout: 30_000,
}, async ({ tab }) => {
  tab.strict = true;
  const page = tab.page;
  const release = await hold(page);
  const { dir, address } = await open(page, "empty");
  await until(async () => /still opening/i.test(await welcome(page)), 10_000, "the editor says the document is still opening");
  // Long after the editor used to give up (8 s; the tests' timers run at TIMESCALE): a reload is offered, and it still waits.
  await until(() => page.evaluate(() => !!document.querySelector("#welcome button")), 15_000, "the editor offers a reload");
  expect(await welcome(page)).not.toMatch(/Nothing to edit/);
  release();
  const ed = editor(page, { address, dir, file: join(dir, "index.html") });
  await ed.loaded();
  expect(await welcome(page)).toBe("");
  await ed.clickEnd("p");
  await ed.type("Milk");
  await ed.shows("Milk|");
});

test("a document deleted while it opens: the editor says there's nothing to edit here", async ({ tab }) => {
  tab.strict = true;
  const page = tab.page;
  const release = await hold(page);
  const { server, address } = await open(page, "empty");
  expect((await runTool(server.root, "delete_document", { document: await idOf(address) })).status).toBe(200);
  release();
  await until(async () => /Nothing to edit here/.test(await welcome(page)), 10_000, "the editor says there's nothing to edit");
  // The browser logs the refused start (404) and the refused sockets: the server's answer, not the page's error.
  tab.errors.splice(0, tab.errors.length, ...tab.errors.filter((e) => !/status of 404|WebSocket connection to .* failed/.test(e)));
});
