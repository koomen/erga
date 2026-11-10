#!/usr/bin/env bun
// Erga's command line: `bun erga <command>`. Development happens on feature branches; `merge` puts a branch on staging
// as one commit and deploys it to each staging instance, `deploy` deploys a primary and moves main, `release` tags main.
// Every deploy runs on this machine: a push deploys nothing. `bun erga skill` is the agents' manual.
//
//   bun erga [--port N] [--no-open]     the ops page on localhost: the registered instances, setup, deploys, logs, history
//   bun erga skill                      how an agent works in this repository (the workflow and its rules)
//   bun erga start <branch>             a new feature branch from GitHub's newest staging, in a work folder of its
//                                       own (worktrees/<branch> in the main clone), with its packages installed
//   bun erga clean [--yes]              lists the work folders and local branches whose task is merged and on
//                                       production, and removes them after a yes
//   bun erga push                       before each push: formats the changed lines, builds the inline code's file, runs
//                                       the tests, and pushes this branch only when they end with "all passing"
//   bun erga proof "<sentence>" [--look "<bun run look arguments>"]... [--no-picture "<the tests that prove it>"]
//                                       the branch's proof page, for Pete before the merge: what changed, a picture
//                                       before and after at desktop and phone width, the tests' result, the files
//   bun erga loops [--days N]           the time of each loop (default: the last 7 days): for each branch, the minutes
//                                       of work, the failed test runs, the wait for the merge, the time to staging and
//                                       to production; then the medians
//   bun erga status                     each registered instance's commit and health, the feature branches and the
//                                       commits, as text; it only reads (no fetch)
//   bun erga merge <branch>... [-m text]
//                                       each branch onto staging as one commit, then one test run, one deploy to
//                                       each staging instance, and the push of staging; -m is for the branch before it
//   bun erga full [<commit>]            every end-to-end test on a commit (default: staging's head), in a scratch
//                                       folder; a merge starts it in the background, and the ops page shows its result
//   bun erga release [vX.Y.Z|major|minor|patch] [--dry-run]   tags main and makes a GitHub release
//   bun erga deploy [<commit>] <host> [--no-tests]            deploys a registered instance from this machine; a primary
//                                       with no commit takes the commit its staging instances run, and main moves to it;
//                                       --fresh: a staging instance gets a new copy of its primary's data;
//                                       --home <domain>: a primary serves its homepage on that domain from now on
//   bun erga rollback <host> [--yes]    a registered instance's Worker version from before its last deploy
//   bun erga register <host> [--staging-of <host>]            signs in to an instance as an admin, in the browser, and
//                                       adds it to .erga/config.json: its deploy facts, its plain settings, an ops token
//   bun erga login <host>               a new ops token for a registered instance, when its token runs out
//   bun erga setup <host>               a new instance: the answers, the first deploy, the first admin, the ops token
//                                       (bun erga setup skill; bun erga setup help)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { latestTag, mergeArgs, nextVersion, releaseNotes, releaseRefusal, statusText } from "./flow";
import { commitsOf, fetchOrigin, headOf, readState, repoOf, ROOT, sh, tagsOf } from "./observe";

const say = (s = "") => console.log(s);
const pass = (s: string) => say(`PASS  ${s}`);
const fail = (s: string, next?: string): never => {
  say(`FAIL  ${s}`);
  if (next) say(`NEXT  ${next}`);
  process.exit(1);
};

/** Where this command was typed: ERGA_JOB_FROM=page when the ops page runs it (ops-page.ts), else a terminal. */
const fromOf = () => (process.env.ERGA_JOB_FROM == "page" ? "page" : "terminal");

const needRepo = () => repoOf() ?? fail("This checkout's origin is not a GitHub repository.", "git remote -v");

function help(code = 0): never {
  const lines = readFileSync(new URL(import.meta.url), "utf8").split("\n");
  say(
    lines
      .slice(
        1,
        lines.findIndex((l, i) => i > 0 && !l.startsWith("//"))
      )
      .map((l) => l.slice(3))
      .join("\n")
  );
  process.exit(code);
}

// ------------------------------------------------------------------ start

async function start(name: string | undefined) {
  const { ergaDir } = await import("./config");
  const { startFolder } = await import("./folders");
  const { logLoop } = await import("./loops");
  try {
    const dir = startFolder({ clone: dirname(ergaDir()), name, log: say });
    logLoop(ergaDir(), { event: "start", at: new Date().toISOString(), branch: name! });
    say(`NEXT  Work in ${dir}. Commit, then push: bun erga push. When Pete asks: bun erga merge ${name}`);
  } catch (e) {
    fail((e as Error).message);
  }
}

// ------------------------------------------------------------------ clean

async function clean(yes: boolean) {
  const { ergaDir } = await import("./config");
  const { cleanFolders } = await import("./folders");
  const dir = ergaDir();
  const ask = yes ? undefined : (q: string) => /^y(es)?$/i.test(prompt(q)?.trim() ?? "");
  cleanFolders({ dir, clone: dirname(dir), cwd: process.cwd(), log: say, ask });
}

// ------------------------------------------------------------------ push

async function push() {
  const { pushBranch } = await import("./push");
  try {
    const sha = pushBranch({ root: ROOT, log: say });
    const { ergaDir } = await import("./config");
    const { logLoop } = await import("./loops");
    logLoop(ergaDir(), { event: "push", at: new Date().toISOString(), branch: sh(["git", "symbolic-ref", "--short", "HEAD"]).out, sha });
  } catch (e) {
    fail((e as Error).message);
  }
}

// ------------------------------------------------------------------ proof

async function proof(sentence: string | undefined, looks: string[], noPicture: string | undefined) {
  const { ergaDir } = await import("./config");
  const { makeProof, proofDir, proofName } = await import("./proof");
  const dir = ergaDir();
  try {
    const p = makeProof({ dir, root: ROOT, sentence, looks, noPicture, log: say });
    pass(`The proof of ${p.branch} at ${p.sha.slice(0, 12)}: ${join(proofDir(dir, p.branch), "index.html")}`);
    let port = "4801";
    try {
      port = readFileSync(join(dir, "page.port"), "utf8").trim() || port;
    } catch {}
    say(
      `NEXT  Look at it yourself. Then give Pete its address on the ops page (bun erga): http://127.0.0.1:${port}/proof/${proofName(p.branch)}/`
    );
  } catch (e) {
    fail((e as Error).message);
  }
}

// ------------------------------------------------------------------ loops

async function loops(days: number) {
  const { ergaDir, readConfig } = await import("./config");
  const { loopsText, readLoops } = await import("./loops");
  const dir = ergaDir();
  const production = readConfig(dir)
    .instances.filter((e) => !e.stagingOf)
    .map((e) => e.host);
  say(loopsText(readLoops(dir, production), Date.now() - days * 86_400_000, days));
}

// ------------------------------------------------------------------ merge

async function merge(args: string[]) {
  needRepo();
  const merges = mergeArgs(args);
  if (!merges.length) fail("Name the branch: bun erga merge <branch>.");
  const { ergaDir } = await import("./config");
  const { mergeBranches } = await import("./merge");
  const r = await mergeBranches({ dir: ergaDir(), merges, from: fromOf() }).catch((e: Error) => fail(e.message));
  // Some branches merged, and some stay out: the output names them.
  if (r.left.length) process.exit(1);
}

// ------------------------------------------------------------------ full

async function full(commit: string | undefined) {
  const { ergaDir } = await import("./config");
  const { fullRun } = await import("./full-run");
  const dir = ergaDir();
  const clone = dirname(dir);
  // The name is read where the command is typed: HEAD is this folder's commit.
  const sha = sh(["git", "rev-parse", "--verify", "--quiet", `${commit ?? "origin/staging"}^{commit}`], { cwd: process.cwd() }).out;
  if (!sha) fail(`This clone has no commit ${commit ?? "origin/staging"}.`, "git fetch");
  const r = await fullRun({ dir, clone, sha, log: say }).catch((e: Error) => fail(e.message));
  if (r.state == "failed") process.exit(1);
}

// ------------------------------------------------------------------ release

function release(asked: string | undefined, dry: boolean) {
  const repo = needRepo();
  fetchOrigin();
  const M = headOf("origin/main") ?? fail("There is no origin/main.");
  const tags = tagsOf();
  const last = latestTag(tags.map((t) => t.name));
  const commits = commitsOf("--no-merges", ...(last ? [`${last}..origin/main`] : ["-n", "50", "origin/main"]));
  const no = releaseRefusal({ mainTagged: tags.find((t) => t.sha == M)?.name ?? null, commits: commits.length });
  if (no) fail(no);
  const v = nextVersion(last, asked);
  if ("problem" in v) return fail(v.problem);
  const notes = releaseNotes(last, commits);
  say(`Release ${v.version} at main ${M.slice(0, 12)} (${commits.length} commits since ${last ?? "the start"}).`);
  say();
  say(notes);
  if (dry) {
    say("NOTE  A dry run: nothing is made. Without --dry-run, this makes the tag and the GitHub release.");
    return;
  }
  const r = sh(["gh", "release", "create", v.version, "-R", repo, "--target", M, "--title", v.version, "--notes-file", "-"], {
    input: notes,
  });
  if (!r.ok) fail(`gh release create failed: ${r.err}`);
  fetchOrigin();
  pass(`${v.version} is released: ${r.out}`);
}

// ------------------------------------------------------------------ deploy and rollback

/** A host from a host or a URL. */
const hostOf = async (arg: string) => new URL((await import("./config")).originOf(arg)).host;

async function deploy(args: string[], noTests: boolean, fresh: boolean, home: string | undefined) {
  if (!args.length || args.length > 2)
    fail("Name the instance: bun erga deploy [<commit>] <host> [--no-tests] [--fresh] [--home <domain>].");
  const [commit, host] = args.length == 2 ? [args[0], await hostOf(args[1])] : [undefined, await hostOf(args[0])];
  const { ergaDir } = await import("./config");
  const { deployInstance } = await import("./deploy");
  const command = [
    "bun erga deploy",
    ...args,
    ...(noTests ? ["--no-tests"] : []),
    ...(fresh ? ["--fresh"] : []),
    ...(home ? ["--home", home] : []),
  ].join(" ");
  const sha = await deployInstance({
    dir: ergaDir(),
    host,
    commit,
    noTests,
    fresh,
    command,
    from: fromOf(),
    ...(home ? { home } : {}),
  }).catch((e: Error) => fail(e.message));
  pass(`${host} runs ${sha.slice(0, 12)}, healthy.`);
}

async function rollback(arg: string | undefined, yes: boolean) {
  if (!arg) return fail("Name the instance: bun erga rollback <host> [--yes].");
  const { ergaDir } = await import("./config");
  const { rollbackInstance } = await import("./deploy");
  const host = await hostOf(arg);
  const ask = yes ? undefined : (q: string) => /^y(es)?$/i.test(prompt(q)?.trim() ?? "");
  await rollbackInstance({ dir: ergaDir(), host, ask }).catch((e: Error) => fail(e.message));
  say("NOTE  The next deploy goes forward again.");
}

// ------------------------------------------------------------------ register and login

/** An instance's host and address, from a host or a URL. */
const instanceOf = async (arg: string | undefined, usage: string) => {
  if (!arg) return fail(`Name the instance: ${usage}.`);
  const { originOf } = await import("./config");
  const origin = originOf(arg);
  return { origin, host: new URL(origin).host };
};

/** Asks the instance for an ops token, which an admin approves in the browser, and reads its facts with it. */
async function signInTo(origin: string) {
  const { askOpsToken, readOps } = await import("./ops");
  say(`Ask ${origin} for an ops token (an admin only, 90 days at most).`);
  const { token, login } = await askOpsToken(origin, { say: (line) => say(`      ${line}`) });
  pass(`${login} approved the ops token.`);
  return { token, facts: await readOps(origin, token) };
}

async function register(arg: string | undefined, stagingOf: string | undefined) {
  const { host, origin } = await instanceOf(arg, "bun erga register <host> [--staging-of <host>]");
  const { configPath, entryOf, ergaDir, originOf, readConfig, stagingRefusal, withEntry, writeConfig } = await import("./config");
  const dir = ergaDir();
  const primary = stagingOf ? new URL(originOf(stagingOf)).host : entryOf(readConfig(dir), host)?.stagingOf;
  const no = primary ? stagingRefusal(readConfig(dir), host, primary) : null;
  if (no) fail(no);
  const { token, facts } = await signInTo(origin);
  if (!facts.deploy)
    fail(
      `${host} gave no deploy facts: no deploy from the pipeline set them.`,
      `Deploy ${host} with this commit or a later one, then register again.`
    );
  // Read the file again: another terminal can have changed it while the admin approved.
  writeConfig(dir, withEntry(readConfig(dir), { host, ...(primary ? { stagingOf: primary } : {}), ...facts.deploy!, token }));
  pass(`${host} is registered in ${configPath(dir)}${primary ? `, as a staging instance of ${primary}` : ""}.`);
  const d = facts.deploy!;
  const where =
    "aws" in d
      ? `AWS account ${d.aws.account}, ${d.aws.region}, stack ${d.aws.stack}`
      : `Worker ${d.worker}, database ${d.database}, account ${d.account}`;
  say(`      ${where}, ${Object.keys(d.vars).length} plain settings. It runs ${facts.version ?? "no known commit"}.`);
}

async function login(arg: string | undefined) {
  const { host } = await instanceOf(arg, "bun erga login <host>");
  const { configPath, entryOf, entryOrigin, ergaDir, readConfig, withEntry, writeConfig } = await import("./config");
  const dir = ergaDir();
  const had = entryOf(readConfig(dir), host) ?? fail(`${host} has no entry in ${configPath(dir)}.`, `bun erga register ${host}`);
  const { token } = await signInTo(entryOrigin(had));
  const entry =
    entryOf(readConfig(dir), host) ??
    fail(`${host}'s entry left ${configPath(dir)} while the admin approved.`, `bun erga register ${host}`);
  writeConfig(dir, withEntry(readConfig(dir), { ...entry, token }));
  pass(`${host} has a new ops token in ${configPath(dir)}.`);
}

// ------------------------------------------------------------------ the commands

export async function main(argv: string[]) {
  // No command, or only the ops page's options: the ops page.
  const [cmd, ...rest] = argv[0] == undefined || /^--(port|no-open)$/.test(argv[0]) ? ["", ...argv] : argv;
  const flag = (f: string) => rest.includes(f);
  const opt = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const plain = rest.filter(
    (x, i) => !x.startsWith("-") && !["-m", "--port", "--staging-of", "--home", "--days"].includes(rest[i - 1] ?? "")
  );
  switch (cmd) {
    case "skill":
      return say(readFileSync(join(ROOT, "deploy/cli/SKILL.md"), "utf8"));
    case "start":
      return start(plain[0]);
    case "proof": {
      const all = (f: string) => rest.flatMap((x, i) => (x == f && rest[i + 1] != undefined ? [rest[i + 1]] : []));
      return proof(
        rest.find((x, i) => !x.startsWith("--") && !["--look", "--no-picture"].includes(rest[i - 1] ?? "")),
        all("--look"),
        opt("--no-picture")
      );
    }
    case "loops":
      return loops(Number(opt("--days")) || 7);
    case "clean":
      return clean(flag("--yes"));
    case "push":
      return push();
    case "status": {
      const { ergaDir, readConfig } = await import("./config");
      const s = await readState(readConfig(ergaDir()));
      return say(flag("--json") ? JSON.stringify(s, null, 2) : statusText(s, (sha) => headOf(sha) != null));
    }
    case "": {
      const { startOpsPage } = await import("./ops-page");
      const { ergaDir } = await import("./config");
      const port = opt("--port");
      startOpsPage({ dir: ergaDir(), cwd: process.cwd(), port: port == undefined ? undefined : Number(port), open: !flag("--no-open") });
      return;
    }
    case "merge":
      return merge(rest);
    case "full":
      return full(plain[0]);
    case "release":
      return release(plain[0], flag("--dry-run"));
    case "deploy":
      return deploy(plain, flag("--no-tests"), flag("--fresh"), opt("--home"));
    case "rollback":
      return rollback(plain[0], flag("--yes"));
    case "register":
      // The server's or the file's error, in its own words.
      return register(plain[0], opt("--staging-of")).catch((e: Error) => fail(e.message));
    case "login":
      return login(plain[0]).catch((e: Error) => fail(e.message));
    case "setup": {
      const { setupMain } = await import("../own/cli");
      return setupMain(rest);
    }
    case "help":
    case "--help":
    case "-h":
      return help();
    default:
      say(`No command ${cmd}.`);
      help(2);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
