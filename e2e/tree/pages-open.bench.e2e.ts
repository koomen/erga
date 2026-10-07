// How fast the editor's pages dropdown opens the first time, with 100 ms of network latency added (tests/pages-open.ts):
// from the click to the tree's rows on screen. Each case on a fresh editor load, a few seconds after it's up (its idle
// work done). PAGES_OPEN_BOUND (80 ms) is the bound for each.
import type { Page } from "playwright-core";
import { expect, servers, test } from "../fixtures";
import { multi } from "./tree";
import { open, up } from "./pages";

await servers.main();

const LATENCY = 100, BOUND = Number(process.env.PAGES_OPEN_BOUND ?? 80);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The editor up, then latency, then its idle work given time to run. */
async function slowUp(page: Page, url: string) {
  await up(page, url);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
  await pause(2500);
  return cdp;
}

for (const [what, hover, next] of [["first open, no hover", 0, false], ["first open, after a 150 ms hover", 150, false], ["first open, next page in the tab", 0, true]] as const) {
  test(`${what}: under ${BOUND} ms`, async ({ tab }) => {
    const doc = await multi(await servers.main());
    if (next) await up(tab.page, doc.base);
    const cdp = await slowUp(tab.page, next ? `${doc.base}/about` : doc.base);
    const ms = await open(tab.page, hover, 15_000);
    await cdp.detach();
    console.log(`${String(ms).padStart(5)} ms  ${what}`);
    expect(typeof ms == "number" && ms < BOUND, `${what}: ${ms}`).toBe(true);
  });
}
