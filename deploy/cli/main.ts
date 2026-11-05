#!/usr/bin/env bun
// Erga's command line: `bun erga <command>`. Development happens on feature branches; `merge` puts a branch on staging
// as one commit, `promote` moves main (production) to staging, `release` tags main. `bun erga skill` is the agents' manual.
//
//   bun erga skill                      how an agent works in this repository (the workflow and its rules)
//   bun erga start <branch>             a new feature branch from origin/staging, in this checkout
//   bun erga status                     production, staging, the feature branches and the commits, as text
//   bun erga dashboard [--port N]       the same, as a live page on localhost
//   bun erga merge <branch> [-m text]   the branch onto staging as one commit: tests, push, wait for the deploy
//   bun erga promote                    main to staging's head (production deploys): only when Pete asks
//   bun erga release [vX.Y.Z|major|minor|patch] [--dry-run]   tags main and makes a GitHub release
//   bun erga rollback <staging|production> [--yes]            the Worker version from before the last deploy
//   bun erga own <command>              your own Erga on your own domain: fork, deploy, checklist (bun erga own help)

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT, TARGETS } from "../targets";
import {
  latestTag,
  mergeRefusal,
  nextVersion,
  PROTECTED,
  previousVersion,
  promoteRefusal,
  releaseNotes,
  releaseRefusal,
  squashMessage,
  statusText,
} from "./flow";
import {
  answerOf,
  commitsOf,
  conflictsOf,
  fetchOrigin,
  ghJson,
  git,
  headOf,
  jobsOf,
  readState,
  repoOf,
  ROOT,
  runsOf,
  serversOf,
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
/** The environment of a push that `bun erga` makes: the pre-push hook lets it through (deploy/cli/pre-push.ts). */
const CLI_PUSH = { ERGA_CLI_PUSH: "1" };

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

// ------------------------------------------------------------------ waiting for a deploy

/** Waits for the workflow run of `sha` on `branch`, says each job's result, then checks the branch's servers. */
async function waitDeploy(repo: string, sha: string, branch: string) {
  const short = sha.slice(0, 12);
  let run = runsOf(repo, { commit: sha, branch, limit: 5 })[0];
  for (let i = 0; !run && i < 24; i++) {
    await Bun.sleep(5000);
    run = runsOf(repo, { commit: sha, branch, limit: 5 })[0];
  }
  if (!run) fail(`GitHub started no workflow run for ${short} on ${branch} in 2 minutes.`, `gh run list -R ${repo} --branch ${branch}`);
  say(`      The run: ${run.url}`);
  const seen = new Map<string, string>();
  const deadline = Date.now() + 45 * 60_000;
  let view: { status: string; conclusion: string } | null = null;
  while (Date.now() < deadline) {
    view = ghJson<{ status: string; conclusion: string }>("run", "view", String(run.id), "-R", repo, "--json", "status,conclusion");
    for (const j of jobsOf(repo, run.id)) {
      const now = j.status == "completed" ? j.conclusion : j.status;
      if (seen.get(j.name) != now) say(`      job ${j.name}: ${now}`);
      seen.set(j.name, now);
    }
    if (view?.status == "completed") break;
    await Bun.sleep(15_000);
  }
  if (!view || view.status != "completed") return fail(`The run did not end in 45 minutes: ${run.url}`);
  if (view.conclusion != "success") fail(`The run ended with ${view.conclusion}: ${run.url}`, "Read the failed job's log there.");
  pass(`The run for ${short} ended with success.`);
  for (const s of serversOf(repo).filter((x) => x.branch == branch)) {
    let a = await answerOf(s.host);
    for (let i = 0; i < 12 && (a.version != short || !a.healthy); i++) {
      await Bun.sleep(5000);
      a = await answerOf(s.host);
    }
    const line = `${s.name} https://${s.host}: version ${a.version ?? "no answer"}, health ${a.healthy ? "ok" : "FAIL"}`;
    if (a.version == short && a.healthy) pass(line);
    else say(`FAIL  ${line} (expected ${short})`);
  }
}

// ------------------------------------------------------------------ merge

async function merge(branch: string | undefined, message: string | undefined, wait: boolean) {
  const repo = needRepo();
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
    const p = at(["git", "push", "--quiet", "origin", "HEAD:refs/heads/staging"], { env: CLI_PUSH });
    if (!p.ok) fail(`The push to staging failed: ${p.err}`, "Staging moved while the tests ran: run bun erga merge again.");
    pass(`staging is at ${sha.slice(0, 12)}: ${text.split("\n")[0]}`);
    const d = git("push", "--quiet", "origin", "--delete", name);
    if (d.ok) pass(`The branch ${name} is deleted on GitHub.`);
    else say(`NOTE  The branch ${name} is still on GitHub: ${d.err}`);
    if (git("rev-parse", "--verify", "--quiet", `refs/heads/${name}`).ok)
      say(`NOTE  The local branch ${name} is still here. Delete it when you are done with it: git branch -D ${name}`);
    if (wait) await waitDeploy(repo, sha, "staging");
    else say(`NEXT  bun erga status shows staging's deploy.`);
  } finally {
    git("worktree", "remove", "--force", dir);
  }
}

// ------------------------------------------------------------------ promote

async function promote(wait: boolean) {
  const repo = needRepo();
  fetchOrigin();
  const S = headOf("origin/staging"),
    M = headOf("origin/main");
  if (!S || !M) return fail("There is no origin/staging or origin/main.");
  const fastForward = git("merge-base", "--is-ancestor", M, S).ok;
  const run = runsOf(repo, { commit: S, branch: "staging", limit: 5 })[0] ?? null;
  const spec = serversOf(repo).find((s) => s.branch == "staging") ?? null;
  const server = spec ? { ...spec, ...(await answerOf(spec.host)) } : null;
  const no = promoteRefusal({ staging: S, main: M, fastForward, run, server });
  if (no) fail(no);
  const count = git("rev-list", "--count", `${M}..${S}`).out;
  say(`Promote: main ${M.slice(0, 12)} to staging ${S.slice(0, 12)} (${count} commits).`);
  const p = sh(["git", "push", "--quiet", "origin", `${S}:refs/heads/main`], { env: CLI_PUSH });
  if (!p.ok) fail(`The push to main failed: ${p.err}`);
  pass(`main is at ${S.slice(0, 12)}. GitHub deploys production now.`);
  if (wait) await waitDeploy(repo, S, "main");
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

// ------------------------------------------------------------------ rollback

async function rollback(name: string | undefined, yes: boolean) {
  if (name != "staging" && name != "production") return fail("Name the server: bun erga rollback <staging|production>.");
  const { machineCredential } = await import("../local-credential");
  const { Cloudflare, rollbackTo } = await import("../pipeline/pipeline");
  const { answersOf, loadOwn } = await import("../own/store");
  const { hostOf, namesOf } = await import("../own/plan");
  // Your own Erga (.erga/own.json), else Erga's own servers (deploy/targets.json).
  const own = loadOwn();
  const a = own.answers ? answersOf(own) : null;
  const host = a ? hostOf(a, name) : TARGETS[name].host;
  if (!host) return fail(`This Erga has no ${name} server.`);
  const worker = a ? namesOf(host).worker : TARGETS[name].worker;
  const accountId = a ? (own.account ?? "") : ACCOUNT;
  if (!accountId) fail("No Cloudflare account in .erga/own.json.", "bun erga own set account=<id>");
  const cred = machineCredential() ?? fail("No Cloudflare credential on this machine.", "bunx cf auth login, or set CLOUDFLARE_API_TOKEN.");
  const cf = new Cloudflare(cred.token);
  const list = await cf.call<{ deployments: { created_on: string; versions: { version_id: string; percentage: number }[] }[] }>(
    "GET",
    `/accounts/${accountId}/workers/scripts/${worker}/deployments`,
    `read ${worker}'s deployments`
  );
  const sorted = [...(list?.deployments ?? [])].sort((x, y) => Date.parse(y.created_on) - Date.parse(x.created_on));
  const p = previousVersion(sorted);
  if (!p) return fail(`${worker} has no deployment of another version to go back to.`);
  const before = await answerOf(host);
  say(`${name} (${worker}, https://${host}) runs release ${before.version ?? "?"}, Worker version ${p.now}.`);
  say(`Rollback goes to the Worker version before it: ${p.before}. The database stays as it is.`);
  if (!yes) {
    const answer = prompt("Roll back now? [y/N]");
    if (!/^y(es)?$/i.test(answer?.trim() ?? "")) fail("Not rolled back.");
  }
  await rollbackTo(cf, { accountId, workerName: worker }, p.before, `bun erga rollback ${name}`);
  let after = await answerOf(host);
  for (let i = 0; i < 6 && after.version == before.version; i++) {
    await Bun.sleep(5000);
    after = await answerOf(host);
  }
  pass(`${name} runs release ${after.version ?? "?"} now, health ${after.healthy ? "ok" : "FAIL"}.`);
  say("NOTE  The next push to its branch deploys forward again.");
}

// ------------------------------------------------------------------ the commands

export async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const flag = (f: string) => rest.includes(f);
  const opt = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const plain = rest.filter((x, i) => !x.startsWith("-") && !["-m", "--port"].includes(rest[i - 1] ?? ""));
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
      return merge(plain[0], opt("-m"), !flag("--no-wait"));
    case "promote":
      return promote(!flag("--no-wait"));
    case "release":
      return release(plain[0], flag("--dry-run"));
    case "rollback":
      return rollback(plain[0], flag("--yes"));
    case "own": {
      const { ownMain } = await import("../own/cli");
      return ownMain(rest);
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
