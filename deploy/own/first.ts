// The build of a new instance on Cloudflare (`bun erga setup <host>`, the flow's build and admin steps), around
// `bun erga deploy`'s code (deploy/cli/deploy.ts, deployInstance):
//
// 1. The entry in .erga/config.json, from the answers alone, with no token yet. A registered instance's entry stays
//    as it is: an instance is what its entry says.
// 2. The first deploy, with the secrets that the Worker doesn't hold yet: its own SESSION_SECRET and FACTORY_KEY, the
//    GitHub App's secret, and for a staging instance its primary's SNAPSHOT_TOKEN (a primary with none gets one
//    first). Each is made one time and kept in .erga/secrets.json under its host; a Worker that holds a secret keeps
//    it, and no later deploy sends one.
// 3. After the health check: the access rule that the answers name (plan.ts, firstRows), written into the new
//    database with the Cloudflare D1 API. A database that has an admin already gets nothing.
// 4. The ops token (register): the server asks for one, the person approves it from the setup page's link (a new
//    server: as they claim it, server/identity/claim.ts), and the entry gets it.

import { randomBytes } from "node:crypto";
import { type CloudflareEntry, type Config, entryOf, entryOrigin, isAws, readConfig, withEntry, writeConfig } from "../cli/config";
import { type DeployOptions, deployInstance } from "../cli/deploy";
import { askOpsToken, readOps } from "../cli/ops";
import { replaceSnapshotSecret } from "../cli/snapshot-secret";
import { d1 } from "../pipeline/account";
import { Cloudflare, type Fetch } from "../pipeline/cloudflare-api";
import type { Seen } from "./flow";
import { type Answers, firstRows, SETUP_COMMIT, setupEntry } from "./plan";
import { loadSecrets, saveSecrets } from "./store";

export interface First {
  /** .erga/ in the main clone. */
  dir: string;
  answers: Answers;
  seen: Pick<Seen, "zones" | "subdomain" | "held">;
  /** The GitHub App's client id. */
  github?: string;
  /** The Cloudflare API and the servers, and the credential. */
  net: Fetch;
  token: string;
  print?: (line: string) => void;
  noTests?: boolean;
  suite?: DeployOptions["suite"];
  /** --commit: the commit to deploy in place of SETUP_COMMIT (origin's main). Main never moves to it. */
  commit?: string;
}

/**
 * Writes the setup's entry into .erga/config.json. A registered instance (its entry has an ops token) keeps its entry
 * as it is. An entry with other names is not this setup's, and stops it. A staging instance's primary must be there.
 */
export function writeEntry(o: First): Config {
  const config = readConfig(o.dir);
  const primary = o.answers.stagingOf ? entryOf(config, o.answers.stagingOf) : null;
  if (o.answers.stagingOf && (!primary || isAws(primary)))
    throw new Error(`${o.answers.stagingOf} has no entry on Cloudflare in .erga/config.json: a staging instance needs its primary there.`);
  const want = setupEntry(o.answers, { ...o.seen, github: o.github, ...(primary ? { base: primary.vars } : {}) });
  const had = entryOf(config, want.host) as CloudflareEntry | null;
  if (had && "aws" in had) throw new Error(`${want.host} has an entry already, on AWS.`);
  if (had?.token) return config;
  if (had && (had.account != want.account || had.worker != want.worker || had.database != want.database))
    throw new Error(
      `${want.host} has an entry already, with the Worker ${had.worker} and the database ${had.database}, and no ops token. Register it (bun erga register ${want.host}), or take its entry out of .erga/config.json.`
    );
  const next = withEntry(config, want);
  writeConfig(o.dir, next);
  return next;
}

const random = () => randomBytes(32).toString("hex");

/**
 * The secrets that the server gets with its first deploy: each one it doesn't hold yet (`held`). Its own are made one
 * time, under its host. New ones go into the file before the deploy, so a deploy that fails sends the same again.
 * `snapshot`: a staging instance's copy of its primary's SNAPSHOT_TOKEN.
 */
export function secretsFor(dir: string, a: Answers, held: string[], snapshot?: string): Record<string, string> {
  const file = loadSecrets(dir);
  const own = (file[a.host] ??= {});
  // A new SESSION_SECRET would sign everyone out, and a new FACTORY_KEY would make the values encrypted with the old one
  // unreadable: a server that has them keeps them.
  for (const k of ["SESSION_SECRET", "FACTORY_KEY"]) if (!own[k] && !held.includes(k)) own[k] = random();
  saveSecrets(file, dir);
  const want = {
    SESSION_SECRET: own.SESSION_SECRET,
    FACTORY_KEY: own.FACTORY_KEY,
    GITHUB_CLIENT_SECRET: own.GITHUB_CLIENT_SECRET,
    SNAPSHOT_TOKEN: snapshot,
  };
  return Object.fromEntries(Object.entries(want).filter((e): e is [string, string] => !!e[1] && !held.includes(e[0])));
}

/** The first deploy, then the first rows. The result: the commit it deployed. */
export async function firstDeploy(o: First): Promise<string> {
  const print = o.print ?? console.log;
  const a = o.answers;
  // A staging instance reads its primary's documents with the secret they share: a primary with none here gets a new
  // one first, before the new instance has an entry (it gets the secret with its deploy).
  if (a.stagingOf && !loadSecrets(o.dir)[a.stagingOf]?.SNAPSHOT_TOKEN)
    await replaceSnapshotSecret({ dir: o.dir, host: a.stagingOf, net: o.net, token: o.token, print });
  const entry = entryOf(writeEntry(o), a.host) as CloudflareEntry;
  const cf = new Cloudflare(o.token, o.net);
  const acc = `/accounts/${entry.account}`;
  const sha = await deployInstance({
    dir: o.dir,
    host: a.host,
    commit: o.commit ?? SETUP_COMMIT,
    keepMain: !!o.commit,
    command: `bun erga setup ${a.host}${o.commit ? ` --commit ${o.commit}` : ""}`,
    noTests: o.noTests,
    suite: o.suite,
    net: o.net,
    token: o.token,
    print,
    secrets: secretsFor(o.dir, a, o.seen.held, a.stagingOf ? loadSecrets(o.dir)[a.stagingOf]?.SNAPSHOT_TOKEN : undefined),
    createSubdomain: !!entry.subdomain && !o.seen.subdomain,
  });
  // A staging instance's database is a copy of its primary's: the rules are there.
  if (!a.stagingOf) await writeFirstRows(cf, acc, entry.worker, a, print);
  return sha;
}

/**
 * The access rule that the answers name (plan.ts, firstRows): written only into a database with no admin yet, the one
 * `worker` binds as DB. A run again, or an admin's later change, stays as it is.
 */
export async function writeFirstRows(cf: Cloudflare, acc: string, worker: string, a: Answers, print: (line: string) => void) {
  const rows = firstRows(a);
  if (!rows.length) return;
  const settings = await cf.call<{ bindings?: { type: string; name: string; database_id?: string }[] }>(
    "GET",
    `${acc}/workers/scripts/${worker}/settings`,
    `read ${worker}'s settings`
  );
  const db = settings?.bindings?.find((b) => b.type == "d1" && b.name == "DB")?.database_id;
  if (!db) throw new Error(`The Worker ${worker} binds no database (DB) after the deploy.`);
  const q = (sql: string, ...p: (string | number)[]) => d1(cf, acc, db, sql, p, "write the access rule");
  const [admin] = (await q("SELECT login FROM users WHERE role = 'admin' LIMIT 1")) ?? [];
  if (admin) return print(`The database of ${worker} has an admin already (${admin.login}): setup writes nothing into it.`);
  for (const { table, row, onConflict } of rows)
    await q(
      `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row)
        .map((_, i) => `?${i + 1}`)
        .join(", ")}) ON CONFLICT ${onConflict}`,
      ...Object.values(row)
    );
  print(`The access rule is in the database of ${worker}: ${rows.map((r) => `${r.row.kind} ${r.row.value}`.trim()).join(", ")} may write.`);
}

/**
 * The ops token of the setup's server: the server asks for one, `asked` gets the request's code (the setup page's link
 * carries it), and the call waits until the person approves it. The entry gets the token and the instance's own deploy
 * facts. The result: the person's login.
 */
export async function register(dir: string, host: string, o: { site?: Fetch; asked: (code: string) => void }): Promise<string> {
  const known = entryOf(readConfig(dir), host);
  if (!known) throw new Error(`${host} has no entry in .erga/config.json yet: its first deploy writes it.`);
  const origin = entryOrigin(known);
  const { token, login } = await askOpsToken(origin, {
    label: "bun erga setup",
    site: o.site,
    asked: (url) => o.asked(new URL(url).searchParams.get("code") ?? ""),
  });
  const facts = await readOps(origin, token, o.site);
  // Read the file again: another terminal can have changed it while the person approved.
  const config = readConfig(dir);
  const entry = entryOf(config, host);
  if (!entry) throw new Error(`${host}'s entry left .erga/config.json while the person approved.`);
  writeConfig(dir, withEntry(config, { ...entry, ...(facts.deploy ?? {}), token }));
  return login;
}
