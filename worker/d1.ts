// The directory (directory.ts), with the server's users (users.ts) and
// settings (config.ts), on D1, through D1's API. A batch is one transaction.

import { Directory, type Param, type Sql } from "../directory";
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

/**
 * The deploy's bootstrap admins: ADMINS, and locally DEV_LOGIN too (who's
 * signed in without GitHub, so local development always has an admin).
 */
export const adminsOf = (env: Env): string[] =>
  [...(env.ADMINS ?? "").split(","), ...(env.DEV_LOGIN ? [env.DEV_LOGIN] : [])].map((l) => l.trim().toLowerCase()).filter(Boolean);

/** The directory, on this Worker's database. */
export function directoryOf(env: Env): Directory {
  if (directory?.db !== env.DB) directory = { db: env.DB, dir: new Directory(sqlOn(env.DB), { admins: adminsOf(env) }) };
  return directory.dir;
}
