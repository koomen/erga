// The tests' fixtures, on e2e and its web engine.
//
// Per worker, started on first use: the test servers (servers.*). A worker keeps the suite's one server
// (servers.main) for all its files, and one servers.of at a time (`once`). e2e has no worker-scoped fixtures
// (test.extend's run for every test), so these live in a registry in this module, which a worker imports once (e2e
// imports each test file afresh for every file and retry, but not the modules it imports).
//
// A file starts the servers it needs at its top level, as the worker imports it: `const s = await servers.main();`.
// e2e waits for that import with no time limit, so no test or hook pays for a server. The runner imports every
// file too, only to list its tests: there servers.* start nothing (WORKER). A file's own processes start the same
// way, in beforeTests(). A test may call servers.x() again for the server (at once: started), which also starts
// again one that stopped by itself. They stop when the worker exits, and e2e/run.ts sweeps up after a worker that
// was killed. Hooks get config.timeout (90 s, e2e.config.ts) as a backstop; each test gets ERGA_TEST_MS (15 s,
// which `test` below gives it).
//
//   servers.main()     the suite's one server (ONE, below): signed in as DEV_LOGIN, the scripted agent model
//   servers.of(key, o) a server one file needs alone (its own settings, or one it changes or restarts), started
//                      with ServerOptions `o`: `const own = await servers.of("homepage");` (the worker keeps the
//                      last file's only)
//   startServer()      a server for one test alone, started inside its time limit (see `tab.own`): only where each
//                      attempt needs a fresh one
//
// Per test: `tab`, the attempt's own page in a fresh browser context (the web engine makes one per attempt), as
// Playwright's Page, with the page's errors collected from every frame. The steps of a journey (`journey`, below)
// share one page. e2e's `browser` fixture reads only the main frame and has no frame-level evaluate, modifier-held
// clicks or insertText, which the editor's tests need, so the tests drive the Playwright page underneath it
// (surfaceOf).
//
// Files share a worker's server one after another, never at once, and each makes its own data (documents, tokens,
// people), so none depends on another or on their order. Trap: the one server keeps what earlier files made: the
// documents list holds their documents, and a person has ONE agent conversation for all documents. A check that
// counts rows or messages uses a person of its own, or starts a new conversation first.

import { surfaceOf, test as web } from "@e2e-dev/web";
import { describe, expect as e2eExpect } from "e2e";
import type { Page } from "playwright-core";
import { engine } from "./engine";
import { startServer, type Server, type ServerOptions } from "./server";

/**
 * e2e's expect, with an `expect.poll` that reads again every 20 ms. e2e's own pause is 100 ms: a state that comes
 * in a frame or two then costs 100 ms, in each of the hundreds of polls of a run. A time limit that a test gives is
 * multiplied by the factor for a busy machine.
 */
/** The time limits' factor for a busy machine (e2e.config.ts, timeFactor): a wait's limit is multiplied by it. */
const FACTOR = Number(process.env.ERGA_TIME_FACTOR) || 1;

export const expect = new Proxy(e2eExpect, {
  get(target, key, receiver) {
    if (key != "poll") return Reflect.get(target, key, receiver);
    return (read: () => unknown, options?: { timeout?: number }) =>
      target.poll(read, { interval: 20, ...options, ...(options?.timeout ? { timeout: options.timeout * FACTOR } : {}) });
  },
}) as typeof e2eExpect;
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
  if (!s) { s = make(); started.set(key, s); s.catch(() => started.delete(key)); }
  // One that stopped by itself (server.ts says why) is started again, for the tests after.
  return s.then((x) => { if (x.alive()) return x; x.dispose(); started.delete(key); return once(key, make)(); }) as Promise<T>;
};

/** The suite's version timings: a version is cut once edits pause for `idle` ms (or after `max`, whatever the typing). */
export const SHORT = { idle: 1000, max: 8000 };

/**
 * The suite's one kind of server (servers.main): the scripted agent model (so the agent's UI is on, and a message plays
 * the tool calls it lists), a short write delay, and short version timings (SHORT). One kind, so a worker starts one
 * server and keeps it for all its files: a server start costs 3 s, and more on a busy machine.
 */
const ONE = {
  ERGA_AGENT_MODEL: "script",
  ERGA_WRITE_DELAY_MS: "50",
  ERGA_VERSION_IDLE_MS: String(SHORT.idle),
  ERGA_VERSION_MAX_MS: String(SHORT.max),
  ERGA_HOME_RECHECK_MS: "0",
};

export const servers = {
  main: once("main", () => startServer({ env: ONE })),
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
  /**
   * The page is known not to show its HTML at some point (the page editor's check logs it: libs/text/ui/check.ts):
   * what is wrong. The test fails if the check finds nothing, so the fix takes the mark off (as knownBug).
   */
  knownDrift?: string;
  /** A server for this test alone, disposed of after it. */
  own(opts?: ServerOptions): Promise<Server>;
}

/** What the page editor's check logs when the page does not show its HTML (libs/text/ui/render.ts, report). */
const DRIFT = "the page does not show its HTML";

/** A page's errors and refused requests, kept for as long as the page lives: a journey's steps share one page. */
const heard = new WeakMap<Page, { errors: string[]; refused: string[]; strict: boolean }>();

const extended = web.extend<{ tab: Tab }>({
  tab: async ({ browser }, use) => {
    // The attempt's page exists once something has navigated it. A journey's later steps find the page of the first.
    const open = () => {
      try {
        return surfaceOf(engine)!.page() as unknown as Page;
      } catch {
        return null;
      }
    };
    const page = open() ?? (await browser.goto("about:blank"), open()!);
    let h = heard.get(page);
    if (!h) {
      const errors: string[] = [],
        refused: string[] = [];
      heard.set(page, (h = { errors, refused, strict: false }));
      page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
      page.on("console", (m) => { if (m.type() == "error") errors.push(`console.error: ${m.text()}`); });
      // (The browser's own "Failed to load resource" never names the address: these do, beside it.)
      page.on("response", (r) => {
        if (r.status() >= 400) refused.push(`${r.status()} ${r.request().method()} ${r.url()}`);
      });
    }
    const { errors, refused } = h;
    const owned: Server[] = [];
    const tab: Tab = {
      page,
      errors,
      strict: h.strict,
      async own(opts) {
        const s = await startServer(opts);
        owned.push(s);
        return s;
      },
    };
    try { await use(tab); } finally { for (const s of owned) s.dispose(); }
    h.strict = tab.strict;
    if (tab.knownDrift) {
      const drift = errors.filter((e) => e.includes(DRIFT));
      if (!drift.length) throw new Error(`the page shows its HTML now: take off the knownDrift mark (${tab.knownDrift})`);
      errors.splice(0, errors.length, ...errors.filter((e) => !e.includes(DRIFT)));
    }
    if (tab.strict && errors.length)
      throw new Error(
        `the page had errors:\n${errors.join("\n")}${refused.length ? `\nrequests the server refused:\n${refused.join("\n")}` : ""}`
      );
  },
});

/**
 * A journey: one user path as steps, each a test with its own name and time limit, in order, on ONE page (e2e's serial
 * group). The first step opens the page (`tab`, openEditor); the later steps go on where the one before stopped (keep
 * what they share in a `let` of the journey). A step that fails skips the steps after it. A page load costs about as
 * much as ten checks: a new check is a step of a journey, or a line of a step, before it is a test with a page of its own.
 */
export const journey = (name: string, steps: () => void) =>
  describe(name, { serial: true }, () => {
    // After each step, the page's errors fail it (the `tab` fixture's end), also when the step itself took no `tab`.
    extended.afterEach(async ({ tab: _ }) => {});
    steps();
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
    if (b === undefined) return Reflect.apply(target, self, [title, { timeout: ms }, a]);
    // A test's own limit is for a quiet machine: the factor for a busy one multiplies it, as it does ERGA_TEST_MS.
    const own = (a as { timeout?: number }).timeout;
    return Reflect.apply(target, self, [title, { ...(a as object), timeout: own ? own * FACTOR : ms }, b]);
  },
}) as typeof extended;

/**
 * A test of a known bug, with the right expectations (Playwright's test.fail): it passes while its body fails, and fails
 * once the bug is fixed, so the fix takes the mark off. Say what the bug is in a comment above it.
 */
export const knownBug =
  <A>(body: (a: A) => Promise<void>) =>
  async (a: A) => {
    try {
      await body(a);
    } catch {
      return;
    }
    throw new Error("this test of a known bug passes now: the bug is fixed, so take off its knownBug mark");
  };

/**
 * Takes out of `errors` (in place) what the browser logs for requests that failed because the server was down
 * ("Failed to load resource: net::ERR_CONNECTION_REFUSED", "WebSocket connection to ... failed"), which Playwright reports as console errors: a restart
 * (a server of the test's own, halted) means some. What's left is the page's own errors. The error's name depends on the
 * instant: a request written to a kept socket that the killed server had closed is ERR_SOCKET_NOT_CONNECTED (one run
 * in 5 of the suite on a busy machine had it, where the list did not).
 */
export function withoutOutage(errors: string[]): string[] {
  const left = errors.filter(
    (e) =>
      !/^console\.error: (Failed to load resource|WebSocket connection to '[^']*' failed)\b.*net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|INCOMPLETE_CHUNKED_ENCODING|EMPTY_RESPONSE|CONNECTION_CLOSED|SOCKET_NOT_CONNECTED|CONNECTION_ABORTED)\b/.test(
        e
      )
  );
  errors.splice(0, errors.length, ...left);
  return errors;
}

/** Waits until `f` gives something truthy (a thrown error counts as not yet), and returns it; fails after `ms`, with `detail()` if given. */
export async function until<T>(f: () => Promise<T> | T, ms = 5_000, what = "the condition", detail?: () => unknown): Promise<T> {
  const end = Date.now() + ms * FACTOR;
  let last: unknown;
  for (;;) {
    try {
      const v = await f();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end)
      throw new Error(
        `${what} didn't hold within ${ms} ms (last: ${last instanceof Error ? last.message : JSON.stringify(last)})${
          detail
            ? `\n${JSON.stringify(
                await Promise.resolve()
                  .then(detail)
                  .catch((e) => String(e))
              )?.slice(0, 2000)}`
            : ""
        }`
      );
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Two animation frames in the tab: input just sent has been handled and painted. */
export const settle = (page: Page) => page.evaluate(() => new Promise((r) => { const t = setTimeout(r, 100); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(true); })); }));
