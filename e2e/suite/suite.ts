// The multiplayer suite on e2e: black-box tests of a document room, its
// participants and their agents (tests/suite/target.ts has the contract). The
// tests themselves are tests/suite/suites/*.ts, written against a Target, so
// one test runs against a worker's dev server here and against a deployment
// (prod.ts); each e2e/suite/<name>.e2e.ts file registers some of them with
// `register`. The browser tests are e2e files of their own (browser-*.e2e.ts,
// with `openAs` below), and the latency tests are a bench (latency.bench.e2e.ts).
//
// The target:
//   local (the default)   documents on the worker's suite server (servers.suite: the scripted agent, a short
//                         write delay), each a scratch copy of a fixture linked from disk; a test that restarts
//                         or kills the server gets a server of its own, with its document opened as it starts.
//   remote                ERGA_SUITE_TARGET names a JSON file of RemoteTarget's settings (ERGA_TARGET_DOC and
//                         the rest, tests/suite/target.ts), as prod.ts writes it. A file, not the environment:
//                         the runner drops variables that look like credentials (e2e/env.ts), as cookies do.
//
// Randomised tests are seeded: ERGA_SUITE_SEED=n replays one (a failure names its seed). ERGA_SUITE_LONG=1 runs the
// long versions (bigger crowds, longer fuzzing, real idle-eviction waits), with longer time limits.

import { mkdtempSync, readFileSync, realpathSync, rmSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { servers, settle, SUITE_ENV, test, until, type Page, type Tab } from "../fixtures";
import { editor } from "../editor";
import { startServer, type Server } from "../server";
import { FIXTURES, makeDoc, readFixture, RemoteTarget, type Capability, type Doc, type Target } from "../../tests/suite/target";
import { rng, type Ctx, type Test } from "../../tests/suite/harness";

// y-websocket's provider listens for the process's exit, one listener each: a crowd of thirty is no leak.
process.setMaxListeners(0);

const long = !!process.env.ERGA_SUITE_LONG && process.env.ERGA_SUITE_LONG != "0";
const seed = Number(process.env.ERGA_SUITE_SEED) || Date.now() % 1_000_000;

/** Documents on this worker's suite server, or a server of the test's own. */
class LocalTarget implements Target {
  name = "local";
  parallel = true;
  caps = new Set<Capability>(["restart", "kill", "disk", "roles", "scriptedAgent", "browser"]);

  async newDoc(fixture: string, needs: Capability[] = []): Promise<Doc> {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "erga-suite-"));
    cpSync(join(FIXTURES, fixture), dir, { recursive: true });
    const writeDisk = (p: string, data: string | Uint8Array) => { const full = join(dir, p); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, data); };
    const own = needs.includes("restart") || needs.includes("kill");
    // Its own server opens the folder as it starts, so the document keeps its address across restarts, even one that lost the state.
    const s: Server = own ? await startServer({ env: SUITE_ENV, open: dir }) : await servers.suite();
    const base = own ? s.base : await s.open(dir);
    const info = await (await fetch(`${base}/api/doc`)).json() as { writeDelay?: number; docName?: { id: string } };
    return makeDoc(base, {}, readFixture(fixture), {
      writeDelay: info.writeDelay ?? 400,
      writeDisk,
      // As the dev server's own person (DEV_LOGIN), who opened it from disk and owns it.
      async share(user: string, role: "editor" | "viewer" | null) {
        const r = await fetch(`${s.root}/docs/share`, { method: "POST", headers: { Origin: s.root }, body: new URLSearchParams({ id: info.docName!.id, login: user, role: role ?? "none" }) });
        if (!r.ok) throw new Error(`sharing with ${user}: ${r.status} ${await r.text()}`);
      },
      ...(own ? {
        async restart(how: "graceful" | "kill" | "lose-state", whileDown?: () => Promise<void>) {
          await s.halt(how == "graceful" ? "SIGTERM" : "SIGKILL");
          // The documents' storage goes, the room's saved state with it; the folder is opened afresh on start.
          if (how == "lose-state") rmSync(join(s.state, "v3"), { recursive: true, force: true });
          await whileDown?.();
          await s.start();
        },
      } : {}),
      async dispose() {
        if (own) s.dispose();
        else await fetch(`${s.root}/docs/delete`, { method: "POST", headers: { Origin: s.root }, body: new URLSearchParams({ id: info.docName?.id ?? base.split("/").pop()! }), redirect: "manual" }).catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      },
    });
  }

  async close() {}
}

/** This run's target: local, or the deployment ERGA_SUITE_TARGET describes. */
export const target: Target = (() => {
  const file = process.env.ERGA_SUITE_TARGET;
  if (!file) return new LocalTarget();
  Object.assign(process.env, JSON.parse(readFileSync(file, "utf8")) as Record<string, string>);
  return new RemoteTarget();
})();
export const local = target instanceof LocalTarget;
// The worker's suite server, started as the worker imports its first suite file: outside any test's time limit (fixtures.ts).
if (local) await servers.suite();

/** What a test's own server costs: one start, and a restart or two, each a few seconds (more on a busy machine). */
const OWN_SERVER_MS = 60_000;

/**
 * The time limit for a suite test: 15 s; a test that restarts its own server, OWN_SERVER_MS; one marked slow (crowds,
 * fuzzing, storms: about 5 s on an idle Mac), 30 s; the long versions, six times as long.
 */
function limit(t: Pick<Test, "needs" | "slow">): number {
  const own = local && (t.needs ?? []).some((c) => c == "restart" || c == "kill");
  // (A deployment: every request is a round trip over the internet, and each test makes its document there: four times as long.)
  return (own ? OWN_SERVER_MS : t.slow ? 30_000 : 15_000) * (long ? 6 : 1) * (local ? 1 : 4);
}

/** Why the target can't run a test, if it can't. */
const lacks = (t: Pick<Test, "needs">) => { const m = (t.needs ?? []).filter((c) => !target.caps.has(c)); return m.length ? `the target lacks ${m.join(", ")}` : false; };

/**
 * A Ctx for one test (tests/suite/harness.ts): its documents and deferred steps, undone by `end`. Its documents come
 * with what the test needs (a local target gives one that restarts a server of its own).
 */
export function context(suite: string, name: string, needs: Capability[] = []) {
  const deferred: (() => unknown)[] = [];
  const full = `${suite}: ${name}`;
  const ctx: Ctx = {
    target, seed, long,
    rng: rng(seed ^ hash(full)),
    doc: async (fixture = "page") => { const d = await target.newDoc(fixture, needs); deferred.push(() => d.dispose()); return d; },
    metric: (m, value, unit = "ms") => console.log(`${full}: ${m}=${Math.round(value * 10) / 10}${unit}`),
    log: (line) => { if (process.env.ERGA_SUITE_VERBOSE) console.log(`  ${line}`); },
    defer: (f) => deferred.push(f),
  };
  const end = async () => { for (const f of deferred.reverse()) { try { await f(); } catch { /* cleanup is best effort */ } } };
  return { ctx, end };
}

/** Runs `body`; a failure names the seed and how to replay it. */
async function seeded(file: string, name: string, body: () => Promise<void>) {
  try { await body(); }
  catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    err.message += `\n(seed ${seed}: ERGA_SUITE_SEED=${seed} bun run ${file.endsWith(".bench.e2e.ts") ? "test:bench" : "test:e2e"} ${file} --grep ${JSON.stringify(name.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))})`;
    throw err;
  }
}

/** Part `i` of `n` of a suite's tests (every nth, so a test added anywhere lands in exactly one part): one file each, for parallel workers. */
export const part = (tests: Test[], i: number, n: number) => tests.filter((_, k) => k % n == i - 1);

/** Registers the suite's tests (some of tests/suite/suites/<suite>.ts) as this file's e2e tests. */
export function register(file: string, suite: string, tests: Test[]) {
  for (const t of tests) {
    test(t.name, { timeout: limit(t), skip: lacks(t) }, async () => {
      const { ctx, end } = context(suite, t.name, t.needs);
      try { await seeded(file, t.name, () => t.run(ctx)); } finally { await end(); }
    });
  }
}

/** A browser test of the suite: registered as `register` does, with the test's tab. */
export function browserTest(file: string, name: string, opts: { needs?: Capability[] }, run: (ctx: Ctx, tab: Tab) => Promise<void>) {
  const needs: Capability[] = ["browser", ...(opts.needs ?? [])];
  // Two or three editor tabs open at once, each a second or two to load on an idle Mac: as long as a slow test.
  test(name, { timeout: limit({ needs, slow: true }), skip: lacks({ needs }) }, async ({ tab }) => {
    const { ctx, end } = context("browser", name, needs);
    try { await seeded(file, name, () => run(ctx, tab)); } finally { await end(); }
  });
}

export type Person = ReturnType<typeof editor> & { errors: string[] };

/**
 * Opens the document's shell as a person: the test's tab first, then more tabs in its browser context (one person's
 * tabs share it; so do the test's people, each named by ?user= or their own headers). The tab keeps the agent pane
 * closed until it's asked for, as someone who closed it would.
 */
export async function openAs(tab: Tab, ctx: Ctx, d: Doc, user: string): Promise<Person> {
  const used = opened.get(tab) ?? 0;
  opened.set(tab, used + 1);
  const page: Page = used == 0 ? tab.page : await tab.page.context().newPage();
  const errors = used == 0 ? tab.errors : [];
  if (used > 0) {
    page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
    page.on("console", (m) => { if (m.type() == "error") errors.push(`console.error: ${m.text()}`); });
    ctx.defer(() => page.close());
  }
  await page.setViewportSize({ width: 1100, height: 800 });
  const headers = d.headersFor(user);
  if (Object.keys(headers).length) await page.setExtraHTTPHeaders(headers);
  await page.addInitScript(() => {
    if (window.top != window) return;
    try {
      if (!sessionStorage.getItem("erga-test:agent-seeded")) {
        sessionStorage.setItem("erga-test:agent-seeded", "1");
        if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}');
      }
    } catch { /* no storage */ }
  });
  await page.goto(d.pageUrl(user));
  const ed = editor(page, { address: d.base, dir: "", file: "" });
  await until(async () => await ed.eval<boolean>("!!window.ergaPage") && await ed.frame<boolean>(`!!${ed.F}?.querySelector("[data-erga-id]")`), 10_000, `${user}'s page renders`);
  await ed.frame(`${ed.F}.fonts.ready.then(() => true)`);
  await settle(page);
  return Object.assign(ed, { errors });
}
const opened = new WeakMap<Tab, number>();

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The names on the carets drawn on a person's page, "|"-joined. */
export const peerNames = (p: Person) => p.frame<string>(`[...${p.F}.querySelectorAll("erga-peer-name")].map((e) => e.textContent).join("|")`);
/** Whether a caret drawn on the page sits in the element. */
export const caretIn = (p: Person, selector: string) => p.frame<boolean>(`(() => { const w = ${p.W}, r = ${p.F}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [...${p.F}.querySelectorAll("erga-peer")].some((c) => { const y = parseFloat(c.style.top) - w.scrollY; return y >= r.top - 2 && y < r.bottom; }); })()`);
/** Fails unless the person's tab had no errors. */
export const noErrors = (p: Person, who: string) => { if (p.errors.length) throw new Error(`page errors (${who}):\n${p.errors.join("\n")}`); };
