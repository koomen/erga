// The control Worker's database (production's, D1): who is an admin, the
// admin-scope tokens and the change log. Through D1's API; a batch is one
// transaction. The app Worker's directory is cloudflare/d1.ts, over the same
// sqlOn.

import { Directory, type Param, type Sql } from "../server/directory/index.ts";
import { githubAccounts } from "../server/identity/index.ts";
import type { HostEnv } from "./env";

/** D1 as Sql. `count`: each call goes through it (the app's Server-Timing, cloudflare/timing.ts). */
export const sqlOn = (db: D1Database, count: <T>(call: () => Promise<T>) => Promise<T> = (call) => call()): Sql => {
  const statement = (q: string, params: Param[]) => db.prepare(q).bind(...params);
  return {
    all: <T>(q: string, ...params: Param[]) => count(async () => (await statement(q, params).all<T>()).results),
    run: (q, ...params) =>
      count(async () => {
        await statement(q, params).run();
      }),
    batch: (statements) =>
      count(async () => {
        await db.batch(statements.map(([q, ...params]) => statement(q, params)));
      }),
  };
};

// One per isolate, as the app's.
let directory: { db: D1Database; dir: Directory } | null = null;

/**
 * The directory on the control Worker's database, for who is an admin, the tokens and the change log: its admins
 * are ADMINS. No documents, no homepage and no locked settings here.
 */
export function controlDirectory(env: Pick<HostEnv, "DB" | "ADMINS">): Directory {
  if (directory?.db !== env.DB) {
    const dir = new Directory(sqlOn(env.DB), {
      admins: (env.ADMINS ?? "")
        .split(",")
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean),
      github: githubAccounts("https://github.com"),
      credentialSecret: null,
      fallback: (name) => !!String((env as unknown as Record<string, unknown>)[name] ?? "").trim(),
    });
    directory = { db: env.DB, dir };
  }
  return directory.dir;
}
