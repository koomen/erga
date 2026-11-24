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
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { type CloudflareEntry, type Config, type Entry, entryOf, isAws, readConfig, withEntry, writeConfig } from "../cli/config";
import { type DeployOptions, deployInstance, entryTarget, mocked } from "../cli/deploy";
import { heldSecrets, putSpec, specOf, specOn, sqlOf } from "../cli/instance";
import { entryAt } from "../cli/running";
import { d1, d1Sql } from "../deployer/cloudflare";
import { setUpAuto } from "../deployer/control";
import { Cloudflare, type Fetch } from "../deployer/cloudflare-api";
import { movedNames, OLD_SECRETS_KEY, SECRETS_KEY } from "../deployer/secrets-key";
import type { AutoMode } from "../deployer/tags";
import { SSO } from "../../shared/sign-in";
import { type Account, lacksText, type Seen } from "./flow";
import { installDeployer, removeDeployer } from "../pipeline/deployer";
import { ensurePagesAddress, pagesAddressOf, type PagesTarget, runWith } from "../pipeline/pipeline";
import { type Answers, type Endpoints, firstRows, type Keep, movedEntry, setupEntry } from "./plan";
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
  const entry = await adoptedEntry(o);
  writeConfig(o.dir, withEntry(readConfig(o.dir), entry));
  return entry;
}

/** The entry that the adopt step writes, read from Cloudflare: the dry run's plan is the instance's step after it. It writes nothing. */
export async function adoptedEntry(o: Pick<First, "answers" | "net" | "token">): Promise<Entry> {
  const a = o.answers;
  const found = await entryAt(a.host, { net: o.net, token: o.token });
  return found.spec ? found.entry : { ...found.entry, repo: a.repo, branch: a.branch };
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
export async function databaseOf(cf: Cloudflare, acc: string, worker: string): Promise<string | null> {
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

/** One statement of the instance's database, with its values: the rows it gives. */
export type Query = (sql: string, params: (string | number | null)[]) => Promise<Record<string, unknown>[]>;

/**
 * The accounts of an instance that runs, as its database has them: each one's role, whether it signs in with the
 * organization's single sign-on already, the addresses that its other sign-ins verified, and the address of the row
 * that keeps it for its person. `keepable`: the database has a place for such rows (server/migrations/0570).
 */
export async function accountsOf(q: Query): Promise<{ accounts: Account[]; keepable: boolean }> {
  const none = (e: Error) => (/no such (table|column)/.test(e.message) ? null : Promise.reject(e));
  const users = (await q("SELECT login, role FROM users ORDER BY login", []).catch(none)) ?? [];
  const has = (await q("SELECT login FROM identities WHERE provider = ?1", [SSO]).catch(none)) ?? [];
  const emails = (await q("SELECT login, email FROM emails WHERE provider != ?1 ORDER BY email", [SSO]).catch(none)) ?? [];
  const kept = await q("SELECT login, handle FROM people WHERE provider = ?1 AND login IS NOT NULL ORDER BY id", [SSO]).catch(none);
  return {
    keepable: !!kept,
    accounts: users.map((u) => ({
      login: String(u.login),
      admin: u.role == "admin",
      sso: has.some((i) => i.login == u.login),
      emails: [...new Set(emails.filter((e) => e.login == u.login).map((e) => String(e.email)))],
      keeps: (kept ?? []).filter((k) => k.login == u.login).map((k) => String(k.handle))[0] ?? null,
    })),
  };
}

/**
 * Writes the rows that keep each account for its person (server/directory/people.ts, `keeps`): the person who signs
 * in at the organization's sign-in with that address, verified, takes that account. One row for an account: a new
 * address replaces the one before. A person who waits under that address (an admin added them) waits no more: the
 * address is the account's.
 *
 * Trap: the row's role is "read", and no code of this release reads it (the account has its own role). A Worker from
 * before these rows, after a rollback, takes the row for a person that an admin added, and gives a new account that
 * role: so it is the lowest one.
 */
export async function writeKeeps(q: Query, rows: Keep[], now = Date.now()): Promise<void> {
  for (const { login, email } of rows) {
    await q("DELETE FROM people WHERE provider = ?1 AND (login = ?2 OR handle = ?3)", [SSO, login, email]);
    await q(
      "INSERT INTO people (provider, handle, subject, role, created, added_by, added_via, login) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      [SSO, email, null, "read", now, null, "bun erga setup", login]
    );
  }
}

/** The instance's database, for setup's own reads and writes there. */
export async function queryOf(cf: Cloudflare, acc: string, worker: string, what: string): Promise<Query> {
  const db = await databaseOf(cf, acc, worker);
  if (!db) throw new Error(`The Worker ${worker} binds no database (DB).`);
  return (sql, params) => d1(cf, acc, db, sql, params, what).then((r) => r ?? []);
}

/**
 * The flow's move step: the entry with what the answers change in it (plan.ts, movedEntry), then a deploy of the
 * tracked branch's head with that entry as the instance's spec. The result: the commit it deployed.
 *
 * A move of the pages to a domain makes their address there first, before it changes anything else: the wildcard DNS
 * record and the Worker's route (pipeline.ts, ensurePagesAddress). The deploy changes the code only, and makes
 * neither: without them no page answers on the domain. They stay when the deploy fails: the next run finds them.
 *
 * Trap: the deploy writes the spec before it builds or tests. A deploy that fails puts both back, the entry and the
 * instance's spec: else the instance's deployer applies the change by itself at its next look, and the next run of
 * setup sees an entry that says the move is done.
 */
export async function moveDeploy(
  o: Pick<First, "dir" | "answers" | "net" | "token" | "print" | "noTests" | "suite" | "github"> & {
    oidc?: Endpoints | null;
    change: { vars: readonly string[]; pages: string | null };
  }
): Promise<string> {
  const config = readConfig(o.dir);
  const had = entryOf(config, o.answers.host);
  if (!had || "aws" in had) throw new Error(`${o.answers.host} has no entry on Cloudflare in .erga/config.json.`);
  const reach = { cf: new Cloudflare(o.token, o.net) };
  const moved = movedEntry(had, o.answers, o.change, { github: o.github, oidc: o.oidc });
  if (o.change.pages && moved.pages.kind == "zone") await ensurePagesAddress(reach.cf, { ...entryTarget(moved), pages: moved.pages });
  const sql = await sqlOf(had, reach);
  const spec = (await specOn(sql)) ?? specOf(had, await heldSecrets(had, reach));
  writeConfig(o.dir, withEntry(config, moved));
  const back = async (e: Error) => {
    writeConfig(o.dir, withEntry(readConfig(o.dir), had));
    if (!(await putSpec(sql, spec)))
      throw new Error(
        `${e.message}\nAnd the instance's spec did not go back to what it was: bun erga deploy ${had.host} --write-spec writes the entry's values there.`
      );
    throw e;
  };
  return deployInstance({
    dir: o.dir,
    host: o.answers.host,
    command: `bun erga setup ${o.answers.host}`,
    noTests: o.noTests,
    suite: o.suite,
    net: o.net,
    token: o.token,
    print: o.print ?? console.log,
    writeSpec: true,
  }).catch(back);
}

/** The pages' target of an instance's entry: its account, its Worker and the pages' zone. */
function pagesTarget(dir: string, host: string): PagesTarget {
  const entry = entryOf(readConfig(dir), host);
  if (!entry || isAws(entry) || entry.pages.kind != "zone")
    throw new Error(`The entry of ${host} names no domain for the documents' pages.`);
  return { ...entryTarget(entry), pages: entry.pages };
}

/**
 * Whether a page answers on the documents' domain: a request for the page that every name there answers
 * (server/identity/caller.ts, WARM_PATH). An answer under 500 is the server's, or its gate's: the name resolves, its
 * certificate is there, and a Worker answers. It asks for a minute, each time under a new name: a new DNS record takes
 * some seconds, and a resolver keeps "no such name" for a name that it asked before. Null: a page answers; else why not.
 *
 * Trap: this is setup's one request to a deployed server. Every other check reads Cloudflare's API (facts.ts).
 */
export function pageAnswers(net: Fetch, domain: string): Promise<string | null> {
  const ask = Effect.suspend(() => {
    const url = `https://check-${randomBytes(4).toString("hex")}.${domain}/erga-warm`;
    return Effect.tryPromise({
      try: () => net(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) }),
      catch: (e) => `${url}: ${(e as Error).message}`,
    }).pipe(Effect.flatMap((r) => (r.status < 500 ? Effect.succeed(null) : Effect.fail(`${url}: status ${r.status}`))));
  });
  const asked = ask.pipe(
    Effect.retry({ schedule: Schedule.spaced("5 seconds").pipe(Schedule.upTo({ duration: "1 minute" })) }),
    Effect.catch((why) => Effect.succeed(why))
  );
  return runWith(mocked() ? async () => {} : undefined, asked);
}

/**
 * The flow's pages step: the pages' wildcard DNS record and their route on their domain, each made if the domain
 * lacks it (pipeline.ts, ensurePagesAddress). Then it asks a page there. The answer: why no page answers yet, or null.
 */
export async function makePagesAddress(c: { cf: Cloudflare; net: Fetch }, dir: string, host: string): Promise<string | null> {
  return pageAnswers(c.net, (await ensurePagesAddress(c.cf, pagesTarget(dir, host))).name);
}

/**
 * The flow's old-pages step: deletes the Worker of the shared pages address (<worker>-pages), only after the checks
 * that the pages are on their domain. Read from Cloudflare now: the domain has the wildcard DNS record and the route
 * to the instance's Worker. Then asked: a page answers there. Else it throws why, and the Worker stays.
 */
export async function removeOldPages(c: { cf: Cloudflare; net: Fetch }, dir: string, host: string): Promise<void> {
  const t = pagesTarget(dir, host);
  const old = `${t.workerName}-pages`;
  const at = await pagesAddressOf(c.cf, t);
  if (!at.record || !at.route)
    throw new Error(`${at.name} has ${lacksText(at.name, t.workerName, at)}. The Worker of the old pages address (${old}) stays.`);
  const why = await pageAnswers(c.net, at.name);
  if (why) throw new Error(`No page answers on ${at.name} (${why}). The Worker of the old pages address (${old}) stays.`);
  await c.cf.call(
    "DELETE",
    `/accounts/${t.accountId}/workers/scripts/${old}?force=true`,
    "delete the Worker of the old pages address",
    undefined,
    {
      allow404: true,
    }
  );
}

/**
 * Setup's part in the auto-deploy of an instance on Cloudflare: the mode that the user chose, else the mode that the
 * instance has, else releases (control.ts, setUpAuto). The answer: the mode now.
 */
export const autoOnCloudflare = (cf: Cloudflare, target: { account: string; worker: string }, chosen?: AutoMode): Promise<AutoMode> =>
  Effect.runPromise(setUpAuto(d1Sql(cf, target), chosen));

/**
 * Cloudflare, for an instance that runs: its deployer, installed with no token (or removed), and then a deploy of the
 * release that the instance runs (`commit`), so that its Worker binds the deployer (or binds it no more): the server
 * hands the deployer the token that the user pastes there. Auto-deploy first, before a deployer looks: the mode that
 * the user chose (`auto`), else the mode that the instance has, else releases (control.ts, setUpAuto).
 *
 * The answer, for an install. `replaced`: a deployer was there, from before the deployer kept its own token: a new
 * one is in its place, and the old one's token is gone. `auto`: the instance's auto-deploy mode now.
 */
export async function setDeployer(o: {
  dir: string;
  host: string;
  target: { account: string; worker: string };
  to: "install" | "remove";
  auto?: AutoMode;
  /** The release that the instance runs (none: its branch's head). */
  commit?: string;
  command: string;
  cf: Cloudflare;
  net: Fetch;
  token: string;
  print?: (line: string) => void;
}): Promise<{ replaced: boolean; auto: AutoMode } | null> {
  let did: { replaced: boolean; auto: AutoMode } | null = null;
  if (o.to == "remove") await removeDeployer(o.cf, o.target);
  else {
    const auto = await autoOnCloudflare(o.cf, o.target, o.auto);
    did = { replaced: (await installDeployer(o.cf, o.target)).replaced, auto };
  }
  // The release that runs is the one that deploys: its tests ran before its first deploy.
  await deployInstance({
    dir: o.dir,
    host: o.host,
    commit: o.commit,
    command: o.command,
    noTests: true,
    deployerStays: true,
    net: o.net,
    token: o.token,
    print: o.print,
  });
  return did;
}
