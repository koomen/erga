// The directory (directory.ts), with the server's users (users.ts) and
// settings (config.ts), on D1, through D1's API. A batch is one transaction.

import { parseDeployed } from "../config";
import { Directory, type Param, type Sql } from "../directory";
import { Tokens } from "../tokens";
import { AdminKeys } from "../admin-keys";
import type { Env } from "./env";
import { counted } from "./timing";

const sqlOn = (db: D1Database): Sql => {
  const statement = (q: string, params: Param[]) => db.prepare(q).bind(...params);
  return {
    all: <T>(q: string, ...params: Param[]) => counted("db", async () => (await statement(q, params).all<T>()).results),
    run: (q, ...params) => counted("db", async () => { await statement(q, params).run(); }),
    batch: (statements) => counted("db", async () => { await db.batch(statements.map(([q, ...params]) => statement(q, params))); }),
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

/** The directory, on this Worker's database, with the settings the deploy locks (SERVER_CONFIG). */
export function directoryOf(env: Env): Directory {
  if (directory?.db !== env.DB) {
    // A change to the homepage setting, however it's made (the admin page, an agent, the homepage's API, the first /), reaches its deploys (worker/home.ts).
    const changed = async (key: string) => { if (key == "landing_document" && env.HOME) await env.HOME.getByName("home").homeChanged(); };
    directory = { db: env.DB, dir: new Directory(sqlOn(env.DB), { admins: adminsOf(env), locked: parseDeployed(env.SERVER_CONFIG), changed }) };
  }
  return directory.dir;
}

/** Agent tokens (tokens.ts), on the same database. */
export function tokensOf(env: Env): Tokens {
  return new Tokens(sqlOn(env.DB), env.SESSION_SECRET);
}

// One per isolate, so its memory of which keys are there (a few seconds) lasts across requests.
let adminKeys: { db: D1Database; keys: AdminKeys } | null = null;

/** Admins' SSH keys and their unlocks (admin-keys.ts), on the same database. */
export function adminKeysOf(env: Env): AdminKeys {
  if (adminKeys?.db !== env.DB) adminKeys = { db: env.DB, keys: new AdminKeys(sqlOn(env.DB), env.SESSION_SECRET) };
  return adminKeys.keys;
}
