// The directory, with the server's users and
// settings, on D1, through D1's API. A batch is one transaction.

import { parseDeployed } from "../server/settings";
import { Directory, type Param, type Sql } from "../server/directory";
import { Tokens } from "../server/identity/tokens";

import { withCredentials } from "../server/api-keys";
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
    // A change to the homepage setting, however it's made (the admin page, an agent, the homepage's API, the first /), reaches its deploys.
    const changed = async (key: string) => { if (key == "landing_document" && env.HOME) await env.HOME.getByName("home").homeChanged(); };
    directory = { db: env.DB, dir: new Directory(sqlOn(env.DB), { admins: adminsOf(env), locked: parseDeployed(env.SERVER_CONFIG), changed, credentialSecret: factoryKey(env), fallback: (name) => !!String((env as unknown as Record<string, unknown>)[name] ?? "").trim() }) };
  }
  return directory.dir;
}

/**
 * What encrypts the API keys and sign-in secrets admins enter, each with a key of its
 * own derived from it: FACTORY_KEY, or locally the session secret.
 */
export function factoryKey(env: Env): string | null {
  if (env.FACTORY_KEY?.trim()) return env.FACTORY_KEY.trim();
  return env.ERGA_LINK_SECRET && env.DEV_LOGIN ? `local:${env.SESSION_SECRET}` : null;
}

/** The Worker's bindings with the API keys admins stored in place of the Worker secrets: what the code that calls Anthropic or OpenAI reads. */
export const withKeys = (env: Env): Promise<Env> => withCredentials(env, env.DB ? directoryOf(env).credentials : null);

/**
 * A Durable Object's copy of withKeys, for code that reads a key without
 * waiting (the GitHub mirror, branch deploys): read before the object
 * answers anything, then again in the background at most once a minute, so
 * a key an admin sets or clears takes effect within a minute.
 */
export function keptKeys(ctx: DurableObjectState, env: Env): () => Env {
  let keys = env, at = 0, reading: Promise<void> | null = null;
  const read = () => (reading ??= withKeys(env).then((k) => { keys = k; }, () => {}).finally(() => { at = Date.now(); reading = null; }));
  ctx.blockConcurrencyWhile(read);
  return () => {
    if (Date.now() - at > 60_000) ctx.waitUntil(read());
    return keys;
  };
}

/** Agent tokens, on the same database. */
export function tokensOf(env: Env): Tokens {
  return new Tokens(sqlOn(env.DB), env.SESSION_SECRET, directoryOf(env));
}
