// `bun erga verify`: the verify suite's command (suite.ts). It is no part of `bun run test`.
//
//   bun erga verify                      checks each prerequisite (prereqs.ts) and looks in the accounts for what a
//                                        run left; prints both, and each unit's state. It deploys nothing
//   bun erga verify <unit>... | all      for each unit: deploy, check, remove (always, also after a failure), and its
//                                        record. First it checks the prerequisites again, says what the run costs, and
//                                        asks (--yes: no question). all: each unit that is ready
//       --browsers chromium,firefox,webkit,safari     --origin stub|erga (bun dev/verify.ts)
//       --keep                           deploy and check, with no remove: the unit stays in the accounts, kept
//                                        (suite.ts), until `remove`. A deploy that fails is removed
//   bun erga verify update <unit>|all    on a kept unit (all: each kept one): deploys this checkout's code again, only
//                                        what changed (update.ts), and checks it. It makes no infrastructure, removes
//                                        nothing, and asks nothing
//   bun erga verify remove <unit>|all    removes what a unit's runs left in the accounts, and a kept unit
//
// A unit's steps run `bun dev/verify.ts <n> <step>` (celld: `bun dev/verify/celld.ts <step>`), each in a process of
// its own, with the suite's accounts in its environment (config.ts, dedicatedEnv): wrangler takes the suite's
// Cloudflare account, and the AWS CLI the suite's profile, whatever else this machine is signed in to. The Cloudflare
// token is not in the environment: each step takes the suite's own at each call. A run starts only on zones that hold
// nothing but the suite's own, in accounts that it may use (dedicated.ts: two prerequisites, and the step `deploy`
// asks again itself). One run at a time on this machine (the lock .erga/jobs/verify.lock).
// Trap: nothing here asks the machine's DNS for a test host. It keeps a "no such host" for 30 minutes, and the next
// run's browsers would get that answer.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ergaDir, readConfig } from "../../deploy/cli/config.ts";
import { takeLock } from "../../deploy/cli/jobs.ts";
import { alive, ownStart } from "../../deploy/cli/pid.ts";
import { fail, ROOT, say, sh } from "../../deploy/root.ts";
import { timeAgo } from "../../shared/time.ts";
import { guardAws } from "./aws-guard.ts";
import { dedicatedEnv, hostsOf as instanceHosts, type Local, readLocal, tokenOf } from "./config.ts";
import { stackNames } from "./dedicated.ts";
import { decide, probe } from "./prereqs.ts";
import type { Row } from "./run.ts";
import {
  BROWSERS,
  commandOf,
  headline,
  hostsOf,
  type Kept,
  type KeptUnits,
  type Left,
  leftOf,
  type Mode,
  neededBy,
  type Result,
  type RunRecord,
  readiness,
  resultOf,
  type State,
  type StepName,
  stepAfter,
  tally,
  took,
  type Unit,
  unitOfName,
  units,
} from "./suite.ts";

export const verifyDir = (dir: string) => join(dir, "verify");
const statePath = (dir: string) => join(verifyDir(dir), "state.json");
const runsDir = (dir: string) => join(verifyDir(dir), "runs");

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};
export const readState = (dir: string) => readJson<State>(statePath(dir));

const keptPath = (dir: string) => join(verifyDir(dir), "kept.json");
/** The kept units (suite.ts, Kept), by their id: none when there is no file. */
export const readKept = (dir: string): KeptUnits => readJson<KeptUnits>(keptPath(dir)) ?? {};
/** Records that a unit is kept; with null, that it is not kept any more. */
export function writeKept(dir: string, unit: string, kept: Kept | null) {
  const { [unit]: _, ...others } = readKept(dir);
  mkdirSync(verifyDir(dir), { recursive: true });
  writeFileSync(keptPath(dir), JSON.stringify(kept ? { ...others, [unit]: kept } : others, null, 2));
}

/** The records of the runs, newest first (the last 60). */
export function readRuns(dir: string): RunRecord[] {
  if (!existsSync(runsDir(dir))) return [];
  return readdirSync(runsDir(dir))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, 60)
    .flatMap((f) => readJson<RunRecord>(join(runsDir(dir), f)) ?? []);
}
/** A run's output, by its record's id: its last `lines` lines. */
export function readLog(dir: string, id: string, lines = 600): string | null {
  if (!/^[\w.-]+$/.test(id)) return null;
  try {
    return readFileSync(join(runsDir(dir), `${id}.log`), "utf8")
      .split("\n")
      .slice(-lines)
      .join("\n");
  } catch {
    return null;
  }
}
/** Each unit's last record, with its result. */
export const lastRuns = (runs: RunRecord[]): Record<string, { run: RunRecord; result: Result }> =>
  Object.fromEntries(
    runs
      .slice()
      .reverse()
      .map((r) => [r.unit, { run: r, result: resultOf(r, alive) }])
  );

/**
 * What the suite made and that is still in the accounts: Cloudflare's Workers, databases, buckets, Access applications
 * and identity providers, and AWS's stacks, by their name.
 */
async function leftovers(p: Awaited<ReturnType<typeof probe>>, local: Local): Promise<Pick<State, "left" | "unread">> {
  const left: Left[] = [];
  const unread: string[] = [];
  const add = (kind: string, names: string[]) =>
    left.push(...names.filter((n) => n.startsWith("erga-verify")).map((name) => ({ kind, name, unit: unitOfName(name) })));
  if (p.api) {
    const acc = `/accounts/${local.cloudflare.account}`;
    const list = async (kind: string, path: string, names: (result: unknown) => string[]) => {
      const r = await p.api!("GET", `${acc}${path}`);
      if (r.status == 200) add(kind, names(r.result));
      else unread.push(`Cloudflare did not list its ${kind}s (HTTP ${r.status}).`);
    };
    await Promise.all([
      list("Worker", "/workers/scripts", (r) => ((r ?? []) as { id: string }[]).map((s) => s.id)),
      list("D1 database", "/d1/database?name=erga-verify&per_page=100", (r) => ((r ?? []) as { name: string }[]).map((d) => d.name)),
      list("R2 bucket", "/r2/buckets?name_contains=erga-verify", (r) =>
        ((r as { buckets?: { name: string }[] })?.buckets ?? []).map((b) => b.name)
      ),
      // (Access: only where the settings name a team.)
      ...(local.cloudflare.team
        ? [
            list("Access application", "/access/apps?per_page=200", (r) => ((r ?? []) as { name: string }[]).map((a) => a.name)),
            list("Access identity provider", "/access/identity_providers?per_page=200", (r) =>
              ((r ?? []) as { name: string }[]).map((a) => a.name)
            ),
          ]
        : []),
      // What a run left in the two test zones: a host's Custom Domain or DNS record. (Not the names that hand a part
      // of a zone to Route 53: no run makes them.)
      ...Object.entries(p.facts.held.cloudflare.zones).map(async ([zone, z]) => {
        const records = (z?.records ?? []).filter((r) => !(r.type == "NS" && [local.aws.shell, local.aws.content].includes(r.name)));
        const hosts = [...new Set([...(z?.domains ?? []).map((d) => d.hostname), ...records.map((r) => r.name)])];
        left.push(
          ...hosts.map((name) => ({
            kind: `Host in ${zone}`,
            name,
            unit: /(?:^|\.)[sc]([1-7])\./.exec(name)?.[1]?.replace("7", "deploys") ?? null,
          }))
        );
      }),
    ]);
  } else unread.push("Cloudflare: no token, or no account is named: its resources were not listed.");
  if (local.aws.profile && !p.facts.aws.why) {
    const stacks = stackNames(local);
    if ("names" in stacks) add("CloudFormation stack", stacks.names);
    else unread.push(`AWS did not list its stacks: ${stacks.why}`);
  } else unread.push("AWS: no sign-in: its stacks were not listed.");
  return { left: left.sort((a, b) => a.name.localeCompare(b.name)), unread };
}

/** Checks the prerequisites and looks in the accounts, and writes the state file. */
async function look(dir: string): Promise<{ state: State; local: Local }> {
  const local = readLocal(dir, instanceHosts(readConfig(dir)));
  const token = local.problem ? { why: local.problem } : tokenOf(dir, local);
  const p = await probe(local, "why" in token ? token.why : "");
  const state: State = { at: new Date().toISOString(), prereqs: decide(p.facts), ...(await leftovers(p, local)) };
  mkdirSync(verifyDir(dir), { recursive: true });
  writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
  return { state, local };
}

/** The state as text. */
function print(dir: string, state: State, runs: RunRecord[], kept: KeptUnits, now = Date.now()) {
  const last = lastRuns(runs);
  say(headline(state, Object.fromEntries(Object.entries(last).map(([u, l]) => [u, l.result])), kept));
  say();
  say("Prerequisites");
  for (const p of state.prereqs) {
    const who = neededBy(p.id);
    say(`  ${p.done ? "done" : "TODO"}  ${p.title}${who.length ? "" : " (optional)"}: ${p.detail}`);
    if (!p.done) say(`        Do: ${p.todo}${who.length ? `  (for: ${who.join(", ")})` : ""}`);
  }
  say();
  say("Settings");
  for (const u of units()) {
    const r = readiness(u, state.prereqs);
    const by = (ps: { title: string }[]) => ps.map((p) => p.title).join("; ");
    const ready = r.at == "ready" ? `ready${r.weak.length ? ` (a check fails until: ${by(r.weak)})` : ""}` : `blocked by: ${by(r.by)}`;
    say(`  ${u.id.padEnd(5)} ${u.title}: ${ready}`);
    const k = kept[u.id];
    if (k) {
      const there = state.left.filter((x) => x.unit == u.id).length;
      say(
        `        KEPT since ${timeAgo(Date.parse(k.since), now)} (${k.since}): ${k.hosts.join(", ")}; ${there} resources in the accounts.`
      );
      say(`        ${u.keep}`);
      say(`        Its code again, and the checks: bun erga verify update ${u.id}. The end of it: bun erga verify remove ${u.id}`);
    }
    const l = last[u.id];
    if (l) {
      const seconds = l.run.steps.reduce((n, s) => n + (s.seconds ?? 0), 0);
      const cells = tally(l.run.rows)
        .map((t) => `${t.browser} ${t.pass}/${t.pass + t.fail}${t.skipped ? ` (${t.skipped} not run)` : ""}`)
        .join(", ");
      say(
        `        Last run: ${l.result} ${timeAgo(Date.parse(l.run.started), now)}, ${took(seconds)}${cells ? `: ${cells}` : ""}. Log: ${join(runsDir(dir), `${l.run.id}.log`)}`
      );
    }
  }
  const left = leftOf(state.left, kept);
  if (left.length || state.unread.length) {
    say();
    say("Left in the accounts");
    for (const l of left)
      say(`  ${l.kind} ${l.name}: ${l.unit ? `bun erga verify remove ${l.unit}` : "no setting made it: the suite does not remove it"}`);
    for (const u of state.unread) say(`  NOTE  ${u}`);
  }
}

/** One step of a unit, in a process of its own: its output goes to the terminal and to the log. Its exit code. */
async function step(
  u: Unit,
  name: StepName,
  o: { env: Record<string, string>; log: string; browsers: string[]; origin?: string }
): Promise<number> {
  const cmd =
    u.id == "celld" || u.id == "deploys"
      ? [`dev/verify/${u.id}.ts`, name]
      : ["dev/verify.ts", u.id, name, "--browsers", o.browsers.join(","), ...(o.origin ? ["--origin", o.origin] : [])];
  const line = `\n--- ${name}: bun ${cmd.join(" ")}\n`;
  process.stdout.write(line);
  appendFileSync(o.log, line);
  const p = Bun.spawn([process.execPath, ...cmd], {
    cwd: ROOT,
    env: { ...process.env, ...o.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pipe = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      process.stdout.write(chunk);
      appendFileSync(o.log, chunk);
    }
  };
  await Promise.all([pipe(p.stdout), pipe(p.stderr)]);
  return await p.exited;
}

/**
 * Runs one unit, by the command's mode (suite.ts, stepAfter: deploy, check, remove; with --keep no remove; an update:
 * update, check), with its record written after each step. Its result. `hosts`: the unit's, for the record of a
 * unit that the run keeps.
 */
async function run(
  dir: string,
  u: Unit,
  o: {
    mode: Mode;
    hosts: string[];
    env: Record<string, string>;
    browsers: string[];
    origin?: string;
    command: string;
    stop: () => boolean;
  }
) {
  mkdirSync(runsDir(dir), { recursive: true });
  const started = new Date().toISOString();
  const id = `${started.replace(/[:.]/g, "-")}-${u.id}`;
  const log = join(runsDir(dir), `${id}.log`);
  const record: RunRecord = {
    id,
    unit: u.id,
    command: o.command,
    from: process.env.ERGA_JOB_FROM == "page" ? "page" : "terminal",
    pid: process.pid,
    pidStart: ownStart(),
    commit: sh(["git", "rev-parse", "HEAD"]).out,
    browsers: o.browsers,
    started,
    steps: [],
    rows: [],
    left: [],
  };
  const save = () => writeFileSync(join(runsDir(dir), `${id}.json`), JSON.stringify(record, null, 2));
  writeFileSync(log, `${o.command}\n${u.cost}\n`);
  save();
  // (The steps write their files in the suite's folder: run.ts, resultsFile.)
  const results = join(verifyDir(dir), `verify-${u.id}-results.json`);
  for (let name = stepAfter(o.mode, [], false); name; name = stepAfter(o.mode, record.steps, o.stop())) {
    const at = Date.now();
    const s: RunRecord["steps"][number] = { step: name, started: new Date(at).toISOString() };
    record.steps.push(s);
    save();
    s.code = await step(u, name, { ...o, log });
    s.seconds = Math.round((Date.now() - at) / 1000);
    // Kept from the end of a deploy that went well: its checks may fail, and an update repairs the code.
    if (o.mode == "keep" && name == "deploy" && s.code == 0) writeKept(dir, u.id, { since: new Date().toISOString(), hosts: o.hosts });
    // The rows of this run's check only: an older run's file stays out.
    if (name == "check" && existsSync(results) && statSync(results).mtimeMs >= at) record.rows = readJson<Row[]>(results) ?? [];
    save();
  }
  // What is still there and is not kept, as the accounts say it. (An update makes nothing and removes nothing: no look.)
  if (o.mode != "update")
    record.left = leftOf((await look(dir)).state.left, readKept(dir))
      .filter((l) => l.unit == u.id)
      .map((l) => `${l.kind} ${l.name}`);
  record.ended = new Date().toISOString();
  save();
  return { record, result: resultOf(record, alive) };
}

export async function verifyMain(args: string[]) {
  const dir = ergaDir();
  // Each `aws` command of this command and of its steps is asked of the suite's rule first (aws-guard.ts).
  const awsOf = readLocal(dir, instanceHosts(readConfig(dir))).aws;
  if (awsOf.profile) await guardAws(awsOf.profile, [awsOf.shell, awsOf.content]);
  // The options that the command line gave: one that does nothing with the command stops it (suite.ts, commandOf).
  const options = ["--browsers", "--origin", "--yes"].filter((f) => args.includes(f));
  const opt = (f: string) => {
    const i = args.indexOf(f);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const browsers = (opt("--browsers") ?? "chromium,firefox,webkit").split(",").filter(Boolean);
  const origin = opt("--origin");
  const yes = args.includes("--yes");
  const words = args.filter((a) => !a.startsWith("--"));
  const unknown = browsers.filter((b) => !BROWSERS.includes(b));
  if (unknown.length) fail(`No browser ${unknown.join(", ")}: ${BROWSERS.join(", ")}.`);

  const command = `bun erga verify ${args.filter((a) => a != "--yes").join(" ")}`;
  const { state, local } = await look(dir);
  const cmd = commandOf(words, args.includes("--keep"), {
    prereqs: state.prereqs,
    left: state.left,
    kept: readKept(dir),
    browsers,
    options,
  });
  if (cmd.at == "check") return print(dir, state, readRuns(dir), readKept(dir));
  if (cmd.at == "fail") return fail(cmd.why, cmd.next);
  const env = dedicatedEnv(local);
  const ids = cmd.targets.map((u) => u.id);

  if (cmd.at == "remove") {
    if (local.problem) fail(local.problem);
    const free = takeLockOr(dir, command);
    try {
      for (const u of cmd.targets) {
        mkdirSync(runsDir(dir), { recursive: true });
        // Not kept after a remove that ran to its end: what is still there then is left, and shows so. (One that
        // stopped, as with no AWS login, changes nothing.)
        if ((await step(u, "remove", { env, log: join(runsDir(dir), "remove.log"), browsers })) == 0) writeKept(dir, u.id, null);
      }
    } finally {
      free();
    }
    const still = (await look(dir)).state.left.filter((l) => ids.includes(l.unit ?? ""));
    if (still.length) fail(`Still in the accounts: ${still.map((l) => `${l.kind} ${l.name}`).join(", ")}.`, "Run the command again later.");
    return say(`PASS  Nothing of ${ids.join(", ")} is left in the accounts.`);
  }

  // A run, a run that keeps its deploy, or an update of what is kept.
  for (const note of cmd.notes) say(`NOTE  ${note}`);
  const accounts = `the suite's accounts (Cloudflare ...${local.cloudflare.account.slice(-6)}${local.cloudflare.shared ? ", shared: only under its two test zones, and only what is named erga-verify-..." : ""}${local.aws.account ? `; AWS ...${local.aws.account.slice(-4)}` : ""})`;
  say(
    cmd.at == "update"
      ? `This deploys this checkout's code again, only where it changed, to what is kept in ${accounts}, and checks it. It makes no infrastructure, and removes nothing:`
      : cmd.at == "keep"
        ? `This deploys to ${accounts}, and keeps it there until bun erga verify remove:`
        : `This deploys to ${accounts}, and removes it again:`
  );
  for (const u of cmd.targets)
    say(`  ${u.id}  ${u.title}.${cmd.at == "update" ? "" : ` ${u.cost}`}${cmd.at == "run" ? "" : ` While it is kept: ${u.keep}`}`);
  // (An update asks nothing: it costs nothing more than what is kept.)
  if (cmd.at != "update" && !yes && !/^y(es)?$/i.test(prompt("Run? [y/N]")?.trim() ?? "")) return say("Nothing ran.");

  const free = takeLockOr(dir, command);
  let stops = 0;
  process.on("SIGINT", () => {
    if (++stops > 1) process.exit(130);
    say(
      `\nNOTE  Stopping: the step ends, and ${cmd.at == "run" ? "remove runs" : "nothing is removed"}. Ctrl-C again stops at once, and leaves what is deployed.`
    );
  });
  let bad = 0;
  try {
    for (const u of cmd.targets) {
      if (stops) break;
      const hosts = hostsOf(u.id, local.cloudflare, local.aws);
      const { record, result } = await run(dir, u, { mode: cmd.at, hosts, env, browsers, origin, command, stop: () => stops > 0 });
      const seconds = record.steps.reduce((n, s) => n + (s.seconds ?? 0), 0);
      const cells = tally(record.rows).map((t) => `${t.browser} ${t.pass}/${t.pass + t.fail}`);
      say(`\n${result == "passed" ? "PASS" : "FAIL"}  Setting ${u.id} (${u.title}): ${result} in ${took(seconds)}. ${cells.join(", ")}`);
      for (const l of record.left) say(`      Left in the accounts: ${l}. Remove it: bun erga verify remove ${u.id}`);
      if (readKept(dir)[u.id])
        say(
          `      Kept: ${hosts.join(", ")}. ${u.keep} Its code again: bun erga verify update ${u.id}. The end of it: bun erga verify remove ${u.id}`
        );
      say(`      Record: ${join(runsDir(dir), `${record.id}.json`)}`);
      if (result != "passed") bad++;
    }
  } finally {
    free();
  }
  process.exit(bad || stops ? 1 : 0);
}

const takeLockOr = (dir: string, command: string) => {
  try {
    return takeLock(dir, "verify", command);
  } catch (e) {
    return fail((e as Error).message);
  }
};
