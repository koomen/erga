// The suite's harness: tests, assertions, seeded randomness, metrics, and a
// report. Each test gets a fresh document on the target and cleans up after
// itself, so tests are independent and can run in any order or alone.

import type { Capability, Doc, Target } from "./target";

export interface Ctx {
  target: Target;
  /** A fresh document for this test (disposed when it ends). */
  doc(fixture?: string): Promise<Doc>;
  /** Seeded randomness: the same seed replays the same run. */
  rng: Rng;
  seed: number;
  /** Bigger and longer runs (more clients, more rounds, longer waits). */
  long: boolean;
  /** Records a measurement for the report (e.g. latency in ms). */
  metric(name: string, value: number, unit?: string): void;
  log(line: string): void;
  /** Runs something at the end of the test, even if it fails. */
  defer(f: () => unknown): void;
}

export interface Test {
  name: string;
  /** Capabilities the target must have, or the test is skipped. */
  needs?: Capability[];
  /** A known gap: run and reported, but a failure doesn't fail the suite. */
  known?: string;
  timeoutMs?: number;
  /** Runs alone, after the rest (it measures timing, which other tests running would skew). */
  serial?: boolean;
  /** Takes a while: started first, so it doesn't finish last. */
  slow?: boolean;
  run(ctx: Ctx): Promise<void>;
}

export class Failure extends Error {}

/** Fails the test unless `cond` holds. */
export function expect(cond: unknown, what: string, detail?: unknown): asserts cond {
  if (!cond) throw new Failure(what + (detail === undefined ? "" : `\n${typeof detail == "string" ? detail : JSON.stringify(detail, null, 1).slice(0, 2000)}`));
}

/** Waits until `f` holds, polling; fails with `what` after `ms`. */
export async function until(f: () => unknown | Promise<unknown>, ms: number, what: string, detail?: () => unknown): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { if (await f()) return; } catch { /* not yet */ }
    if (Date.now() - t0 > ms) throw new Failure(`timed out after ${ms}ms: ${what}${detail ? `\n${JSON.stringify(await detail(), null, 1)?.slice(0, 2000)}` : ""}`);
    await sleep(20);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Rng {
  (): number;
  int(n: number): number;
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
}

/** mulberry32: small, fast, and good enough to shuffle edits. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;
  next.int = (n) => Math.floor(next() * n);
  next.pick = (xs) => xs[next.int(xs.length)];
  next.chance = (p) => next() < p;
  return next;
}

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export interface Result {
  suite: string;
  name: string;
  status: "pass" | "fail" | "skip" | "known";
  ms: number;
  detail?: string;
  metrics: { name: string; value: number; unit: string }[];
}

/**
 * Runs the tests. Each has its own document, so
 * they run side by side, `jobs` at a time; tests marked `serial` (timing
 * measurements) run afterwards, alone. A target that hands every test the
 * same document (a deployment's scratch doc) runs everything one at a time.
 */
export async function runTests(target: Target, suites: { name: string; tests: Test[] }[], opts: { seed: number; long: boolean; filter?: RegExp; verbose: boolean; jobs: number }): Promise<Result[]> {
  const results: Result[] = [];
  const queue: { suite: string; t: Test }[] = [];
  for (const suite of suites) for (const t of suite.tests) {
    const full = `${suite.name}: ${t.name}`;
    if (opts.filter && !opts.filter.test(full)) continue;
    const missing = (t.needs ?? []).filter((c) => !target.caps.has(c));
    if (missing.length) {
      results.push({ suite: suite.name, name: t.name, status: "skip", ms: 0, detail: `target lacks ${missing.join(", ")}`, metrics: [] });
      console.log(`skip ${full}  (target lacks ${missing.join(", ")})`);
      continue;
    }
    queue.push({ suite: suite.name, t });
  }
  const one = async ({ suite, t }: { suite: string; t: Test }) => {
    const full = `${suite}: ${t.name}`;
    const deferred: (() => unknown)[] = [];
    const metrics: Result["metrics"] = [];
    const ctx: Ctx = {
      target,
      seed: opts.seed,
      rng: rng(opts.seed ^ hash(full)),
      long: opts.long,
      doc: async (fixture = "page") => { const d = await target.newDoc(fixture, t.needs); deferred.push(() => d.dispose()); return d; },
      metric: (name, value, unit = "ms") => metrics.push({ name, value, unit }),
      log: (line) => { if (opts.verbose) console.log(`     ${line}`); },
      defer: (f) => deferred.push(f),
    };
    const t0 = Date.now();
    let status: Result["status"] = "pass", detail: string | undefined;
    const limit = (t.timeoutMs ?? 60_000) * (opts.long ? 5 : 1);
    try {
      await Promise.race([t.run(ctx), sleep(limit).then(() => { throw new Failure(`test timed out after ${limit}ms`); })]);
    } catch (e) {
      status = t.known ? "known" : "fail";
      detail = e instanceof Failure ? e.message : (e as Error)?.stack ?? String(e);
    }
    for (const f of deferred.reverse()) { try { await f(); } catch { /* cleanup is best effort */ } }
    const ms = Date.now() - t0;
    results.push({ suite, name: t.name, status, ms, detail, metrics });
    const tag = { pass: "ok  ", fail: "FAIL", skip: "skip", known: "gap " }[status];
    const m = metrics.length ? "  " + metrics.map((x) => `${x.name}=${round(x.value)}${x.unit}`).join(" ") : "";
    console.log(`${tag} ${full}  (${(ms / 1000).toFixed(1)}s)${m}`);
    if (detail && status != "pass") console.log(`     ${detail.split("\n").join("\n     ")}${status == "known" ? `\n     known gap: ${t.known}` : ""}`);
  };
  const jobs = target.parallel ? Math.max(1, opts.jobs) : 1;
  // Slowest first, so the long ones don't start last and hold up the end.
  const together = queue.filter((q) => !q.t.serial).sort((a, b) => (b.t.slow ? 1 : 0) - (a.t.slow ? 1 : 0));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, together.length) }, async () => { while (next < together.length) await one(together[next++]); }));
  for (const q of queue.filter((q) => q.t.serial)) await one(q);
  return results;
}

const round = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
