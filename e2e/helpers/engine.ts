// The browser the tests drive: Chromium through e2e's web engine (Playwright
// underneath, pinned by @e2e-dev/web). One instance, shared by the config and
// the fixtures: surfaceOf(engine) is how a test reaches the attempt's page.
// A factory VM's image has Chromium of its own, but the
// engine launches the browser its Playwright pins: `bunx @e2e-dev/web install chromium`.
//
// Trap: at a worker's end the engine closes its browser and waits for it to go, and e2e gives that 10 s
// (cleanupTimeout), else the run fails with "disposing the engine timed out" after every test passed. On a busy
// machine Chromium's own close took 9 to 10 s in 3 workers of 8, and 20 ms in the others: a run took 10 s more, and
// 14 runs of 40 failed. The browser has nothing to keep by then (each attempt closed its own context), so its close
// kills it first, and finds it gone. (The engine's own hooks are read-only: so the launch is wrapped, which the engine
// calls on the same module.)
//
// Trap: a person's browser has a process for each site, and the document's page is on another site than the viewer.
// This Chromium has one process for both, and a frame in its own process differs: as it goes, it says it is scrolled
// to 0 (client/inline/reader.ts), and that bug passed here. With a process for each site (--site-per-process) the
// suite was slower than its budgets, and 7 journeys failed: so only `sitesPage` has it, for the step that needs it.

import { spawnSync } from "node:child_process";
import { web } from "@e2e-dev/web";
import { chromium, type Page } from "playwright-core";

const launch = chromium.launch.bind(chromium);
chromium.launch = async (options) => {
  const browser = await launch(options);
  const close = browser.close.bind(browser);
  browser.close = (o) => {
    // The worker's own children whose command names Chromium: the browser's main process (its own process group).
    const found = spawnSync("pgrep", ["-P", String(process.pid), "-i", "-f", "chrom"], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
    for (const pid of found.split("\n").map(Number).filter(Boolean))
      for (const target of [-pid, pid])
        try {
          process.kill(target, "SIGKILL");
        } catch {
          /* gone */
        }
    return close(o);
  };
  return browser;
};

export const engine = web({ browser: "chromium", viewport: { width: 1100, height: 800 } });

/**
 * A page in a browser of its own, with a process for each site (the trap above), and its end. (Not through `launch`:
 * that browser's close kills the engine's too. Its own close is not waited for: the worker's end kills what is left.)
 */
export async function sitesPage(): Promise<{ page: Page; close: () => void }> {
  const context = await chromium.launchPersistentContext("", { args: ["--site-per-process"], viewport: { width: 1100, height: 800 } });
  return { page: context.pages()[0] ?? (await context.newPage()), close: () => void context.close().catch(() => {}) };
}
