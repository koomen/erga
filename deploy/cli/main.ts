#!/usr/bin/env bun
// Erga's command line: `bun erga <command>`. Development happens on feature branches; `merge` puts a branch on staging
// as one commit and deploys it to each staging instance, `deploy` deploys a primary and moves main, `release` tags main.
// Every deploy runs on this machine: a push deploys nothing. `bun erga skill` is the agents' manual.
//
//   bun erga skill                      how an agent works in this repository (the workflow and its rules)
//   bun erga start <branch>             a new feature branch from origin/staging, in this checkout
//   bun erga status                     production, staging, the feature branches and the commits, as text
//   bun erga dashboard [--port N]       the same, as a live page on localhost
//   bun erga merge <branch> [-m text]   the branch onto staging as one commit: tests, a deploy to each staging
//                                       instance, then the push of staging
//   bun erga release [vX.Y.Z|major|minor|patch] [--dry-run]   tags main and makes a GitHub release
//   bun erga deploy [<commit>] <host> [--no-tests]            deploys a registered instance from this machine; a primary
//                                       with no commit takes the commit its staging instances run, and main moves to it;
//                                       --fresh: a staging instance gets a new copy of its primary's data
//   bun erga rollback <host> [--yes]    a registered instance's Worker version from before its last deploy
//   bun erga register <host> [--staging-of <host>]            signs in to an instance as an admin, in the browser, and
//                                       adds it to .erga/config.json: its deploy facts, its plain settings, an ops token
//   bun erga login <host>               a new ops token for a registered instance, when its token runs out
//   bun erga setup <host>               a new instance: the answers, the first deploy, the first admin, the ops token
//                                       (bun erga setup skill; bun erga setup help)

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  latestTag,
  mergeRefusal,
  nextVersion,
  PROTECTED,
  releaseNotes,
  releaseRefusal,
  squashMessage,
  statusText,
} from "./flow";
import {
  commitsOf,
  conflictsOf,
  fetchOrigin,
  git,
  headOf,
  readState,
  repoOf,
  ROOT,
  sh,
  tagsOf,
} from "./observe";

const say = (s = "") => console.log(s);
const pass = (s: string) => say(`PASS  ${s}`);
const fail = (s: string, next?: string): never => {
  say(`FAIL  ${s}`);
  if (next) say(`NEXT  ${next}`);
  process.exit(1);
};

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

function start(name: string | undefined) {
  if (!name) fail("Name the branch: bun erga start <branch>.");
  if ((PROTECTED as readonly string[]).includes(name!)) fail(`${name} is not a feature branch name.`, "Pick another name.");
  if (!git("check-ref-format", "--branch", name!).ok) fail(`${name} is not a branch name git takes.`);
  const f = git("fetch", "--quiet", "origin", "staging");
  if (!f.ok) fail(`git fetch failed: ${f.err}`);
  const r = git("switch", "-c", name!, "origin/staging");
  if (!r.ok) fail(`git switch failed: ${r.err}`, "Commit or stash your changes first, or pick another name.");
  pass(`${name} starts at staging's head ${headOf("origin/staging")?.slice(0, 12)}.`);
  say(`NEXT  Commit, then push it: git push origin HEAD:${name}. When Pete asks: bun erga merge ${name}`);
}

// ------------------------------------------------------------------ merge

async function merge(branch: string | undefined, message: string | undefined) {
  needRepo();
  const f = fetchOrigin();
  if (!f.ok) fail(`git fetch failed: ${f.err}`);
  const name = branch ?? "";
  const exists = !!name && !!headOf(`origin/${name}`);
  const ahead = exists ? Number(git("rev-list", "--count", `origin/staging..origin/${name}`).out) : 0;
  const conflicts = exists && ahead ? conflictsOf("origin/staging", `origin/${name}`) : [];
  const no = mergeRefusal({ branch: name, exists, ahead, conflicts });
  if (no) fail(no);
  const text = squashMessage(name, commitsOf("--no-merges", `origin/staging..origin/${name}`), message);
  say(`Merge ${name} (${ahead} commit${ahead == 1 ? "" : "s"}) onto staging ${headOf("origin/staging")?.slice(0, 12)} as one commit:`);
  say(`      ${text.split("\n")[0]}`);

  // A worktree of its own, so this checkout stays as it is.
  const dir = mkdtempSync(join(tmpdir(), "erga-merge-"));
  const log = `${dir}.log`;
  const add = git("worktree", "add", "--quiet", "--detach", dir, "origin/staging");
  if (!add.ok) fail(`git worktree add failed: ${add.err}`);
  try {
    const at = (cmd: string[], o: { input?: string; env?: Record<string, string> } = {}) => sh(cmd, { cwd: dir, ...o });
    const sq = at(["git", "merge", "--squash", `origin/${name}`]);
    if (!sq.ok) fail(`git merge --squash failed: ${sq.err || sq.out}`, `Rebase ${name} on origin/staging, push it, and merge again.`);
    const c = at(["git", "commit", "--quiet", "-F", "-"], { input: text });
    if (!c.ok) fail(`git commit failed: ${c.err || c.out}`);
    const sha = at(["git", "rev-parse", "HEAD"]).out;
    say("      bun install --frozen-lockfile ...");
    const i = at(["bun", "install", "--frozen-lockfile"]);
    if (!i.ok) fail(`bun install failed: ${i.err.slice(-600)}`);
    say(`      bun run test ... (the log: ${log})`);
    const t = at(["bun", "run", "test"]);
    writeFileSync(log, `${t.out}\n${t.err}`);
    if (!/^all passing/m.test(t.out)) {
      say(t.out.split("\n").slice(-30).join("\n"));
      fail(
        `bun run test did not end with "all passing" on the merged commit. The log: ${log}`,
        `Fix it on ${name}, push it, and merge again.`
      );
    }
    pass("bun run test: all passing.");
    const { ergaDir } = await import("./config");
    const { deployStaging, recordPass } = await import("./deploy");
    recordPass(ergaDir(), sha, t.out);
    const hosts = await deployStaging({ dir: ergaDir(), sha, command: `bun erga merge ${name}` }).catch((e: Error) =>
      fail(e.message, `Fix it, then run bun erga merge ${name} again.`)
    );
    for (const h of hosts) pass(`${h} runs ${sha.slice(0, 12)}, healthy.`);
    pass(`Merged ${name} as ${sha.slice(0, 12)}: ${text.split("\n")[0]}`);
    const d = git("push", "--quiet", "origin", "--delete", name);
    if (d.ok) pass(`The branch ${name} is deleted on GitHub.`);
    else say(`NOTE  The branch ${name} is still on GitHub: ${d.err}`);
    if (git("rev-parse", "--verify", "--quiet", `refs/heads/${name}`).ok)
      say(`NOTE  The local branch ${name} is still here. Delete it when you are done with it: git branch -D ${name}`);
  } finally {
    git("worktree", "remove", "--force", dir);
  }
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

async function deploy(args: string[], noTests: boolean, fresh: boolean) {
  if (!args.length || args.length > 2) fail("Name the instance: bun erga deploy [<commit>] <host> [--no-tests] [--fresh].");
  const [commit, host] = args.length == 2 ? [args[0], await hostOf(args[1])] : [undefined, await hostOf(args[0])];
  const { ergaDir } = await import("./config");
  const { deployInstance } = await import("./deploy");
  const command = ["bun erga deploy", ...args, ...(noTests ? ["--no-tests"] : []), ...(fresh ? ["--fresh"] : [])].join(" ");
  const sha = await deployInstance({ dir: ergaDir(), host, commit, noTests, fresh, command }).catch((e: Error) => fail(e.message));
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
  say(
    `      Worker ${facts.deploy!.worker}, database ${facts.deploy!.database}, account ${facts.deploy!.account}, ${Object.keys(facts.deploy!.vars).length} plain settings. It runs ${facts.version ?? "no known commit"}.`
  );
}

async function login(arg: string | undefined) {
  const { host, origin } = await instanceOf(arg, "bun erga login <host>");
  const { configPath, entryOf, ergaDir, readConfig, withEntry, writeConfig } = await import("./config");
  const dir = ergaDir();
  if (!entryOf(readConfig(dir), host)) fail(`${host} has no entry in ${configPath(dir)}.`, `bun erga register ${host}`);
  const { token } = await signInTo(origin);
  const entry =
    entryOf(readConfig(dir), host) ??
    fail(`${host}'s entry left ${configPath(dir)} while the admin approved.`, `bun erga register ${host}`);
  writeConfig(dir, withEntry(readConfig(dir), { ...entry, token }));
  pass(`${host} has a new ops token in ${configPath(dir)}.`);
}

// ------------------------------------------------------------------ the commands

export async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const flag = (f: string) => rest.includes(f);
  const opt = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const plain = rest.filter((x, i) => !x.startsWith("-") && !["-m", "--port", "--staging-of"].includes(rest[i - 1] ?? ""));
  switch (cmd) {
    case "skill":
      return say(readFileSync(join(ROOT, "deploy/cli/SKILL.md"), "utf8"));
    case "start":
      return start(plain[0]);
    case "status": {
      const s = await readState();
      return say(flag("--json") ? JSON.stringify(s, null, 2) : statusText(s));
    }
    case "dashboard": {
      const { startDashboard } = await import("./dashboard");
      return startDashboard(Number(opt("--port")) || 4748, flag("--open"));
    }
    case "merge":
      return merge(plain[0], opt("-m"));
    case "release":
      return release(plain[0], flag("--dry-run"));
    case "deploy":
      return deploy(plain, flag("--no-tests"), flag("--fresh"));
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
    case undefined:
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
