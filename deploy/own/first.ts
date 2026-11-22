// The build of a new instance on Cloudflare (`bun erga setup <host>`, the flow's build and admin steps), around
// `bun erga deploy`'s code (deploy/cli/deploy.ts, deployInstance):
//
// 1. The entry in .erga/config.json, from the answers alone. An entry with other names is not this setup's: it stops.
// 2. The first deploy, with the secrets that the Worker doesn't hold yet: its own SESSION_SECRET and SECRETS_KEY, and
//    with single sign-on at an issuer the client's secret there. Each is made one time (the client's secret: typed by
//    the user) and kept in .erga/secrets.json under its host; a Worker that holds a secret keeps it, and no later
//    deploy sends one. No sign-in app goes with it: the user makes it on the server's setup page.
// 3. After the deploy, healthy: the first rows that the answers name (plan.ts, firstRows), written into the new
//    database with the Cloudflare D1 API. A database that has an admin already gets nothing.
// 4. The first admin: the user finishes on the server's setup page, which setup opens with a one-time link
//    (server/identity/setup.ts). Setup sees the admin in the database (adminOn), with the Cloudflare D1 API: it asks
//    the server nothing.

import { randomBytes } from "node:crypto";
import { type CloudflareEntry, type Config, type Entry, entryOf, readConfig, withEntry, writeConfig } from "../cli/config";
import { type DeployOptions, deployInstance } from "../cli/deploy";
import { entryAt } from "../cli/running";
import { d1 } from "../deployer/cloudflare";
import { Cloudflare, type Fetch } from "../deployer/cloudflare-api";
import { movedNames, OLD_SECRETS_KEY, SECRETS_KEY } from "../deployer/secrets-key";
import type { Seen } from "./flow";
import { type Answers, firstRows, setupEntry } from "./plan";
import { loadSecrets, saveSecrets, SSO_SECRET } from "./store";

export interface First {
  /** .erga/ in the main clone. */
  dir: string;
  answers: Answers;
  seen: Pick<Seen, "zones" | "subdomain" | "held"> & Partial<Pick<Seen, "oidc">>;
  /** The client id of a GitHub app that the deploy itself gives the server (plan.ts, varsOf): setup gives none. */
  github?: string;
  /** The Cloudflare API and the servers, and the credential. */
  net: Fetch;
  token: string;
  print?: (line: string) => void;
  noTests?: boolean;
  suite?: DeployOptions["suite"];
}

/**
 * Writes the setup's entry into .erga/config.json. An entry with other names is not this setup's, and stops it: an
 * instance that runs already is what its entry says.
 */
export function writeEntry(o: First): Config {
  const config = readConfig(o.dir);
  const oidc = o.seen.oidc && "authorize" in o.seen.oidc ? o.seen.oidc : null;
  const want = setupEntry(o.answers, { zones: o.seen.zones, subdomain: o.seen.subdomain, github: o.github, oidc });
  const had = entryOf(config, want.host) as CloudflareEntry | null;
  if (had && "aws" in had) throw new Error(`${want.host} has an entry already, on AWS.`);
  if (had && (had.account != want.account || had.worker != want.worker || had.database != want.database))
    throw new Error(
      `${want.host} has an entry already, with the Worker ${had.worker} and the database ${had.database}: setup would name them ${want.worker} and ${want.database}. Deploy it as it is (bun erga deploy ${want.host}), or take its entry out of .erga/config.json.`
    );
  const next = withEntry(config, want);
  writeConfig(o.dir, next);
  return next;
}

/**
 * The flow's adopt step: the entry of the Erga that runs at the address, which another clone set up, written as
 * `bun erga register` writes it. It tracks what the instance's own spec says; with no spec, what the answers say.
 * It only reads Cloudflare: the instance stays as it is.
 */
export async function adoptEntry(o: Pick<First, "dir" | "answers" | "net" | "token">): Promise<Entry> {
  const a = o.answers;
  const found = await entryAt(a.host, { net: o.net, token: o.token });
  const entry = found.spec ? found.entry : { ...found.entry, repo: a.repo, branch: a.branch };
  writeConfig(o.dir, withEntry(readConfig(o.dir), entry));
  return entry;
}

const random = () => randomBytes(32).toString("hex");

/**
 * The secrets that the server gets with its first deploy: each one it doesn't hold yet (`held`). Its own are made one
 * time, under its host. New ones go into the file before the deploy, so a deploy that fails sends the same again.
 */
export function secretsFor(dir: string, a: Answers, held: string[]): Record<string, string> {
  const file = loadSecrets(dir);
  const own = (file[a.host] ??= {});
  // The key under its old name (deploy/deployer/secrets-key.ts): the file's copy takes the new name, and a server that
  // holds the old name holds the key: its deploy gives it the new name, and setup makes and sends no other.
  if (own[OLD_SECRETS_KEY]) own[SECRETS_KEY] ??= own[OLD_SECRETS_KEY];
  delete own[OLD_SECRETS_KEY];
  const has = movedNames(held);
  // A new SESSION_SECRET would sign everyone out, and a new SECRETS_KEY would make the values encrypted with the old one
  // unreadable: a server that has them keeps them.
  for (const k of ["SESSION_SECRET", SECRETS_KEY]) if (!own[k] && !has.includes(k)) own[k] = random();
  saveSecrets(file, dir);
  const want = { SESSION_SECRET: own.SESSION_SECRET, [SECRETS_KEY]: own[SECRETS_KEY], [SSO_SECRET]: own[SSO_SECRET] };
  return Object.fromEntries(Object.entries(want).filter((e): e is [string, string] => !!e[1] && !has.includes(e[0])));
}

/** The first deploy, then the first rows. The result: the commit it deployed. */
export async function firstDeploy(o: First): Promise<string> {
  const print = o.print ?? console.log;
  const a = o.answers;
  const entry = entryOf(writeEntry(o), a.host) as CloudflareEntry;
  const cf = new Cloudflare(o.token, o.net);
  const acc = `/accounts/${entry.account}`;
  const sha = await deployInstance({
    dir: o.dir,
    host: a.host,
    command: `bun erga setup ${a.host}`,
    noTests: o.noTests,
    suite: o.suite,
    net: o.net,
    token: o.token,
    print,
    secrets: secretsFor(o.dir, a, o.seen.held),
    // Setup wrote the entry from the answers: a run again with other answers (before there is an admin) changes the
    // instance's spec too.
    writeSpec: true,
    createSubdomain: !!entry.subdomain && !o.seen.subdomain,
  });
  await writeFirstRows(cf, acc, entry.worker, a, print);
  return sha;
}

/** The database that `worker` binds as DB, or null: no such Worker, or no database. */
async function databaseOf(cf: Cloudflare, acc: string, worker: string): Promise<string | null> {
  const settings = await cf.call<{ bindings?: { type: string; name: string; database_id?: string }[] }>(
    "GET",
    `${acc}/workers/scripts/${worker}/settings`,
    `read ${worker}'s settings`,
    undefined,
    { allow404: true }
  );
  return settings?.bindings?.find((b) => b.type == "d1" && b.name == "DB")?.database_id ?? null;
}

/**
 * The login of an admin in the database that `worker` binds, read with the Cloudflare D1 API, or null: no admin yet (or
 * no Worker, no database, no tables). Setup's admin step waits for it: the user's own sign-in makes the row.
 */
export async function adminOn(cf: Cloudflare, acc: string, worker: string): Promise<string | null> {
  const db = await databaseOf(cf, acc, worker);
  if (!db) return null;
  const [admin] = (await d1(cf, acc, db, "SELECT login FROM users WHERE role = 'admin' LIMIT 1", [], "look for an admin")) ?? [];
  return admin ? String(admin.login) : null;
}

/**
 * The access rule that the answers name (plan.ts, firstRows): written only into a database with no admin yet, the one
 * `worker` binds as DB. A run again, or an admin's later change, stays as it is.
 */
export async function writeFirstRows(cf: Cloudflare, acc: string, worker: string, a: Answers, print: (line: string) => void) {
  const rows = firstRows(a);
  if (!rows.length) return;
  const db = await databaseOf(cf, acc, worker);
  if (!db) throw new Error(`The Worker ${worker} binds no database (DB) after the deploy.`);
  const q = (sql: string, ...p: (string | number)[]) => d1(cf, acc, db, sql, p, "write the access rule");
  const admin = await adminOn(cf, acc, worker);
  if (admin) return print(`The database of ${worker} has an admin already (${admin}): setup writes nothing into it.`);
  for (const { table, row, onConflict } of rows)
    await q(
      `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row)
        .map((_, i) => `?${i + 1}`)
        .join(", ")}) ON CONFLICT ${onConflict}`,
      ...Object.values(row)
    );
  print(`The access rule is in the database of ${worker}: ${rows.map((r) => r.who).join(", ")} may write.`);
}
