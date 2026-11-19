// What the parts of the verify harness share (dev/verify.ts): the settings, a deployed setting's values (kept in a
// file between the steps), and the report's rows.
// The suite's files are in .erga/verify/ of the main clone (suiteDir), which each work folder shares: a setting that
// one folder deployed and kept (`--keep`) takes another folder's code (`bun erga verify update`).

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ergaDir, readConfig } from "../../deploy/cli/config.ts";
import { hostsOf, type Local, readLocal } from "./config.ts";
import { hostProblem, under } from "./safe.ts";

/** A setting of the plan's table. Where the gate runs, who signs people in, where the documents are. */
export interface Setting {
  n: number;
  name: string;
  where: "cloudflare" | "aws";
  who: "oauth" | "sso" | "access";
  /** The shell's host, and the content domain. */
  shell: string;
  content: string;
}

/**
 * This machine's settings (config.ts: .erga/verify.json; no instance's name is in the code), read one time. It throws
 * on settings that the suite may not use (safe.ts).
 */
let read: Local | null = null;
export const local = (): Local => {
  const dir = ergaDir();
  read ??= readLocal(dir, hostsOf(readConfig(dir)));
  if (read.problem) throw new Error(read.problem);
  return read;
};
/** The two Cloudflare test zones: every host of a Worker is under one of them. */
export const cloudflareZones = (): string[] => [local().cloudflare.shell, local().cloudflare.content];

/** An app's host on AWS: erga-verify-<unit>.<the shells' zone>. So the stack's name (deploy/own/plan.ts, stackOf) starts with erga-verify-<unit>. */
export const awsHost = (unit: string, shell: string) => `erga-verify-${unit}.${shell}`;

/**
 * The plan's settings, with their hosts under the test zones. On Cloudflare: s<n>.<shell>, and content under
 * c<n>.<content>. On AWS: the app's host (awsHost), and the documents' pages on the content zone itself, as setup
 * asks of an instance with no gate in front: a whole zone that is not the app's.
 */
export const settingsOf = (cf: { shell: string; content: string }, aws: { shell: string; content: string }): Setting[] => {
  const shell = (n: number) => `s${n}.${cf.shell}`;
  const content = (n: number) => `c${n}.${cf.content}`;
  return [
    { n: 1, name: "cf-oauth", where: "cloudflare", who: "oauth", shell: shell(1), content: content(1) },
    { n: 2, name: "cf-sso", where: "cloudflare", who: "sso", shell: shell(2), content: content(2) },
    { n: 3, name: "cf-sso-same", where: "cloudflare", who: "sso", shell: shell(3), content: `p.${shell(3)}` },
    { n: 4, name: "cf-access", where: "cloudflare", who: "access", shell: shell(4), content: content(4) },
    { n: 5, name: "aws-sso", where: "aws", who: "sso", shell: awsHost("5", aws.shell), content: aws.content },
    { n: 6, name: "aws-oauth", where: "aws", who: "oauth", shell: awsHost("6", aws.shell), content: aws.content },
  ];
};
export const settings = (): Setting[] => settingsOf(local().cloudflare, local().aws);

/** A deployed setting: what the checks need, and what `remove` removes. */
export interface Run extends Setting {
  /** The edge key. */
  key: string;
  /** The key that a gate in front proves itself to Erga with (GATE_KEY, on both Workers): never the edge key. */
  gateKey?: string;
  /** Each part of the deploy, with the hash of what its last deploy deployed (update.ts). On AWS: in the unit's own file (aws.ts). */
  parts: Record<string, string>;
  /** The test issuer: its address, its client's secret, and the run's password. */
  idp: { url: string; secret: string; password: string };
  /** Cloudflare Access in front of the shell (access.ts): the team's name, and the application's audience tag. */
  access?: { team: string; aud: string };
  /** The origin's own address, if it had one (workers.dev): it must not answer. And one that answers, to compare. */
  originAddress?: string;
  /**
   * The real Erga behind the gate (erga.ts; none: the stub is the origin): its database's ID (Cloudflare's D1; "" on
   * AWS), the release that runs (its name: update.ts, buildRelease; "": none yet), its SESSION_SECRET (it seals the
   * first admin's link) and FACTORY_KEY, and the seeded documents, each with its address on the shell and its own host.
   */
  erga?: {
    database: string;
    version: string;
    session: string;
    factory: string;
    docs: { id: string; address: string; host: string }[];
  };
  /** AWS: the instance's stack (the us-east-1 stack is <stack>-certs). */
  stack?: string;
}

/** The documents' hosts, and the host that takes the ticket. */
export const docHost = (r: Setting, n: number) => `d${n}.${r.content}`;
export const acceptHost = (r: Setting) => `accept.${r.content}`;
/** The host of the hidden frame that runs the hand-off early (server/identity/caller.ts, handOff): the real Erga's only. */
export const warmHost = (r: Setting) => `warm.${r.content}`;
export const otherSite = (r: Setting) => !`.${r.content}`.endsWith(`.${r.shell}`);
export const CLIENT = "erga-verify";
/** A host's zone on Cloudflare: the test zone that it is under. */
export function zone(host: string): string {
  const z = cloudflareZones().find((name) => under(host, name));
  if (!z) throw new Error(hostProblem(host, cloudflareZones())!);
  return z;
}

let dir: string | null = null;
/** The suite's folder: .erga/verify/ in the main clone (see the top). */
export const suiteDir = (): string => (dir ??= join(ergaDir(), "verify"));
/** A unit's last check: its rows. */
export const resultsFile = (unit: string) => join(suiteDir(), `verify-${unit}-results.json`);
const file = (n: number) => join(suiteDir(), `verify-${n}.json`);
export const saveRun = (r: Run) => {
  mkdirSync(suiteDir(), { recursive: true });
  writeFileSync(file(r.n), JSON.stringify(r, null, 2));
  chmodSync(file(r.n), 0o600);
};
export const loadRun = (n: number): Run | null => (existsSync(file(n)) ? JSON.parse(readFileSync(file(n), "utf8")) : null);
export const dropRun = (n: number) => rmSync(file(n), { force: true });

export const secret = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

/** A row of the report. `ok` null: not run. `browser` "": a check with requests only. */
export interface Row {
  check: string;
  browser: string;
  ok: boolean | null;
  note: string;
}
export class Report {
  rows: Row[] = [];
  add(check: string, ok: boolean | null, note = "", browser = "") {
    this.rows.push({ check, browser, ok, note });
    console.log(
      `${ok == null ? "not run" : ok ? "pass   " : "FAIL   "} ${browser ? `[${browser}] ` : ""}${check}${note ? `: ${note}` : ""}`
    );
  }
  get failed() {
    return this.rows.filter((r) => r.ok === false).length;
  }
}

/**
 * Whether what wrangler printed is a refusal that passes by itself in some seconds: just after a Worker's first
 * upload, the API may say that the Worker does not exist (10007), or answer its workers.dev setting with "An unknown
 * error has occurred" (10013: seen 2026-11-19, in three deploys within three minutes).
 */
export const passes = (said: string) => /10007|code: 10013\b/.test(said);

/** Runs a command, and gives what it printed; throws with it when the command fails. */
export function sh(cmd: string[], o: { cwd?: string; env?: Record<string, string>; input?: string } = {}): string {
  const p = Bun.spawnSync(cmd, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdin: o.input ? Buffer.from(o.input) : undefined });
  const out = p.stdout.toString() + p.stderr.toString();
  if (p.exitCode != 0) throw new Error(`${cmd.slice(0, 4).join(" ")} failed:\n${out.slice(-2000)}`);
  return out;
}

/** Waits until `ready` says so (asked each `every` ms), for `limit` ms at most. */
export async function until(what: string, ready: () => Promise<boolean>, limit = 600_000, every = 5000): Promise<void> {
  const end = Date.now() + limit;
  for (;;) {
    if (await ready().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await Bun.sleep(every);
  }
}
