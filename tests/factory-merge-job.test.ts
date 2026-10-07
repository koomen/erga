// The factory's merge job (factory/vm/merge.ts), run again after it ended:
// the factory restarted before it heard the answer, and Merge was pressed
// again. The branch is gone; when staging has its "Merge <branch>:" commit,
// the job answers success with that commit, and it never wakes Claude Code.
// Against a bare repository in a temporary folder, with a factory API that
// answers 404 (the job needs nothing from it here).

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MERGE = join(import.meta.dir, "..", "factory", "vm", "merge.ts");
const dir = mkdtempSync(join(tmpdir(), "factory-merge-job-"));
const api = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status: 404 }) });
afterAll(() => { api.stop(true); rmSync(dir, { recursive: true, force: true }); });

const ident = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", ...ident };
const sh = (args: string[], cwd: string) => {
  const r = spawnSync(args[0], args.slice(1), { cwd, env, encoding: "utf8" });
  if (r.status != 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repository whose staging has task/9-x merged ("Merge task/9-x: X") and the branch deleted, as merge.ts leaves it. */
function repo(): { url: string; merge: string } {
  const url = join(dir, `repo-${crypto.randomUUID().slice(0, 6)}.git`);
  sh(["git", "init", "--quiet", "--bare", url], dir);
  const work = mkdtempSync(join(dir, "work-"));
  sh(["git", "init", "--quiet", "-b", "staging"], work);
  writeFileSync(join(work, "a.txt"), "a\n");
  sh(["git", "add", "-A"], work);
  sh(["git", "commit", "--quiet", "-m", "base"], work);
  sh(["git", "checkout", "--quiet", "-b", "task/9-x"], work);
  writeFileSync(join(work, "b.txt"), "b\n");
  sh(["git", "add", "-A"], work);
  sh(["git", "commit", "--quiet", "-m", "Factory task #9"], work);
  sh(["git", "checkout", "--quiet", "staging"], work);
  sh(["git", "merge", "--quiet", "--no-ff", "-m", "Merge task/9-x: X", "task/9-x"], work);
  sh(["git", "push", "--quiet", url, "staging"], work);
  return { url, merge: sh(["git", "rev-parse", "HEAD"], work) };
}

function runMerge(url: string, branch: string): Record<string, unknown> {
  const work = mkdtempSync(join(dir, "vm-"));
  const r = spawnSync("bun", [MERGE, "merge", branch, "X"], {
    cwd: work, encoding: "utf8", timeout: 60_000,
    env: { ...env, FACTORY_WORK: work, FACTORY_API: `http://127.0.0.1:${api.port}/api/factory`, FACTORY_TASK: "9", FACTORY_TOKEN: "fct.test", REPO_URL: url },
  });
  const line = r.stdout.split("\n").reverse().find((l) => l.startsWith("FACTORY-RESULT "));
  if (!line) throw new Error(`no result: ${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice("FACTORY-RESULT ".length));
}

test("a merge that ended before: the branch is gone, staging has its merge, so it succeeds with that commit", () => {
  const { url, merge } = repo();
  expect(runMerge(url, "task/9-x")).toEqual({ ok: true, commit: merge, already: true });
}, 60_000);

test("a branch that is gone with no merge in staging: a plain failure (back to ready to merge), not a wake-up of Claude Code", () => {
  const { url } = repo();
  const r = runMerge(url, "task/10-y");
  expect(r.ok).toBe(false);
  expect(r.needsAgent).toBeUndefined();
  expect(String(r.error)).toContain("task/10-y isn't in the repository any more, and staging has no merge of it");
}, 60_000);
