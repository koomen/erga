// The tests' fixtures, on e2e (tester-army/e2e) and its web engine.
//
// Per worker, started on first use: dev servers (servers.*). e2e has no
// worker-scoped fixtures (test.extend's run for every test), so these live in
// a registry in this module, which a worker imports once (e2e imports each
// test file afresh for every file and retry, but not the modules it imports).
// A file starts the ones it needs in test.beforeAll, which has a budget of its
// own, so a test's time limit never pays for a server. They stop when the
// worker exits (server.ts), and e2e/run.ts sweeps up after a worker that was
// killed.
//
//   servers.main()     a dev server, signed in as DEV_LOGIN, with no agent key
//   servers.agent()    the same with an agent key that is never used (the agent's UI comes on)
//   servers.factory()  the factory with simulated VMs and the scripted agent model
//   servers.suite()    the multiplayer suite's: the scripted agent model, and a short write delay (e2e/suite/suite.ts)
//   startServer()      a server for one test alone (test.ts disposes of it, see `tab.own`)
//
// Per test: `tab`, the attempt's own page in a fresh browser context (the web
// engine makes one per attempt), as Playwright's Page, with the page's errors
// collected from every frame. e2e's `browser` fixture reads only the main
// frame and has no frame-level evaluate, modifier-held clicks or
// insertText, which the editor's tests need, so the tests drive the
// Playwright page underneath it (surfaceOf).
//
// Tests share a worker's server one after another, never at once, and each
// makes its own data (documents, tasks, tokens), so none depends on another or
// on their order.

import { surfaceOf, test as web } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Page } from "playwright-core";
import { engine } from "./engine";
import { startServer, type Server, type ServerOptions } from "./server";

export { expect };
export type { Page, Server };

/** The factory's dev server: its secret (for minting git tokens), and how it answered before any test changed a setting. */
export interface FactoryServer extends Server {
  secret: string;
  initial: { enabled: boolean };
}

const started = new Map<string, Promise<Server>>();
const once = <T extends Server>(key: string, make: () => Promise<T>) => (): Promise<T> => {
  let s = started.get(key);
  if (!s) { s = make(); started.set(key, s); s.catch(() => started.delete(key)); }
  // One that stopped by itself (server.ts says why) is started again, for the tests after.
  return s.then((x) => { if (x.alive()) return x; x.dispose(); started.delete(key); return once(key, make)(); }) as Promise<T>;
};

export const servers = {
  main: once("main", () => startServer()),
  agent: once("agent", () => startServer({ env: { ANTHROPIC_API_KEY: "sk-ant-test-not-used" } })),
  factory: once("factory", async (): Promise<FactoryServer> => {
    const secret = `factory-test-${crypto.randomUUID()}`;
    const s = await startServer({ env: { ERGA_AGENT_MODEL: "script", ERGA_FACTORY_RUNNER: "sim", ERGA_LINK_SECRET: secret, ERGA_FACTORY_SIM_NO_SCRIPTS: "1" } });
    const initial = await (await fetch(`${s.root}/api/factory`)).json() as { enabled: boolean };
    return Object.assign(s, { secret, initial });
  }),
  suite: once("suite", () => startServer({ env: SUITE_ENV })),
};

/**
 * The multiplayer suite's server settings. A short write delay: the suite waits on storage a lot. Not too short:
 * tests share a server, and one that makes an edit "not yet stored" needs its next request in first.
 */
export const SUITE_ENV = { ERGA_AGENT_MODEL: "script", ERGA_WRITE_DELAY_MS: "200" };

export interface Tab {
  page: Page;
  /** Uncaught errors and console.error lines, from every frame. */
  errors: string[];
  /** Fail the test at its end if the page had errors (openEditor sets it, unless told the page has some). */
  strict: boolean;
  /** A server for this test alone, disposed of after it. */
  own(opts?: ServerOptions): Promise<Server>;
}

export const test = web.extend<{ tab: Tab }>({
  tab: async ({ browser }, use) => {
    // The attempt's page exists once something has navigated it.
    await browser.goto("about:blank");
    const page = surfaceOf(engine)!.page() as unknown as Page;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
    page.on("console", (m) => { if (m.type() == "error") errors.push(`console.error: ${m.text()}`); });
    const owned: Server[] = [];
    const tab: Tab = {
      page, errors, strict: false,
      async own(opts) { const s = await startServer(opts); owned.push(s); return s; },
    };
    try { await use(tab); } finally { for (const s of owned) s.dispose(); }
    if (tab.strict && errors.length) throw new Error(`the page had errors:\n${errors.join("\n")}`);
  },
});

/** Waits until `f` gives something truthy (a thrown error counts as not yet), and returns it; fails after `ms`. */
export async function until<T>(f: () => Promise<T> | T, ms = 5_000, what = "the condition"): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try { const v = await f(); if (v) return v; last = v; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`${what} didn't hold within ${ms} ms (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Two animation frames in the tab: input just sent has been handled and painted. */
export const settle = (page: Page) => page.evaluate(() => new Promise((r) => { const t = setTimeout(r, 100); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(true); })); }));
