// Where a request's time went, for its Server-Timing header (worker/index.ts):
// how many times it asked the database (D1) and documents' Durable Objects,
// and how long those took, added up (calls made at once each count). On
// erga.dev each is a round trip from wherever the Worker runs, so the count is
// what makes a page slow or fast; tests/bench.ts prints it beside each request.

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

/** One call to the database or a document's Durable Object, counted against the request it's made for (if any). */
export async function counted<T>(kind: "db" | "doc", call: () => Promise<T>): Promise<T> {
  const t = current.getStore();
  if (!t) return call();
  const started = Date.now();
  t[kind]++;
  try { return await call(); } finally { t[kind == "db" ? "dbMs" : "docMs"] += Date.now() - started; }
}
