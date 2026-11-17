#!/usr/bin/env bun
// Erga's command line: `bun erga <command>`. Development happens on feature branches; `merge` puts a branch on staging
// as one commit, `promote` moves main to staging's head, `release` tags main. An instance tracks one branch of one
// repository: `deploy` gives it that branch's head. Every deploy runs on this machine: a push deploys nothing.
// `bun erga skill` is the agents' manual.
//
//   bun erga [--auto-deploy] [--port N] [--no-open]
//                                       the ops page on localhost: the registered instances, deploys, logs, history;
//                                       --auto-deploy: it checks the branch of each instance once a minute, and
//                                       deploys a new commit to the instance (bun erga deploy), one job at a time
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
//   bun erga status                     each registered instance's branch, commit and health, the feature branches, each
//                                       with its tests' state (in the queue, running, passed, failed with the tests'
//                                       names), and the commits, as text; it only reads (no fetch)
//   bun erga merge <branch>... [-m text]
//                                       each branch onto staging as one commit, then the gate (the tests, bun run
//                                       test, passed on the result: it runs them if no run has), and the push of
//                                       staging; it deploys nothing; -m is for the branch before it
//   bun erga promote                    moves main forward to staging's head, when the tests passed on it and each
//                                       instance that tracks staging runs it, healthy; it deploys nothing
//   bun erga test [<branch>|<commit>]   the gate's run: bun run test on a branch's merge onto staging, or on a commit
//                                       (default: staging's head), in a scratch folder; a tree that ran before runs
//                                       no more; the ops page runs it for each pushed branch
//   bun erga release [vX.Y.Z|major|minor|patch] [--dry-run]   tags main and makes a GitHub release
//   bun erga deploy [<commit>] <host> [--no-tests]            deploys a registered instance from this machine: the head
//                                       of the branch it tracks, or a commit of that branch; no branch moves;
//                                       the commits main and staging are origin's branches, never the clone's own;
//                                       --domain <domain> (it can repeat): the instance takes a custom domain, which
//                                       a document can be published to from now on
//   bun erga track <host> [--repo <repo>] [--branch <branch>] [--upstream <branch> [--upstream-repo <repo>] | --no-upstream]
//                                       the repository and the branch that a registered instance tracks
//                                       (github.com/koomen/erga, main), and its upstream: a branch (of the same
//                                       repository, or of --upstream-repo) that the ops page and status compare its
//                                       branch with; with no option, it prints them
//   bun erga rollback <host> [--yes]    a registered instance's Worker version from before its last deploy
//   bun erga register <host> [--repo <repo>] [--branch <branch>] [--upstream <branch> [--upstream-repo <repo>]]
//                     [--host aws [--profile <name>] [--region <region>]]
//                                       adds an instance that runs already to .erga/config.json: its deploy facts and
//                                       its plain settings, read from its platform with this machine's login
//                                       (Cloudflare's API; with --host aws, the AWS CLI), and the repository and
//                                       branch it tracks
//   bun erga setup <host> --host ... --sign-in ... [--repo <repo>] [--branch <branch>] [--dry-run]
//                                       a new instance, on Cloudflare or AWS, from the user's answers: the checks and
//                                       the plan (--dry-run), then the build and the first admin (bun erga setup --help)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { latestTag, mergeArgs, nextVersion, releaseNotes, releaseRefusal, statusText } from "./flow";
import { gateRefusal } from "./gate";
import { commitsOf, fetchOrigin, headOf, readState, repoOf, tagsOf } from "./observe";
import { fail, pass, ROOT, say, sh } from "../root";


/** Where this command came from: ERGA_JOB_FROM=page or auto-deploy when the ops page runs it (ops-page.ts), else a terminal. */
const fromOf = () =>
  process.env.ERGA_JOB_FROM == "page" ? "page" : process.env.ERGA_JOB_FROM == "auto-deploy" ? "auto-deploy" : "terminal";

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
  try {
    const dir = startFolder({ clone: dirname(ergaDir()), name, log: say });
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
    pushBranch({ root: ROOT, log: say });
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

async function promote() {
  needRepo();
  const { ergaDir } = await import("./config");
  const { promote: run } = await import("./promote");
  const sha = await run({ dir: ergaDir(), from: fromOf() }).catch((e: Error) => fail(e.message));
  if (sha) pass(`main is at ${sha.slice(0, 12)}.`);
}

// ------------------------------------------------------------------ test

async function test(name: string | undefined) {
  const { ergaDir } = await import("./config");
  const { testRun, treeOf } = await import("./test-run");
  const { mergeTree } = await import("./observe");
  const { PROTECTED } = await import("./flow");
  const dir = ergaDir();
  const clone = dirname(dir);
  const has = (ref: string) => sh(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: process.cwd() });
  const log = (line: string) => say(line);
  // A feature branch: the tree of its merge onto staging, as the ops page's row and `bun erga merge` test it.
  if (name && !(PROTECTED as readonly string[]).includes(name) && has(`origin/${name}`).ok) {
    const m = mergeTree("origin/staging", `origin/${name}`, clone);
    if (!m.tree) fail(`${name} conflicts with staging in ${m.conflicts.join(", ")}.`, "Rebase it on origin/staging, and push it.");
    const what = `${name} on staging ${has("origin/staging").out.slice(0, 7)}`;
    const r = await testRun({ dir, clone, tree: m.tree!, what, branch: name, log }).catch((e: Error) => fail(e.message));
    if (r.state != "passed") fail(gateRefusal(r, what)!);
    return;
  }
  // A commit: the name is read where the command is typed (HEAD is this folder's commit).
  const sha = has(name ?? "origin/staging").out;
  if (!sha) fail(`This clone has no branch origin/${name} and no commit ${name ?? "origin/staging"}.`, "git fetch");
  const r = await testRun({ dir, clone, tree: treeOf(clone, sha)!, commit: sha, what: sha.slice(0, 12), log }).catch((e: Error) =>
    fail(e.message)
  );
  if (r.state != "passed") fail(gateRefusal(r, sha.slice(0, 12))!);
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

async function deploy(args: string[], noTests: boolean, domains: string[]) {
  if (!args.length || args.length > 2) fail("Name the instance: bun erga deploy [<commit>] <host> [--no-tests] [--domain <domain>]...");
  const [commit, host] = args.length == 2 ? [args[0], await hostOf(args[1])] : [undefined, await hostOf(args[0])];
  const { ergaDir } = await import("./config");
  const { deployInstance } = await import("./deploy");
  const command = [
    "bun erga deploy",
    ...args,
    ...(noTests ? ["--no-tests"] : []),
    ...domains.flatMap((d) => ["--domain", d]),
  ].join(" ");
  const sha = await deployInstance({
    dir: ergaDir(),
    host,
    commit,
    noTests,
    command,
    from: fromOf(),
    ...(domains.length ? { domains } : {}),
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

// ------------------------------------------------------------------ register

/** An instance's host and address, from a host or a URL. */
const instanceOf = async (arg: string | undefined, usage: string) => {
  if (!arg) return fail(`Name the instance: ${usage}.`);
  const { originOf } = await import("./config");
  const origin = originOf(arg);
  return { origin, host: new URL(origin).host };
};

async function register(
  arg: string | undefined,
  o: { repo?: string; branch?: string; where?: string; profile?: string; region?: string } & UpstreamOptions
) {
  const { host } = await instanceOf(
    arg,
    "bun erga register <host> [--repo <repo>] [--branch <branch>] [--upstream <branch> [--upstream-repo <repo>]] [--host aws [--profile <name>] [--region <region>]]"
  );
  if (o.where && o.where != "aws" && o.where != "cloudflare") fail(`--host ${o.where}: cloudflare (the default) or aws.`);
  const {
    configPath,
    DEFAULT_BRANCH,
    DEFAULT_REPO,
    entryOf,
    ergaDir,
    readConfig,
    repoName,
    upstreamName,
    withEntry,
    withUpstream,
    writeConfig,
  } = await import("./config");
  const { findInstance } = await import("./running");
  const dir = ergaDir();
  const had = entryOf(readConfig(dir), host);
  // The platform's own login is the authority: the instance is asked nothing.
  const { facts, version } = await findInstance(host, {
    where: o.where == "aws" ? "aws" : "cloudflare",
    profile: o.profile,
    region: o.region,
  });
  // The entry keeps what it tracks.
  const repo = o.repo ? repoName(o.repo) : (had?.repo ?? DEFAULT_REPO);
  const branch = o.branch ?? had?.branch ?? DEFAULT_BRANCH;
  const made = withUpstream({ host, repo, branch, ...(had?.upstream ? { upstream: had.upstream } : {}), ...facts }, o);
  const entry = typeof made == "string" ? fail(made) : made;
  writeConfig(dir, withEntry(readConfig(dir), entry));
  pass(
    `${host} is registered in ${configPath(dir)}: it tracks ${repo} ${branch}${entry.upstream ? `, with the upstream ${upstreamName({ repo, upstream: entry.upstream })}` : ""}.`
  );
  const where =
    "aws" in facts
      ? `AWS account ${facts.aws.account}, ${facts.aws.region}, stack ${facts.aws.stack}`
      : `Worker ${facts.worker}, database ${facts.database}, account ${facts.account}`;
  say(`      ${where}, ${Object.keys(facts.vars).length} plain settings. It runs ${version ?? "no known commit"}.`);
}

/** The options of an instance's upstream: --upstream <branch> [--upstream-repo <repo>], or --no-upstream. */
interface UpstreamOptions {
  upstream?: string;
  upstreamRepo?: string;
  noUpstream?: boolean;
}

/**
 * `bun erga track <host> [--repo <repo>] [--branch <branch>] [--upstream <branch> [--upstream-repo <repo>] | --no-upstream]`:
 * what a registered instance tracks, and the upstream that the ops page and status compare its branch with. It deploys nothing.
 */
async function track(arg: string | undefined, o: { repo?: string; branch?: string } & UpstreamOptions) {
  const { host } = await instanceOf(
    arg,
    "bun erga track <host> [--repo <repo>] [--branch <branch>] [--upstream <branch> [--upstream-repo <repo>] | --no-upstream]"
  );
  const { configPath, entryOf, ergaDir, readConfig, remoteOf, repoName, upstreamName, withEntry, withUpstream, writeConfig } = await import(
    "./config"
  );
  const dir = ergaDir();
  const had = entryOf(readConfig(dir), host) ?? fail(`${host} has no entry in ${configPath(dir)}.`, `bun erga register ${host}`);
  const upstreamOf = (e: typeof had) =>
    e.upstream ? `Its upstream is ${upstreamName({ repo: e.repo, upstream: e.upstream })}.` : "It has no upstream.";
  if (!o.repo && !o.branch && !o.upstream && !o.upstreamRepo && !o.noUpstream)
    return say(`${host} tracks ${had.repo} ${had.branch}. ${upstreamOf(had)}`);
  const tracked = { ...had, repo: o.repo ? repoName(o.repo) : had.repo, branch: o.branch ?? had.branch };
  const made = withUpstream(tracked, o);
  const entry = typeof made == "string" ? fail(made) : made;
  // The branch must be there: a deploy takes its head. The upstream's branch too: the comparison needs it.
  const { remoteHead } = await import("./deploy");
  const head =
    remoteHead(dirname(dir), remoteOf(dirname(dir), entry.repo), entry.branch) ??
    fail(`${entry.repo} has no branch ${entry.branch}. ${host} tracks ${had.repo} ${had.branch}, as before.`);
  if (
    entry.upstream &&
    (o.upstream || o.upstreamRepo) &&
    !remoteHead(dirname(dir), remoteOf(dirname(dir), entry.upstream.repo), entry.upstream.branch)
  )
    fail(
      `${entry.upstream.repo} has no branch ${entry.upstream.branch}, or this machine can't read it. ${host} is as before. ${upstreamOf(had)}`
    );
  writeConfig(dir, withEntry(readConfig(dir), entry));
  const moved = entry.repo != had.repo || entry.branch != had.branch;
  pass(
    `${host} tracks ${entry.repo} ${entry.branch}${moved ? ` (before: ${had.repo} ${had.branch})` : ""}. Its head is ${head.slice(0, 12)}. ${upstreamOf(entry)}`
  );
  say(
    moved
      ? `NEXT  Nothing deployed. To deploy the branch's head: bun erga deploy ${host}`
      : "NOTE  Nothing deployed, and no branch moved. The ops page (bun erga) and bun erga status compare the two."
  );
}

// ------------------------------------------------------------------ the commands

export async function main(argv: string[]) {
  // No command, or only the ops page's options: the ops page.
  const [cmd, ...rest] = argv[0] == undefined || /^--(auto-deploy|port|no-open)$/.test(argv[0]) ? ["", ...argv] : argv;
  const flag = (f: string) => rest.includes(f);
  const opt = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const plain = rest.filter(
    (x, i) =>
      !x.startsWith("-") &&
      !["-m", "--port", "--repo", "--branch", "--upstream", "--upstream-repo", "--domain", "--host", "--profile", "--region"].includes(
        rest[i - 1] ?? ""
      )
  );
  const upstream = { upstream: opt("--upstream"), upstreamRepo: opt("--upstream-repo"), noUpstream: flag("--no-upstream") };
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
    case "clean":
      return clean(flag("--yes"));
    case "push":
      return push();
    case "status": {
      const { ergaDir, readConfig } = await import("./config");
      const { readRuns } = await import("./test-run");
      const { testOf, testText } = await import("./gate");
      const { instanceReader } = await import("./running");
      const s = await readState(readConfig(ergaDir()), instanceReader());
      const runs = readRuns(ergaDir());
      s.branches = s.branches.map((b) => {
        const t = testOf({ name: b.name, tree: b.tree ?? null }, runs);
        const failed = t.at == "failed" ? gateRefusal(t.run, b.name)!.split("\n").slice(1) : [];
        return { ...b, tests: t.at == "none" ? [] : [testText(t, Date.now()), ...failed] };
      });
      return say(flag("--json") ? JSON.stringify(s, null, 2) : statusText(s, (sha) => headOf(sha) != null));
    }
    case "": {
      const { startOpsPage } = await import("./ops-page");
      const { ergaDir } = await import("./config");
      const port = opt("--port");
      startOpsPage({
        dir: ergaDir(),
        cwd: process.cwd(),
        port: port == undefined ? undefined : Number(port),
        open: !flag("--no-open"),
        autoDeploy: flag("--auto-deploy"),
      });
      return;
    }
    case "merge":
      return merge(rest);
    case "promote":
      return promote();
    case "test":
      return test(plain[0]);
    case "release":
      return release(plain[0], flag("--dry-run"));
    case "deploy":
      return deploy(
        plain,
        flag("--no-tests"),
        rest.flatMap((x, i) => (rest[i - 1] == "--domain" ? [x] : []))
      );
    case "rollback":
      return rollback(plain[0], flag("--yes"));
    case "register":
      // The platform's or the file's error, in its own words.
      return register(plain[0], {
        repo: opt("--repo"),
        branch: opt("--branch"),
        where: opt("--host"),
        profile: opt("--profile"),
        region: opt("--region"),
        ...upstream,
      }).catch((e: Error) => fail(e.message));
    case "track":
      return track(plain[0], { repo: opt("--repo"), branch: opt("--branch"), ...upstream }).catch((e: Error) => fail(e.message));
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
