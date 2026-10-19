// Where a request's time went, for its Server-Timing header:
// how many times it asked the database (D1) and documents' Durable Objects,
// and how long those took, added up (calls made at once each count). On
// erga.dev each is a round trip from wherever the Worker runs, so the count is
// what makes a page slow or fast; e2e/bench/run.ts --waterfall prints the requests.

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
 * for the distance between a Worker and them on erga.dev. Never set there.
 */
let latency = 0;
export const simulateLatency = (ms: number) => { latency = ms > 0 ? ms : 0; };

/** One call to the database or a document's Durable Object, counted against the request it's made for (if any). */
export async function counted<T>(kind: "db" | "doc", call: () => Promise<T>): Promise<T> {
  const t = current.getStore();
  const started = Date.now();
  if (t) t[kind]++;
  try {
    if (latency) await new Promise((r) => setTimeout(r, latency));
    return await call();
  } finally { if (t) t[kind == "db" ? "dbMs" : "docMs"] += Date.now() - started; }
}
