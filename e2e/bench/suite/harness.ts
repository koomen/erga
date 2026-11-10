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
