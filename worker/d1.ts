// The document directory (directory.ts) on D1: the same SQL as the local
// host's SQLite file, through D1's API. A batch is one transaction.

import { Directory, type Param, type Sql } from "../directory";
import { Tokens } from "../tokens";
import type { Env } from "./env";

const sqlOn = (db: D1Database): Sql => {
  const statement = (q: string, params: Param[]) => db.prepare(q).bind(...params);
  return {
    all: async <T>(q: string, ...params: Param[]) => (await statement(q, params).all<T>()).results,
    run: async (q, ...params) => { await statement(q, params).run(); },
    batch: async (statements) => { await db.batch(statements.map(([q, ...params]) => statement(q, params))); },
  };
};

// One per isolate, so its memory of documents' routes (they never change) lasts across requests.
let directory: { db: D1Database; dir: Directory } | null = null;

/** The directory, on this Worker's database. */
export function directoryOf(env: Env): Directory {
  if (directory?.db !== env.DB) directory = { db: env.DB, dir: new Directory(sqlOn(env.DB)) };
  return directory.dir;
}

/** Agent tokens (tokens.ts), on the same database. */
export function tokensOf(env: Env): Tokens {
  return new Tokens(sqlOn(env.DB), env.SESSION_SECRET);
}
