// The verify suite (`bun erga verify`, dev/verify/cli.ts): the runs on real platforms as a list of units, each with
// the prerequisites it needs (prereqs.ts), what it costs, and the record of its runs. Pure: the command does the IO,
// and the ops page draws from the same values (deploy/cli/verify-view.ts). It is no part of `bun run test`: a run
// deploys to real accounts, takes minutes, and can cost money.
//
//   a unit      a setting of the plan (1 to 6: `bun dev/verify.ts <n>`), or celld (Erga's own deploy on AWS, with one
//               journey: `bun dev/verify/celld.ts`; setting 6 is the same deploy, with the gate's checks). Each
//               deploys with the code that a real instance's deploy runs (deploy/pipeline/, deploy/aws/)
//   needs       the prerequisites that block it; wants: those that make a check fail, and block nothing
//   a record    .erga/verify/runs/<id>.json in the main clone: one run of one unit, written as it goes: its steps
//               (deploy, check, remove) with their time, the rows of its checks, and what it left in the accounts.
//               Its output is beside it, <id>.log
//   the state   .erga/verify/state.json: the prerequisites and what the suite made that is in the accounts, as the
//               last look saw them
//   kept        .erga/verify/kept.json: the units whose deploy stays in the accounts between runs, each since when
//               and with its hosts. `--keep` deploys and checks a unit, and removes nothing; `update` deploys this
//               checkout's code again on a kept unit (update.ts: only what changed) and checks it; `remove` ends it.
//               What a kept unit has in the accounts is kept, not left (leftOf). Each hour of it has a price (`keep`)

import type { Id, Prereq } from "./prereqs.ts";
import { awsHost, type Row, settingsOf } from "./run.ts";

export interface Unit {
  /** "1" to "6", or "celld". */
  id: string;
  name: string;
  title: string;
  where: "cloudflare" | "aws";
  needs: Id[];
  wants: Id[];
  /** What a run costs, said before it starts. */
  cost: string;
  /** What each hour of it costs while it is kept. */
  keep: string;
}

const CLOUDFLARE: Id[] = ["config", "token", "wrangler", "cloudflare", "zones", "workers-dev", "browsers"];
/** Erga's own deploy on AWS. */
const CELLD: Id[] = ["config", "aws", "aws-own", "aws-zones", "browsers"];
/** The gate on CloudFront, in front of Erga on AWS: its test issuer is a Worker. */
const AWS: Id[] = [...CELLD, "token", "wrangler", "cloudflare", "workers-dev"];
const TITLES: Record<string, string> = {
  "cf-oauth": "Cloudflare, OAuth, content on another site",
  "cf-sso": "Cloudflare, SSO, content on another site",
  "cf-sso-same": "Cloudflare, SSO, content on the same site",
  "cf-access": "Cloudflare, Access, content on another site",
  "aws-sso": "AWS, SSO: the gate on CloudFront, content on another site",
  "aws-oauth": "AWS, OAuth: the gate inside celld",
};
const COST = {
  cloudflare:
    "Cloudflare: some Workers, one D1 database and one R2 bucket, for about 15 minutes. Expected cost: $0 (the plan's included use).",
  access:
    "Cloudflare: two Workers, and in the Zero Trust team two Access applications and one identity provider, for about 15 minutes. Expected cost: $0 (the plan's included use).",
  aws: "AWS: two EC2 machines, two CloudFront distributions with a VPC origin, four Functions, one Lambda@Edge function, two certificates, a bucket, a secret and a KMS key, for about 60 minutes. Cloudflare: one Worker (the test issuer). Expected cost: under $0.50.",
  celld:
    "AWS: two EC2 machines, two CloudFront distributions with a VPC origin, two certificates, a bucket and a KMS key, for about 45 minutes. Expected cost: under $0.50.",
};

/**
 * What a kept unit costs for each hour: AWS's list prices in us-east-1 (on demand, 2026-11), as the templates make it
 * (deploy/aws/template.ts: a t4g.small machine with 16 GB, and a t4g.micro NAT machine, not a NAT gateway).
 */
const KEEP = {
  cloudflare: "$0 for each hour: Workers, D1, R2 and Custom Domains have no price by the hour (the plan's included use).",
  aws: "About $0.045 for each hour ($1.10 a day): the machine $0.017, the NAT machine $0.008 and its public address $0.005, the web ACL with its two rules $0.010, the disks, the KMS key and a secret $0.005. No NAT gateway. CloudFront, the certificates and the DNS records cost nothing by the hour.",
};

/** The units, in the plan's order. (Their hosts are not read here: the zones are placeholders.) */
export const units = (): Unit[] => [
  ...settingsOf({ shell: "shell.invalid", content: "content.invalid" }, { shell: "shell.invalid", content: "content.invalid" }).map(
    (s): Unit => ({
      id: String(s.n),
      name: s.name,
      title: TITLES[s.name],
      where: s.where,
      needs: s.where == "cloudflare" ? [...CLOUDFLARE, ...(s.who == "access" ? (["access"] as Id[]) : [])] : s.who == "oauth" ? CELLD : AWS,
      wants: s.where == "aws" ? [] : ["analytics"],
      cost: s.who == "access" ? COST.access : s.where == "cloudflare" ? COST.cloudflare : s.who == "oauth" ? COST.celld : COST.aws,
      keep: KEEP[s.where],
    })
  ),
  {
    id: "celld",
    name: "aws-celld",
    title: "AWS, Erga on celld: the deploy, one journey, and deploys from a machine and from the deployer",
    where: "aws",
    needs: CELLD,
    wants: [],
    cost: COST.celld,
    keep: KEEP.aws,
  },
  {
    id: "deploys",
    name: "cf-deploys",
    title: "Cloudflare: deploys from a machine, and from the deployer in the account",
    where: "cloudflare",
    needs: ["config", "token", "cloudflare", "zones"],
    wants: [],
    cost: COST.cloudflare,
    keep: KEEP.cloudflare,
  },
];

/** A unit's hosts on this machine's zones: the app's, and the documents' domain. */
export function hostsOf(id: string, cf: { shell: string; content: string }, aws: { shell: string; content: string }): string[] {
  if (id == "deploys") return [`s7.${cf.shell}`, `*.c7.${cf.content}`];
  const s = settingsOf(cf, aws).find((x) => String(x.n) == id);
  return s ? [s.shell, `*.${s.content}`] : [awsHost(id, aws.shell), `*.${aws.content}`];
}

/**
 * What a browser needs beyond Playwright's three. (Not Safari's version: an older Safari runs too, and must show the
 * gate's page for an unsupported browser where the documents are on another site.)
 */
export const BROWSER_NEEDS: Record<string, Id[]> = { safari: ["safari-automation"] };
export const BROWSERS = ["chromium", "firefox", "webkit", "safari"];

/** The units that need the prerequisite or want it, and the browsers that need it: none means that it is optional. */
export const neededBy = (id: Id): string[] => [
  ...units()
    .filter((u) => u.needs.includes(id) || u.wants.includes(id))
    .map((u) => u.id),
  ...Object.entries(BROWSER_NEEDS)
    .filter(([, ids]) => ids.includes(id))
    .map(([b]) => b),
];

/** Whether a unit can run now: ready (with the prerequisites that make a check fail), or what blocks it. */
export type Ready = { at: "ready"; weak: Prereq[] } | { at: "blocked"; by: Prereq[] };
export function readiness(u: Unit, prereqs: Prereq[], browsers: string[] = []): Ready {
  const open = (ids: Id[]) => prereqs.filter((p) => ids.includes(p.id) && !p.done);
  const by = open([...u.needs, ...browsers.flatMap((b) => BROWSER_NEEDS[b] ?? [])]);
  return by.length ? { at: "blocked", by } : { at: "ready", weak: open(u.wants) };
}

export type StepName = "deploy" | "update" | "check" | "remove";
/** How a command runs a unit. run: deploy, check, remove. keep: deploy, check. update: update, check, on a kept unit. */
export type Mode = "run" | "keep" | "update";

/**
 * The step after the steps that ended (null: the run is over). `stopped`: the person stopped the run (Ctrl-C).
 * No check of a deploy that failed, or after a stop. A run always removes. With --keep, only a deploy that failed is
 * removed: what is kept works. An update removes nothing.
 */
export function stepAfter(mode: Mode, done: Pick<Step, "step" | "code">[], stopped: boolean): StepName | null {
  const first = mode == "update" ? "update" : "deploy";
  const last = done.at(-1);
  if (!last) return first;
  const remove = mode == "run" || (mode == "keep" && done[0].code != 0) ? "remove" : null;
  if (last.step == first) return last.code == 0 && !stopped ? "check" : remove;
  return last.step == "check" ? remove : null;
}
export interface Step {
  step: StepName;
  started: string;
  /** With its end: how long it took, and the command's exit code. */
  seconds?: number;
  code?: number;
}

/** One run of one unit. */
export interface RunRecord {
  /** Its file's name, without .json: <time>-<unit>. */
  id: string;
  unit: string;
  command: string;
  from: string;
  pid: number;
  pidStart: string | null;
  commit: string;
  browsers: string[];
  started: string;
  ended?: string;
  steps: Step[];
  /** The checks' rows (run.ts, Report). */
  rows: Row[];
  /** What the run left in the accounts, by name: nothing, when `remove` did its work. */
  left: string[];
}

export type Result = "running" | "passed" | "failed" | "stopped";
/**
 * A record's result. passed: each step ended well (deploy, check and remove; or, of a unit that stays kept, deploy or
 * update, and check), no row failed, and nothing is left. stopped: its process ended early.
 */
export function resultOf(r: RunRecord, alive: (pid: number, start: unknown) => boolean): Result {
  if (!r.ended) return alive(r.pid, r.pidStart) ? "running" : "stopped";
  const steps = r.steps.some((s) => s.step == "remove") ? 3 : 2;
  const well = r.steps.length == steps && r.steps.every((s) => s.code == 0);
  return well && !r.rows.some((row) => row.ok === false) && !r.left.length ? "passed" : "failed";
}

/** The rows by browser ("requests": a check with no browser), in the order they came: how many pass, fail, did not run. */
export function tally(rows: Row[]): { browser: string; pass: number; fail: number; skipped: number }[] {
  const by = new Map<string, { browser: string; pass: number; fail: number; skipped: number }>();
  for (const r of rows) {
    const name = r.browser || "requests";
    const t = by.get(name) ?? { browser: name, pass: 0, fail: 0, skipped: 0 };
    by.set(name, t);
    if (r.ok === true) t.pass++;
    else if (r.ok === false) t.fail++;
    else t.skipped++;
  }
  return [...by.values()];
}

/** The rows as a table: each check one time, with its result in each browser's column. */
export function matrix(rows: Row[]): { columns: string[]; checks: { check: string; cells: Record<string, Row> }[] } {
  const columns = tally(rows).map((t) => t.browser);
  const checks = new Map<string, Record<string, Row>>();
  for (const r of rows) checks.set(r.check, { ...checks.get(r.check), [r.browser || "requests"]: r });
  return { columns, checks: [...checks].map(([check, cells]) => ({ check, cells })) };
}

/** A resource that the suite made and that is still in an account. */
export interface Left {
  /** "Worker", "D1 database", "R2 bucket", "Access application", "Access identity provider", "CloudFormation stack". */
  kind: string;
  name: string;
  /** The unit whose `remove` removes it; null: no setting made it (another tool's, with the suite's prefix). */
  unit: string | null;
}

/**
 * The unit that made a resource, from its name: erga-verify-<n>, erga-verify-<kind>-<n>, erga-verify-<n>-files,
 * erga-verify-<n>-open (an Access application); on AWS a stack's name is its app's host
 * (erga-verify-<unit>-<the zone's name>, and with -certs the us-east-1 stack).
 */
export const unitOfName = (name: string): string | null =>
  /^erga-verify-(?:(?:gate|stub|idp)-)?([1-6]|celld|deploys)(?:-[a-z0-9-]+)?$/.exec(name)?.[1] ?? null;

/** The state file: the last look at the prerequisites and at the accounts. */
export interface State {
  at: string;
  prereqs: Prereq[];
  /** What the suite made that is in the accounts: a kept unit's too (leftOf tells them apart). */
  left: Left[];
  /** Why an account's resources were not listed. */
  unread: string[];
}

/** A unit whose deploy stays in the accounts between runs: since when (the end of its deploy), and its hosts. */
export interface Kept {
  since: string;
  hosts: string[];
}
/** The kept units, by their id (the file kept.json). */
export type KeptUnits = Record<string, Kept>;

/** What a run left in the accounts: what is there and is no kept unit's. */
export const leftOf = (left: Left[], kept: KeptUnits): Left[] => left.filter((l) => !l.unit || !kept[l.unit]);

/**
 * The units on AWS that have something in the accounts (kept, or left) and are in the way of `u`: the units on AWS
 * share the documents' zone (its wildcard name, and CloudFront's alias for it), so one at a time is there.
 */
export function inTheWay(u: Unit, left: Left[], kept: KeptUnits): string[] {
  if (u.where != "aws") return [];
  const there = new Set([...Object.keys(kept), ...left.flatMap((l) => l.unit ?? [])]);
  return units()
    .filter((x) => x.where == "aws" && x.id != u.id && there.has(x.id))
    .map((x) => x.id);
}

/** What a command of `bun erga verify` does, from its words: or why it does nothing, and what to run then. */
export type Command =
  | { at: "check" }
  | { at: "remove"; targets: Unit[] }
  | { at: Mode; targets: Unit[]; notes: string[] }
  | { at: "fail"; why: string; next?: string };

/**
 * Reads a command's words (the arguments that are no option) against the last look and the kept units. `keep`: the
 * option --keep. A unit that can't run stops the command when the command names it; `all` leaves it out, with a note.
 */
export function commandOf(
  words: string[],
  keep: boolean,
  o: { prereqs: Prereq[]; left: Left[]; kept: KeptUnits; browsers: string[] }
): Command {
  const all = units();
  const fail = (why: string, next?: string): Command => ({ at: "fail", why, next });
  if (!words.length || words[0] == "check") return { at: "check" };
  const verb = words[0] == "remove" || words[0] == "update" ? words[0] : null;
  const names = verb ? words.slice(1) : words;
  if (keep && verb) return fail("--keep goes with a run: bun erga verify <setting> --keep.");
  const unknown = names.find((w) => w != "all" && !all.some((u) => u.id == w || u.name == w));
  if (unknown) return fail(`No setting ${unknown}: ${all.map((u) => u.id).join(", ")}, or all.`);
  const every = names.includes("all");
  const wanted = every ? all : all.filter((u) => names.includes(u.id) || names.includes(u.name));
  // (Only a verb can come with no name.)
  if (!wanted.length) return fail(`Name the setting: bun erga verify ${verb} <setting>|all.`);
  if (verb == "remove") return { at: "remove", targets: wanted };

  const mode: Mode = verb == "update" ? "update" : keep ? "keep" : "run";
  const left = leftOf(o.left, o.kept);
  /** Why a unit stays out of this command, or null. `quiet`: `all` says nothing of it. */
  const out = (u: Unit): { why: string; next?: string; quiet?: boolean } | null => {
    const kept = o.kept[u.id];
    if (mode == "update" && !kept)
      return { why: `Setting ${u.id} (${u.title}) is not kept.`, next: `bun erga verify ${u.id} --keep`, quiet: true };
    if (mode != "update" && kept)
      return {
        why: `Setting ${u.id} (${u.title}) is kept since ${kept.since}: update deploys its code again and checks it, remove ends it.`,
        next: `bun erga verify update ${u.id}`,
      };
    const r = readiness(u, o.prereqs, o.browsers);
    if (r.at == "blocked")
      return {
        why: `Setting ${u.id} (${u.title}) can't run. It is blocked by: ${r.by.map((p) => `${p.title} (${p.todo})`).join("; ")}`,
        next: "bun erga verify",
      };
    const others = mode == "update" ? [] : inTheWay(u, left, o.kept);
    if (others.length)
      return {
        why: `Setting ${u.id} (${u.title}) can't run while setting ${others.join(", ")} is in the AWS account: the settings on AWS share the documents' zone.`,
        next: `bun erga verify remove ${others.join(" ")}`,
      };
    return null;
  };
  const targets: Unit[] = [];
  const notes: string[] = [];
  for (const u of wanted) {
    const no = out(u);
    if (!no) targets.push(u);
    else if (!every) return fail(no.why, no.next);
    else if (!no.quiet) notes.push(`${no.why} It stays out.`);
  }
  if (!targets.length)
    return mode == "update"
      ? fail("No setting is kept.", "bun erga verify <setting> --keep")
      : fail("No setting is ready.", "bun erga verify");
  if (mode == "update") return { at: mode, targets, notes };
  const lying = left.filter((l) => targets.some((u) => u.id == l.unit));
  const whose = [...new Set(lying.map((l) => l.unit))];
  if (lying.length)
    return fail(
      `An earlier run of ${whose.join(", ")} left ${lying.map((l) => l.name).join(", ")} in the accounts, or a run is on now from another folder.`,
      `bun erga verify remove ${whose.join(" ")}`
    );
  const onAws = targets.filter((u) => u.where == "aws");
  if (mode == "keep" && onAws.length > 1)
    return fail(`Only one setting on AWS is kept at a time (${onAws.map((u) => u.id).join(", ")} share the documents' zone): name one.`);
  return { at: mode, targets, notes };
}

/** "3 min 5 s". */
export const took = (seconds: number) =>
  seconds < 60 ? `${Math.round(seconds)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;

/** The one line that answers "how much setup is there to do, and what has passed". */
export function headline(state: State | null, last: Record<string, Result | undefined>, kept: KeptUnits): string {
  if (!state) return "The prerequisites are not checked yet.";
  const all = units();
  const needed = state.prereqs.filter((p) => neededBy(p.id).length);
  const ready = all.filter((u) => readiness(u, state.prereqs).at == "ready");
  const passed = all.filter((u) => last[u.id] == "passed");
  const ids = Object.keys(kept);
  const keeps = ids.length ? ` Kept: ${ids.join(", ")}.` : "";
  const lying = leftOf(state.left, kept);
  const left = lying.length ? ` ${lying.length} left in the accounts.` : "";
  return `Setup: ${needed.filter((p) => p.done).length} of ${needed.length} done. Settings: ${ready.length} of ${all.length} ready, ${passed.length} passed.${keeps}${left}`;
}
