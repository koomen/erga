// The tests' fixtures, on e2e and its web engine.
//
// Per worker, started on first use: dev servers (servers.*), one of the named
// kinds and one servers.of at a time (`once`). e2e has no
// worker-scoped fixtures (test.extend's run for every test), so these live in
// a registry in this module, which a worker imports once (e2e imports each
// test file afresh for every file and retry, but not the modules it imports).
//
// A file starts the servers it needs at its top level, as the worker imports
// it: `await servers.main();`. e2e waits for that import with no time limit
// (a beforeAll has the test's 15 s, and under load a server takes longer to
// start, which skipped the whole file), so no test or hook pays for a server.
// The runner imports every file too, only to list its tests: there servers.*
// start nothing (WORKER). A file's own processes start the same way, in
// beforeTests(). A test still calls servers.x() for the server (at
// once: started), which also starts again one that stopped by itself. They
// stop when the worker exits, and e2e/run.ts sweeps up after a
// worker that was killed.
// Hooks get config.timeout (90 s, e2e.config.ts) as a backstop; each test still gets ERGA_TEST_MS
// (15 s, which `test` below gives it).
//
//   servers.main()     a dev server, signed in as DEV_LOGIN, with no agent key
//   servers.agent()    the same with an agent key that is never used (the agent's UI comes on)
//   servers.script()   a plain dev server whose agents (the editor's, the admin's) run on the scripted model
//   servers.short()    the scripted agent model, and short timings (SHORT): versions cut, homepages deployed, in seconds
//   servers.suite()    the multiplayer suite's: the scripted agent model, and a short write delay
//   servers.of(key, o) a kind one file needs alone (its own settings, or one it changes or restarts),
//                      started with ServerOptions `o`: `const own = () => servers.of("deploy-page");`
//                      (the worker keeps the last file's only)
//   startServer()      a server for one test alone, started inside its time limit (test.ts disposes
//                      of it, see `tab.own`): only where each attempt needs a fresh one
//
// Per test: `tab`, the attempt's own page in a fresh browser context (the web
// engine makes one per attempt), as Playwright's Page, with the page's errors
// collected from every frame. e2e's `browser` fixture reads only the main
// frame and has no frame-level evaluate, modifier-held clicks or
// insertText, which the editor's tests need, so the tests drive the
// Playwright page underneath it (surfaceOf).
//
// Tests share a worker's server one after another, never at once, and each
// makes its own data (documents, tokens), so none depends on another or
// on their order.

import { surfaceOf, test as web } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Page } from "playwright-core";
import { engine } from "./engine";
import { startServer, type Server, type ServerOptions } from "./server";

export { expect };
export type { Page, Server };

type Disposable = { alive(): boolean; dispose(): void };
const started = new Map<string, Promise<Disposable>>();
/** Whether this process is one of e2e's workers (forked with an IPC channel), not the runner, which only lists the tests. */
const WORKER = typeof process.send == "function";

/** Disposes of the worker's servers whose keys `drop` picks: a kind no later file of this worker may need. */
const disposeWhere = (drop: (key: string) => boolean) => {
  for (const [k, s] of started) if (drop(k)) { started.delete(k); s.then((x) => x.dispose(), () => {}); }
};

const once = <T extends Disposable>(key: string, make: () => Promise<T>) => (): Promise<T> => {
  // Listing the tests: nothing runs, so nothing starts (and nothing may use what this gives).
  if (!WORKER) return Promise.resolve(null as unknown as T);
  let s = started.get(key);
  // A worker keeps one server of the named kinds (servers.main to servers.suite), the last file's: no file needs two
  // (with its helpers), and a dev server holds about 1.7 GB (Vite 1.2, workerd 0.4). Kept, every kind a worker met
  // added up: in the gate's 12 GB VM, two workers reached ten servers, and the kernel killed processes in every shard.
  if (!s && !key.startsWith("of:")) disposeWhere((k) => !k.startsWith("of:"));
  if (!s) { s = make(); started.set(key, s); s.catch(() => started.delete(key)); }
  // One that stopped by itself (server.ts says why) is started again, for the tests after.
  return s.then((x) => { if (x.alive()) return x; x.dispose(); started.delete(key); return once(key, make)(); }) as Promise<T>;
};

/**
 * servers.short()'s timings: a version is cut once edits pause for `idle` ms (or after `max`, whatever the typing); a
 * homepage deploys `homeDelay` ms after it has a new version, and / always asks for the latest deploy.
 */
export const SHORT = { idle: 1000, max: 8000, homeDelay: 2000 };

export const servers = {
  main: once("main", () => startServer()),
  agent: once("agent", () => startServer({ env: { ANTHROPIC_API_KEY: "sk-ant-test-not-used" } })),
  short: once("short", () => startServer({ env: {
    ERGA_AGENT_MODEL: "script", ERGA_WRITE_DELAY_MS: "50", ERGA_VERSION_IDLE_MS: String(SHORT.idle), ERGA_VERSION_MAX_MS: String(SHORT.max),
    ERGA_HOME_DELAY_MS: String(SHORT.homeDelay), ERGA_HOME_RECHECK_MS: "0",
  } })),
  // The scripted model (agents/document/session.ts, "@script [...]"): a message plays the tool calls and replies it lists.
  script: once("script", () => startServer({ env: { ERGA_AGENT_MODEL: "script" } })),
  suite: once("suite", () => startServer({ env: SUITE_ENV })),
  /**
   * A kind of server one file needs (`key`, its own), started with `opts` the first time. A worker keeps one such
   * server: the next file's (another key) disposes of it, as files run one after another. So one key for each file.
   */
  of(key: string, opts: ServerOptions = {}): Promise<Server> {
    if (WORKER) disposeWhere((k) => k.startsWith("of:") && k != `of:${key}`);
    return once(`of:${key}`, () => startServer(opts))() as Promise<Server>;
  },
};

/**
 * The multiplayer suite's server settings. A short write delay: the suite waits on storage a lot. Not too short:
 * tests share a server, and one that makes an edit "not yet stored" needs its next request in first.
 */
export const SUITE_ENV = { ERGA_AGENT_MODEL: "script", ERGA_WRITE_DELAY_MS: "200" };

/**
 * Work a file does before its tests (processes of its own: checkouts, a copy of the repository), awaited at its top
 * level as the worker imports it, so outside any time limit, as servers.* start. Nothing where the runner only lists
 * the tests. A retry imports the file again, after its afterAll: so it runs again, for the new attempt.
 */
export async function beforeTests<T>(fn: () => Promise<T>): Promise<T | undefined> {
  return WORKER ? fn() : undefined;
}

export interface Tab {
  page: Page;
  /** Uncaught errors and console.error lines, from every frame. */
  errors: string[];
  /** Fail the test at its end if the page had errors (openEditor sets it, unless told the page has some). */
  strict: boolean;
  /** A server for this test alone, disposed of after it. */
  own(opts?: ServerOptions): Promise<Server>;
}

const extended = web.extend<{ tab: Tab }>({
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

/**
 * e2e's `test`, each test with the time limit ERGA_TEST_MS (the config's) unless it names its own: e2e gives a test
 * without one config.timeout, which is the hooks' budget and longer.
 */
export const test = new Proxy(extended, {
  apply(target, self, args: unknown[]) {
    const ms = Number(process.env.ERGA_TEST_MS) || undefined;
    if (!ms) return Reflect.apply(target, self, args);
    const [title, a, b] = args;
    return b === undefined ? Reflect.apply(target, self, [title, { timeout: ms }, a]) : Reflect.apply(target, self, [title, { timeout: ms, ...(a as object) }, b]);
  },
}) as typeof extended;

/**
 * Takes out of `errors` (in place) what the browser logs for requests that failed because the server was down
 * ("Failed to load resource: net::ERR_CONNECTION_REFUSED", "WebSocket connection to ... failed"), which Playwright reports as console errors: a restart
 * (a server of the test's own, halted) means some. What's left is the page's own errors.
 */
export function withoutOutage(errors: string[]): string[] {
  const left = errors.filter((e) => !/^console\.error: (Failed to load resource|WebSocket connection to '[^']*' failed)\b.*net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|INCOMPLETE_CHUNKED_ENCODING|EMPTY_RESPONSE|CONNECTION_CLOSED)\b/.test(e));
  errors.splice(0, errors.length, ...left);
  return errors;
}

/** Waits until `f` gives something truthy (a thrown error counts as not yet), and returns it; fails after `ms`, with `detail()` if given. */
export async function until<T>(f: () => Promise<T> | T, ms = 5_000, what = "the condition", detail?: () => unknown): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try { const v = await f(); if (v) return v; last = v; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`${what} didn't hold within ${ms} ms (last: ${last instanceof Error ? last.message : JSON.stringify(last)})${detail ? `\n${JSON.stringify(await Promise.resolve().then(detail).catch((e) => String(e)))}` : ""}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Two animation frames in the tab: input just sent has been handled and painted. */
export const settle = (page: Page) => page.evaluate(() => new Promise((r) => { const t = setTimeout(r, 100); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(true); })); }));
