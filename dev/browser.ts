// Local development's stand-in for Cloudflare Browser Rendering: a headless Chrome of the dev server's own (its own
// port, its own throwaway profile), started the first time view_page asks for it (POST /__erga/browser: the Worker's
// side is cloudflare/browser.ts) and stopped with the dev server. It is the Chromium the tests use: `bun run test:browsers`.

import { createServer } from "node:net";
import { chromium, type Browser } from "playwright-core";

let started: Promise<{ browser: Browser; port: number }> | null = null;

/** A port that nothing listens on right now: for this browser, for dev/start.ts and for the tests' servers. */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

/** The browser's DevTools address (ws://127.0.0.1:<port>/devtools/browser/<id>), the browser started if it wasn't. */
export async function localBrowser(): Promise<string> {
  const now = started && (await started.catch(() => null));
  if (!now?.browser.isConnected()) {
    started = (async () => {
      const port = await freePort();
      const browser = await chromium.launch({
        headless: true,
        args: [
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          // A page on <id>-<owner>.localhost may load what the tests serve on 127.0.0.1 (another site's font, say).
          "--disable-features=LocalNetworkAccessChecks",
          // The viewer's frame on the pages origin in a process of its own, as a desktop Chrome has it (headless shell
          // doesn't by default): view_page reaches it as its own target (cloudflare/render.ts).
          "--site-per-process",
        ],
      });
      return { browser, port };
    })();
    started.catch(() => (started = null));
  }
  const { port } = await started!;
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  return version.webSocketDebuggerUrl;
}

/** Stops the browser, if it started. */
export async function stopLocalBrowser(): Promise<void> {
  const now = started && (await started.catch(() => null));
  started = null;
  await now?.browser.close().catch(() => {});
}
