// The directory, with the server's users and
// settings, on D1, through D1's API. A batch is one transaction.

import { Directory, parseDeployed, type Param, type Permission, type Sql } from "../server/directory/index.ts";
import { githubAccounts, Tokens } from "../server/identity/index.ts";
import { forgetDecisions } from "../server/documents/index.ts";

import type { Env } from "./env";
import { counted } from "./timing";
import { documentOf } from "./objects/document-stub";

/** The database as Sql, each call counted for the request's Server-Timing. */
export const sqlOn = (db: D1Database): Sql => {
  const statement = (q: string, params: Param[]) => db.prepare(q).bind(...params);
  return {
    all: <T>(q: string, ...params: Param[]) => counted("db", async () => (await statement(q, params).all<T>()).results),
    run: (q, ...params) =>
      counted("db", async () => {
        await statement(q, params).run();
      }),
    batch: (statements) =>
      counted("db", async () => {
        await db.batch(statements.map(([q, ...params]) => statement(q, params)));
      }),
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
    // A document's permissions changed: its object keeps a copy, and decides with it (document/document.ts, authorize).
    const permissionsChanged = async (id: string, permissions: Permission[]) => { forgetDecisions(id); if (permissions.length) await documentOf(env, id).setPermissions(permissions.map((p) => ({ login: p.login, role: p.role }))); };
    const dir = new Directory(sqlOn(env.DB), {
      admins: adminsOf(env),
      locked: parseDeployed(env.SERVER_CONFIG),
      // Local development offers anyone with the link, as before the Access page's switch (a server starts with it off).
      // And everyone may sign in there (server/identity/accounts.ts, mayJoin), so anyone may get a share.
      ...(env.DEV_LOGIN?.trim() ? { local: true } : {}),
      // The deploy's defaults (an instance's preset: SERVER_DEFAULTS), and locally public_sharing on.
      defaults: { ...parseDeployed(env.SERVER_DEFAULTS), ...(env.DEV_LOGIN?.trim() ? { public_sharing: true } : {}) },
      // A GitHub account added on the Users page: its id, from GitHub's public users API (locally, the pretend GitHub's).
      github: githubAccounts((env.DEV_LOGIN && env.ERGA_GITHUB_ORIGIN?.trim().replace(/\/+$/, "")) || "https://github.com"),
      changed,
      permissionsChanged,
      // An open page's rows follow every change (server/news/).
      news: async (news) => {
        await env.NEWS?.getByName("news").publish(news);
      },
      credentialSecret: factoryKey(env),
      fallback: (name) => !!String((env as unknown as Record<string, unknown>)[name] ?? "").trim(),
    });
    directory = { db: env.DB, dir };
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

/** Agent tokens, on the same database. */
export function tokensOf(env: Env): Tokens {
  return new Tokens(sqlOn(env.DB), env.SESSION_SECRET, directoryOf(env));
}
