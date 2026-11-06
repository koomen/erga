// The server's browser, for view_page (cloudflare/render.ts): Cloudflare Browser Rendering (the BROWSER binding) on a
// deployed server; in local development, a headless Chrome the dev server starts on this computer (dev/browser.ts),
// behind the same interface. Its session stays open between renders (keep_alive), so a render after the first is fast.

import { connect, launch, sessions, type Browser, type BrowserBinding } from "./cdp";
import type { Env } from "./env";

/** How long Cloudflare keeps a browser session with no activity, in ms (its most). */
const KEEP_ALIVE = 600_000;

/** The browser binding: Cloudflare's, or the dev server's Chrome; null where there's neither. */
export function browserBinding(env: Env): BrowserBinding | null {
  if (env.BROWSER) return env.BROWSER;
  if (env.ERGA_DEV_ORIGIN && env.ERGA_LINK_SECRET) return localChrome(env.ERGA_DEV_ORIGIN, env.ERGA_LINK_SECRET);
  return null;
}

/**
 * The dev server's Chrome as a browser binding: the few calls of Cloudflare's that cloudflare/cdp.ts makes. The
 * session is the one Chrome; the dev server starts it the first time it's asked (POST /__erga/browser).
 */
function localChrome(origin: string, secret: string): BrowserBinding {
  const devtools = async () => {
    const r = await fetch(`${origin}/__erga/browser?link=${encodeURIComponent(secret)}`, { method: "POST" });
    if (!r.ok) throw new Error(`the dev server's browser didn't start: ${await r.text()}`);
    return ((await r.json()) as { ws: string }).ws;
  };
  return {
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname == "/v1/devtools/browser" && init?.method == "POST") return Response.json({ sessionId: "local" });
      // (Chrome takes any number of connections: there is never one to share.)
      if (url.pathname == "/v1/sessions") return Response.json({ sessions: [] });
      if (url.pathname.startsWith("/v1/devtools/browser/"))
        return fetch((await devtools()).replace(/^ws:/, "http:"), { headers: { Upgrade: "websocket" } });
      return new Response("Not found", { status: 404 });
    },
  };
}

/** How long a Durable Object keeps its connection after a render: a burst of renders reuses it, then the session is free for others. */
const HOLD_MS = 30_000;

/**
 * One Durable Object's browser: a connection to a session, kept between renders for HOLD_MS. (A connection belongs to
 * the object that opened it: another object in the same isolate can't use it.) `use` answers a browser to render in,
 * and how it came: this object's, still connected; a session another left idle; or a new session, kept alive by
 * Cloudflare for KEEP_ALIVE after its last use.
 */
export function browsers(binding: BrowserBinding) {
  let open: Promise<Browser> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Each connection's browser contexts, one for each person: their cookies apart, their cache kept between renders. */
  const contexts = new WeakMap<Browser, Map<string, Promise<string>>>();
  const start = async (): Promise<{ browser: Browser; how: "connected" | "launched" }> => {
    const idle = (await sessions(binding).catch(() => [])).find((s) => !s.connectionId);
    if (idle) {
      const browser = await connect(binding, idle.sessionId).catch(() => null);
      if (browser) return { browser, how: "connected" };
    }
    return { browser: await launch(binding, KEEP_ALIVE), how: "launched" };
  };
  return {
    async use(): Promise<{ browser: Browser; how: "reused" | "connected" | "launched" }> {
      clearTimeout(timer);
      const kept = open && (await open.catch(() => null));
      if (kept?.connected) return { browser: kept, how: "reused" };
      const started = start();
      open = started.then((s) => s.browser);
      open.catch(() => (open = null));
      return started;
    },
    /**
     * The person's browser context on this connection (made the first time): it holds their view cookie, apart from
     * anyone else's, and the files a render loaded, for the next. It goes with the connection (disposeOnDetach).
     */
    context(browser: Browser, person: string): Promise<string> {
      let mine = contexts.get(browser);
      if (!mine) contexts.set(browser, (mine = new Map()));
      let id = mine.get(person);
      if (!id) {
        const made = browser.newContext();
        made.catch(() => mine.delete(person));
        mine.set(person, (id = made));
      }
      return id;
    },
    /** A render is done: the connection goes after HOLD_MS with no other (the session stays, for the next to connect to). */
    done() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const was = open;
        open = null;
        void was?.then((b) => b.disconnect()).catch(() => {});
      }, HOLD_MS);
    },
  };
}
