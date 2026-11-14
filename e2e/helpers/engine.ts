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
// By itself this Chromium has one process for both, and a frame in its own process differs (as it goes, it says it is
// scrolled to 0: client/inline/reader.ts; its document has the focus only when its process is told), so bugs passed
// here. So it runs with a process for each site (--site-per-process), for every test and for `bun run look`. What
// DevTools does differently from a person's browser then, and what a test does about it:
// - The browser finds the process under a point from the last picture it drew. Just after the page's frame came,
//   showed again or got another size, a press or the wheel on the page goes to the viewer (on its frame element): the
//   pointer goes there first, until the page has it (pointerOnPage, e2e/helpers/press.ts; `ed.click` does).
// - The viewer is not told that the pointer went into the page's frame: what it had under the pointer keeps its hover.
//   The pointer leaves by a place of the viewer's own first.
// - In full screen the page's frame takes presses only inside the browser's real window (800 by 600 by itself, not
//   the viewport that a test sets): so the window is larger than any test's viewport (--window-size).
// - A frame that the browser refused has no name and no address in page.frames(): find it by its element.

import { spawnSync } from "node:child_process";
import { web } from "@e2e-dev/web";
import { chromium } from "playwright-core";

const launch = chromium.launch.bind(chromium);
chromium.launch = async (options) => {
  const browser = await launch({ ...options, args: [...(options?.args ?? []), "--site-per-process", "--window-size=2560,1440"] });
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
