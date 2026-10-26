// A document's page loads once, for readers and editors alike: the viewer holds it in one frame on the document's
// pages origin, and going into the editor loads the editor into that page. So the page's own scripts run once, and its
// media load once: opened in the editor and reloaded there, and going from the viewer into the editor and back (the
// pencil), with the agent's panel open, closed to its button, or open at the right. The page stays the same page all
// the while (its own state, a value its script set, carries on), and out of the editor it's the page alone again.
// Before, three copies ran the page: the viewer's page inline, the frame's host page's plain page, and the editor's.
// The fixture (e2e/fixtures/music) has the shape of a page of music widgets: an inline script, a module that imports
// another (and preloads it), a recording it fetches and plays from a Blob, and an <audio> that loads its own.
import type { Frame } from "playwright-core";
import { expect, servers, test, type Page } from "../../helpers/fixtures";
import { openViewer } from "./viewer";
import { sleep } from "../../../shared/time";

await servers.main();

/** What the page fetches once for each run of it: its scripts, its media, and what its inline script fetches. */
const FILES = ["page.js", "balls.js", "audio.m4a", "intro.m4a", "ran.txt"];
const times = (n: number) => Object.fromEntries(FILES.map((f) => [f, n]));

/** Counts, from now on, how many times any frame of the tab asks for each of FILES. (Routed: nothing comes from the cache, so each run of the page asks again.) */
function counting(page: Page) {
  const asked = new Map<string, number>();
  page.context().on("request", (r) => { const f = FILES.find((n) => new URL(r.url()).pathname.endsWith("/" + n)); if (f) asked.set(f, (asked.get(f) ?? 0) + 1); });
  return () => Object.fromEntries(FILES.map((f) => [f, asked.get(f) ?? 0]));
}

/** The document's page in the tab's frame. */
const docFrame = (page: Page) => page.frames().find((f) => f.parentFrame() == page.mainFrame() && /\/t\//.test(f.url())) as Frame;
/** Whether the editor is on the page: editing, ready, and the page's text blocks editable. */
const editing = async (page: Page) => await page.evaluate(() => document.body.classList.contains("erga-editing") && document.body.classList.contains("erga-editor-ready"))
  && !!(await docFrame(page)?.evaluate(() => !!(window as any).ergaFrame?.page && !!document.querySelector("[data-erga-id][contenteditable]")).catch(() => false));
/** Whether the viewer shows the page alone: the page in the frame with nothing of the editor's on it. */
const viewing = async (page: Page) => await page.evaluate(() => !document.body.classList.contains("erga-editing"))
  && !!(await docFrame(page)?.evaluate(() => !(window as any).ergaFrame && !document.querySelector("[contenteditable], [data-erga-editing]") && !document.querySelector('style[data-erga="page"]')).catch(() => false));
/** A mark the page's run carries (its own global): the same page, not loaded again. */
const mark = (page: Page) => docFrame(page).evaluate(() => ((window as any).__run ??= Math.random()));

const STATES: [string, Record<string, unknown>][] = [
  ["the agent open", { "erga:settings:v1": { agent: true } }],
  ["the agent closed to its button", { "erga:settings:v1": { agent: false } }],
  ["the agent open at the right", { "erga:settings:v1": { agent: true }, "erga:layout:v1": { order: ["doc", "picker", "agent"], agentWidth: 520 } }],
];

for (const [what, kept] of STATES) {
  test(`${what}: the page's scripts run once and its media load once, opened in the editor, reloaded there, and into the editor and out by the pencil`, async ({ tab }) => {
    // (Strict: a copy that tried to run them and was refused would say so in the console.)
    tab.strict = true;
    const page = tab.page;
    const url = (await (await servers.main()).fixture("music")).address;
    await openViewer(page, url, { width: 1300, height: 800, agent: true });
    await page.evaluate((kept) => { for (const [k, v] of Object.entries(kept)) localStorage.setItem(k, JSON.stringify(v)); }, kept);
    await page.context().route("**/*", (r) => r.continue());

    // Opened in the editor.
    let count = counting(page);
    await page.goto("about:blank");
    await page.goto(url + "?edit");
    await expect.poll(() => editing(page), { timeout: 15_000 }).toBe(true);
    expect(await page.evaluate(() => document.body.classList.contains("agent-open")), "the panel as kept").toBe((kept["erga:settings:v1"] as { agent: boolean }).agent);
    await sleep(1500);
    expect(count(), `${what}: opened in the editor`).toEqual(times(1));
    // The page that ran is the one the editor is on: its widget drew.
    expect(await docFrame(page).evaluate(() => { const c = document.getElementById("balls") as HTMLCanvasElement; return c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 == 3 && v > 0); }), "the widget drew").toBe(true);
    page.context().removeAllListeners("request");

    // Reloaded in the editor.
    count = counting(page);
    await page.reload();
    await expect.poll(() => editing(page), { timeout: 15_000 }).toBe(true);
    await sleep(1500);
    expect(count(), `${what}: reloaded in the editor`).toEqual(times(1));
    page.context().removeAllListeners("request");

    // Out of the editor by the pencil, and back in: the same page all the while, its scripts and media not loaded again.
    count = counting(page);
    const run = await mark(page);
    await page.locator("#btn-edit").click();
    await expect.poll(() => viewing(page), { timeout: 10_000 }).toBe(true);
    expect(new URL(page.url()).search, "the viewer's address").toBe("");
    await sleep(800);
    await page.locator(".erga-edit-button").click();
    await expect.poll(() => editing(page), { timeout: 10_000 }).toBe(true);
    expect(new URL(page.url()).search, "the editor's address").toBe("?edit");
    await sleep(800);
    expect(await mark(page), "the same page").toBe(run);
    expect(count(), `${what}: out of the editor and back`).toEqual(times(0));
    page.context().removeAllListeners("request");
  });
}

test("a reader's page loads once too, and going into the editor from it loads nothing of the page again", async ({ tab }) => {
  tab.strict = true;
  const page = tab.page;
  const url = (await (await servers.main()).fixture("music")).address;
  await page.context().route("**/*", (r) => r.continue());
  const count = counting(page);
  await openViewer(page, url, { width: 1300, height: 800 });
  await expect.poll(() => viewing(page), { timeout: 10_000 }).toBe(true);
  await sleep(1500);
  expect(count(), "the viewer").toEqual(times(1));
  const run = await mark(page);
  await page.locator(".erga-edit-button").click();
  await expect.poll(() => editing(page), { timeout: 15_000 }).toBe(true);
  await sleep(1000);
  expect(await mark(page), "the same page").toBe(run);
  expect(count(), "the viewer, then the editor").toEqual(times(1));
});
