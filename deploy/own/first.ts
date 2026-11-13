// `bun erga setup <host>`'s own work around `bun erga deploy`'s code (deploy/cli/deploy.ts, deployInstance):
//
// 1. The entries in .erga/config.json, from the answers alone, before the first deploy (no token yet).
// 2. The first deploy, with the secrets that the Worker doesn't hold yet: its own SESSION_SECRET and FACTORY_KEY, the
//    sign-in apps' secrets, and SNAPSHOT_TOKEN when the setup has a staging server. Each is made one time and kept in
//    .erga/secrets.json under its host; a Worker that holds a secret keeps it, and no later deploy sends one.
// 3. After the health check: the first admin and feedback_repository (plan.ts, firstRows), written into the new
//    database with the Cloudflare D1 API. A database that has an admin already gets nothing.
// 4. At the end, register's ops token: the admin signs in and approves it in the browser, and the entry gets it.

import { randomBytes } from "node:crypto";
import { type CloudflareEntry, type Config, entryOf, entryOrigin, readConfig, withEntry, writeConfig } from "../cli/config";
import { type DeployOptions, deployInstance } from "../cli/deploy";
import { askOpsToken, readOps } from "../cli/ops";
import { d1 } from "../pipeline/account";
import { Cloudflare, type Fetch } from "../pipeline/cloudflare-api";
import { type Answers, firstRows, hostOf, SETUP_COMMIT, setupEntry, type TargetName, targetsOf } from "./plan";
import { loadSecrets, saveSecrets } from "./store";

export interface Setup {
  /** .erga/ in the main clone. */
  dir: string;
  answers: Answers;
  account: string;
  zones: string[];
  /** The account's workers.dev subdomain, or null: the first deploy makes one. */
  subdomain: string | null;
  ids: { github?: string; google?: string };
  /** The Cloudflare API and the servers, and the credential. */
  net: Fetch;
  token: string;
  print?: (line: string) => void;
  noTests?: boolean;
  suite?: DeployOptions["suite"];
  /** The commit to deploy (default: SETUP_COMMIT, origin's main). */
  commit?: string;
  /** --home: the homepage's own domain, for the primary (deployInstance's home). */
  home?: string;
}

/**
 * Writes the setup's entries (the primary, and its staging server) into .erga/config.json, with the token each one has.
 * It refuses a host that is registered with other names: setup makes a new instance, and never takes over another.
 */
export function writeEntries(o: Setup): Config {
  let config = readConfig(o.dir);
  for (const t of targetsOf(o.answers)) {
    const want = setupEntry(o.answers, t, o);
    const had = entryOf(config, want.host) as CloudflareEntry | null;
    if (had && "aws" in had) throw new Error(`${want.host} is registered already, on AWS. Setup makes a new instance.`);
    if (had && (had.account != want.account || had.worker != want.worker || had.database != want.database))
      throw new Error(
        `${want.host} is registered already, with the Worker ${had.worker} and the database ${had.database}. Setup makes a new instance: deploy this one with bun erga deploy ${want.host}.`
      );
    // The homepage's domain is the server's (a deploy with --home set it): the entry keeps its copy.
    config = withEntry(config, { ...want, ...(had?.home ? { home: had.home } : {}), token: had?.token ?? "" });
  }
  writeConfig(o.dir, config);
  return config;
}

const random = () => randomBytes(32).toString("hex");

/**
 * The secrets that `t`'s Worker gets with its first deploy: each one it doesn't hold yet (`held`). The server's own are
 * made one time, under its host; the sign-in apps' and SNAPSHOT_TOKEN (a primary and its staging server share it) are
 * under the primary's host. New ones go into the file before the deploy, so a deploy that fails sends the same again.
 */
export function secretsFor(dir: string, a: Answers, t: TargetName, held: string[]): Record<string, string> {
  const file = loadSecrets(dir);
  const host = hostOf(a, t);
  const own = (file[host] ??= {});
  // A new SESSION_SECRET would sign everyone out, and a new FACTORY_KEY would make the values encrypted with the old one
  // unreadable: a Worker that has them keeps them.
  for (const k of ["SESSION_SECRET", "FACTORY_KEY"]) if (!own[k] && !held.includes(k)) own[k] = random();
  const primary = (file[a.host] ??= {});
  if (a.staging && !primary.SNAPSHOT_TOKEN && !held.includes("SNAPSHOT_TOKEN")) primary.SNAPSHOT_TOKEN = random();
  saveSecrets(file, dir);
  const want: Record<string, string | undefined> = {
    SESSION_SECRET: own.SESSION_SECRET,
    FACTORY_KEY: own.FACTORY_KEY,
    GITHUB_CLIENT_SECRET: primary.GITHUB_CLIENT_SECRET,
    ...(a.providers.includes("google") ? { GOOGLE_CLIENT_SECRET: primary.GOOGLE_CLIENT_SECRET } : {}),
    ...(a.staging ? { SNAPSHOT_TOKEN: primary.SNAPSHOT_TOKEN } : {}),
  };
  return Object.fromEntries(Object.entries(want).filter((e): e is [string, string] => !!e[1] && !held.includes(e[0])));
}

/** The first deploy of `t`, then its first rows. The result: the commit it deployed. */
export async function firstDeploy(o: Setup, t: TargetName): Promise<string> {
  const print = o.print ?? console.log;
  const entry = entryOf(writeEntries(o), hostOf(o.answers, t)) as CloudflareEntry;
  const cf = new Cloudflare(o.token, o.net);
  const acc = `/accounts/${o.account}`;
  const held = (
    (await cf.call<{ name: string }[]>(
      "GET",
      `${acc}/workers/scripts/${entry.worker}/secrets`,
      `read ${entry.worker}'s secrets (their names)`,
      undefined,
      {
        allow404: true,
      }
    )) ?? []
  ).map((s) => s.name);
  const sha = await deployInstance({
    dir: o.dir,
    host: entry.host,
    commit: o.commit ?? SETUP_COMMIT,
    command: `bun erga setup ${o.answers.host}`,
    noTests: o.noTests,
    suite: o.suite,
    net: o.net,
    token: o.token,
    print,
    secrets: secretsFor(o.dir, o.answers, t, held),
    createSubdomain: !!entry.subdomain && !o.subdomain,
    ...(o.home && t == "production" ? { home: o.home } : {}),
  });
  await writeFirstRows(cf, acc, entry.worker, o.answers, print);
  return sha;
}

/**
 * The first admin and, if the person gave one, feedback_repository (plan.ts, firstRows): written only into
 * a database with no admin yet, the one `worker` binds as DB. A staging server's is a copy of its primary's (it has the
 * admin already), and a run again, or an admin's later change, stays as it is.
 */
export async function writeFirstRows(cf: Cloudflare, acc: string, worker: string, a: Answers, print: (line: string) => void) {
  const settings = await cf.call<{ bindings?: { type: string; name: string; database_id?: string }[] }>(
    "GET",
    `${acc}/workers/scripts/${worker}/settings`,
    `read ${worker}'s settings`
  );
  const db = settings?.bindings?.find((b) => b.type == "d1" && b.name == "DB")?.database_id;
  if (!db) throw new Error(`The Worker ${worker} binds no database (DB) after the deploy.`);
  const database = `${worker}'s database (${db})`;
  const q = (sql: string, ...p: (string | number)[]) => d1(cf, acc, db, sql, p, "write the first admin");
  const [admin] = (await q("SELECT login FROM users WHERE role = 'admin' LIMIT 1")) ?? [];
  if (admin) {
    print(`The database ${database} has an admin already (${admin.login}): setup writes nothing into it.`);
    return;
  }
  for (const { table, row, onConflict } of firstRows(a))
    await q(
      `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row)
        .map((_, i) => `?${i + 1}`)
        .join(", ")}) ON CONFLICT ${onConflict}`,
      ...Object.values(row)
    );
  print(`${a.admin} is the first admin, in the database ${database}.`);
  if (a.feedback) print(`Feedback opens issues in ${a.feedback} (the setting feedback_repository).`);
}

/**
 * register's ops token for a setup's server: it prints the link, the admin signs in and approves it, and the entry gets
 * the token and the instance's own deploy facts. The result: the admin's login.
 */
export async function registerSetup(dir: string, host: string, o: { site?: Fetch; say?: (line: string) => void } = {}): Promise<string> {
  const known = entryOf(readConfig(dir), host);
  if (!known) throw new Error(`${host} has no entry in .erga/config.json yet: its first deploy writes it.`);
  const origin = entryOrigin(known);
  const { token, login } = await askOpsToken(origin, { label: "bun erga setup", say: o.say, site: o.site });
  const facts = await readOps(origin, token, o.site);
  // Read the file again: another terminal can have changed it while the admin approved.
  const config = readConfig(dir);
  const entry = entryOf(config, host);
  if (!entry) throw new Error(`${host}'s entry left .erga/config.json while the admin approved.`);
  writeConfig(dir, withEntry(config, { ...entry, ...(facts.deploy ?? {}), token }));
  return login;
}
