// Where a request's time went, for its Server-Timing header:
// how many times it asked the database (D1) and documents' Durable Objects,
// and how long those took, added up (calls made at once each count). On
// a deployed instance each is a round trip from wherever the Worker runs, so the count is
// what makes a page slow or fast; e2e/bench/run.ts --waterfall prints the requests.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { AsyncLocalStorage } from "node:async_hooks";

interface Tally { db: number; dbMs: number; doc: number; docMs: number }
const current = new AsyncLocalStorage<Tally>();

/** Runs `f` (a request), counting what it asks of the database and documents: its answer, and the Server-Timing entries. */
export async function tallied<T>(f: () => Promise<T>): Promise<{ value: T; timing: string[] }> {
  const t: Tally = { db: 0, dbMs: 0, doc: 0, docMs: 0 };
  const value = await current.run(t, f);
  const timing = [
    ...(t.db ? [`db;desc="${t.db} quer${t.db == 1 ? "y" : "ies"}";dur=${t.dbMs}`] : []),
    ...(t.doc ? [`doc;desc="${t.doc} call${t.doc == 1 ? "" : "s"}";dur=${t.docMs}`] : []),
  ];
  return { value, timing };
}

/**
 * Local development only (ERGA_REMOTE_LATENCY_MS, which e2e/bench/run.ts sets):
 * how long each call to the database or a document waits first, standing in
 * for the distance between a Worker and them on a deployed instance. Never set there.
 */
let latency = 0;
export const simulateLatency = (ms: number) => { latency = ms > 0 ? ms : 0; };

/** One call to the database or a document's Durable Object, counted against the request it's made for (if any). */
export async function counted<T>(kind: "db" | "doc", call: () => Promise<T>): Promise<T> {
  const t = current.getStore();
  const started = Date.now();
  if (t) t[kind]++;
  try {
    if (latency) await Effect.runPromise(Effect.sleep(Duration.millis(latency)));
    return await call();
  } finally {
    if (t) t[kind == "db" ? "dbMs" : "docMs"] += Date.now() - started;
  }
}

/** A query slower than this is logged: D1 answers in tens of milliseconds, and its stalls of seconds hold up every page. */
export const SLOW_QUERY_MS = 500;

/** What D1 says of a call: how long the SQL took in the database, and how many times D1 tried it. */
export interface D1Took {
  duration?: number;
  total_attempts?: number;
}

/**
 * The log line for a slow query (null: not slow): how long it took here, how long D1 says the SQL took (the rest is
 * the trip and D1's queue), its attempts, and the SQL with no parameters (they may be secrets or tokens).
 */
export function slowQueryLine(ms: number, sql: string, took?: D1Took): string | null {
  if (ms < SLOW_QUERY_MS) return null;
  const inD1 = typeof took?.duration == "number" ? `, sql ${Math.round(took.duration * 10) / 10}ms` : "";
  const attempts = took?.total_attempts && took.total_attempts > 1 ? `, ${took.total_attempts} attempts` : "";
  return `slow d1 query: ${ms}ms${inD1}${attempts}: ${sql.replace(/\s+/g, " ").trim().slice(0, 200)}`;
}
