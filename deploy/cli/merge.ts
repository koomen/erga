// `bun erga merge <branch>... [-m text]`, and the ops page's Merge button (deploy/cli/ops-page.ts runs this command):
// each branch onto staging as one commit, in a worktree of its own, then one test run on the result, one deploy to each
// staging instance, and the push of staging. A branch that conflicts stays out. When the tests fail on several
// branches, they go one by one, each with its own test run, and a branch that fails stays out. It holds the lock
// .erga/jobs/staging.lock, and writes its job record (deploy.ts, startJob) on the first staging instance, so the ops
// page shows its output as it comes. After the merge, the whole test suite starts on the merged commit, in the
// background (full-run.ts).

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./config";
import { deployStaging, type From, recordPass, startJob, takeLock, testEnv } from "./deploy";
import { type Merge, mergeRefusal, squashMessage } from "./flow";
import { startFullRun } from "./full-run";
import { commitsIn, fetchOrigin, sh } from "./observe";
import { ROOT } from "../root";

/** What a merge did: the commits on staging, in their order, and the branches that stay out, each with its reason. */
export interface Merged {
  merged: { branch: string; sha: string }[];
  left: { branch: string; why: string }[];
}

/** `bun install` and `bun run test` in `dir`: the tests' output, which ends with "all passing" or not. */
function installAndTest(dir: string): string {
  // The tests run with no ERGA_JOB_FROM: a test's own job records are a terminal's.
  const i = sh(["bun", "install", "--frozen-lockfile"], { cwd: dir, env: testEnv() });
  if (!i.ok) return `bun install failed: ${i.err.slice(-600)}`;
  const t = sh(["bun", "run", "test"], { cwd: dir, env: testEnv() });
  return `${t.out}\n${t.err}`;
}

/**
 * Merges the branches onto staging, in their order. It throws when no branch merges: the error says what stopped it,
 * and what to do next. `clone`, `test`, `deploy` and `full` are for the tests: a clone of their own, and fakes.
 */
export async function mergeBranches(o: {
  dir: string;
  merges: Merge[];
  from?: From;
  print?: (line: string) => void;
  clone?: string;
  test?: (dir: string) => string;
  deploy?: (sha: string) => Promise<string[]>;
  full?: (sha: string) => void;
}): Promise<Merged> {
  const names = o.merges.map((m) => m.branch).join(" ");
  const command = `bun erga merge ${names}`;
  const clone = o.clone ?? ROOT;
  const free = takeLock(o.dir, "staging", command);
  const host = readConfig(o.dir).instances.find((e) => e.stagingOf)?.host ?? "staging";
  const job = startJob(o.dir, { command, host, from: o.from, print: o.print });
  const log = job.log;
  const git = (...args: string[]) => sh(["git", ...args], { cwd: clone });
  let dir = "";
  try {
    const f = o.clone ? git("fetch", "--quiet", "--prune", "origin") : fetchOrigin();
    if (!f.ok) throw new Error(`git fetch failed: ${f.err}`);
    const base = git("rev-parse", "origin/staging").out;

    // A worktree of its own, so this checkout stays as it is.
    dir = mkdtempSync(join(tmpdir(), "erga-merge-"));
    const logs = dir;
    const add = git("worktree", "add", "--quiet", "--detach", dir, base);
    if (!add.ok) {
      dir = "";
      throw new Error(`git worktree add failed: ${add.err}`);
    }
    const at = (...args: string[]) => sh(["git", ...args], { cwd: dir });
    const head = () => at("rev-parse", "HEAD").out;

    /** The branch as one commit on the worktree's head: the commit, or why the branch stays out (the head as it was). */
    const put = (m: Merge): { sha: string; text: string } | { why: string } => {
      const name = m.branch;
      const exists = git("rev-parse", "--verify", "--quiet", `origin/${name}^{commit}`).ok;
      const ahead = exists ? Number(git("rev-list", "--count", `origin/staging..origin/${name}`).out) : 0;
      const no = mergeRefusal({ branch: name, exists, ahead, conflicts: [] });
      if (no) return { why: no };
      const was = head();
      const out = (why: string) => (at("reset", "--quiet", "--hard", was), { why });
      const sq = at("merge", "--squash", `origin/${name}`);
      if (!sq.ok) {
        const files = at("diff", "--name-only", "--diff-filter=U").out.split("\n").filter(Boolean);
        return out(
          files.length
            ? mergeRefusal({ branch: name, exists, ahead, conflicts: files })!
            : `git merge --squash ${name} failed: ${sq.err || sq.out}`
        );
      }
      const text = squashMessage(commitsIn(clone, "--no-merges", `origin/staging..origin/${name}`), m.message);
      const c = sh(["git", "commit", "--quiet", "-F", "-"], { cwd: dir, input: text });
      if (!c.ok) return out(`git commit of ${name} failed: ${c.err || c.out}`);
      return { sha: head(), text: text.split("\n")[0] };
    };
    /** The tests on the worktree's head: null when they pass, else the reason. */
    const fails = (file: string, what: string): string | null => {
      log(`      bun install, bun run test on ${what} ... (the log: ${file})`);
      const out = (o.test ?? installAndTest)(dir);
      writeFileSync(file, out);
      if (/^all passing/m.test(out)) return null;
      for (const l of out.trim().split("\n").slice(-30)) log(l);
      return `bun run test did not end with "all passing" on ${what}. The log: ${file}`;
    };

    const result: Merged = { merged: [], left: [] };
    const leave = (branch: string, why: string) => {
      result.left.push({ branch, why });
      log(`FAIL  ${branch} stays out: ${why}`);
    };
    const texts = new Map<string, string>();
    log(`Merge ${names} onto staging ${base.slice(0, 12)}, one commit for each branch:`);
    for (const m of o.merges) {
      const p = put(m);
      if ("why" in p) leave(m.branch, p.why);
      else {
        result.merged.push({ branch: m.branch, sha: p.sha });
        texts.set(m.branch, p.text);
        log(`      ${p.sha.slice(0, 12)} ${m.branch}: ${p.text}`);
      }
    }
    if (result.merged.length) job.note({ commit: head() });
    const all = result.merged;
    const failed = all.length ? fails(`${logs}.log`, all.length == 1 ? "the merged commit" : `the ${all.length} merged commits`) : null;
    if (failed && all.length == 1) {
      result.merged = [];
      leave(all[0].branch, `${failed} Fix it on ${all[0].branch}, push it, and merge again.`);
    } else if (failed) {
      // The batch fails: each branch again, on the ones that passed before it, with a test run of its own.
      log("NOTE  The tests fail on the batch. The branches go one by one.");
      at("reset", "--quiet", "--hard", base);
      result.merged = [];
      for (const { branch } of all) {
        const was = head();
        const p = put(o.merges.find((m) => m.branch == branch)!);
        if ("why" in p) {
          leave(branch, p.why);
          continue;
        }
        const why = fails(`${logs}-${branch.replace(/[^\w.-]/g, "_")}.log`, branch);
        if (why) {
          at("reset", "--quiet", "--hard", was);
          leave(branch, `${why} Fix it on ${branch}, push it, and merge again.`);
        } else {
          result.merged.push({ branch, sha: p.sha });
          log(`PASS  ${branch}: all passing, as ${p.sha.slice(0, 12)}.`);
        }
      }
    }
    if (!result.merged.length) throw new Error(result.left.map((l) => l.why).join("\n"));

    const sha = head();
    job.note({ commit: sha });
    log("PASS  bun run test: all passing.");
    recordPass(o.dir, sha, "all passing");
    const deploy = o.deploy ?? ((s: string) => deployStaging({ dir: o.dir, sha: s, command, from: o.from, print: log }));
    const hosts = await deploy(sha).catch((e: Error) => {
      throw new Error(`${e.message} Fix it, then run ${command} again.`);
    });
    for (const h of hosts) log(`PASS  ${h} runs ${sha.slice(0, 12)}, healthy.`);
    for (const { branch, sha: s } of result.merged) {
      log(`PASS  Merged ${branch} as ${s.slice(0, 12)}: ${texts.get(branch)}`);
      const d = git("push", "--quiet", "origin", "--delete", branch);
      if (d.ok) log(`PASS  The branch ${branch} is deleted on GitHub.`);
      else log(`NOTE  The branch ${branch} is still on GitHub: ${d.err}`);
      if (git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).ok)
        log(`NOTE  The local branch ${branch} is still here. Delete it when you are done with it: git branch -D ${branch}`);
    }
    for (const l of result.left) log(`FAIL  ${l.branch} is not merged: ${l.why}`);
    // Every end-to-end test, on the commit that staging runs now: in the background, and nothing waits for it.
    (o.full ?? ((s: string) => startFullRun(clone, s)))(sha);
    log(
      `NOTE  The whole test suite runs on ${sha.slice(0, 12)} in the background. The ops page (bun erga) shows its result at the commit.`
    );
    job.end("ok");
    return result;
  } catch (e) {
    job.end("failed", (e as Error).message);
    throw e;
  } finally {
    if (dir) git("worktree", "remove", "--force", dir);
    free();
  }
}
