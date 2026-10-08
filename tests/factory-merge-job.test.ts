// The factory's merge job (factory/vm/merge.ts): a merge squashes the task's
// branch into one commit on staging (one parent, the branch's files, the
// task's title and summary as its message, whoever pressed Merge as its
// author), and deletes the branch. Run again after it ended (the factory
// restarted before it heard the answer, and Merge was pressed again): the
// branch is gone; when staging has its commit (or, from before squash
// merges, its "Merge <branch>:" commit), the job answers success with that
// commit, and it never wakes Claude Code. Against a bare repository in a
// temporary folder, with a factory API that answers 404 (the job needs
// nothing from it here).

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

/** A repository whose staging moved on after task/9-x was made from it, with the branch still there (two commits of its own), as Merge finds it. */
function unmerged(): { url: string; base: string } {
  const url = join(dir, `repo-${crypto.randomUUID().slice(0, 6)}.git`);
  sh(["git", "init", "--quiet", "--bare", url], dir);
  const work = mkdtempSync(join(dir, "work-"));
  sh(["git", "init", "--quiet", "-b", "staging"], work);
  writeFileSync(join(work, "a.txt"), "a\n");
  sh(["git", "add", "-A"], work);
  sh(["git", "commit", "--quiet", "-m", "base"], work);
  sh(["git", "checkout", "--quiet", "-b", "task/9-x"], work);
  for (const n of ["b", "c"]) { writeFileSync(join(work, `${n}.txt`), `${n}\n`); sh(["git", "add", "-A"], work); sh(["git", "commit", "--quiet", "-m", `Task work ${n}`], work); }
  sh(["git", "checkout", "--quiet", "staging"], work);
  writeFileSync(join(work, "s.txt"), "staging moved on\n");
  sh(["git", "add", "-A"], work);
  sh(["git", "commit", "--quiet", "-m", "Another task"], work);
  sh(["git", "push", "--quiet", url, "staging", "task/9-x"], work);
  return { url, base: sh(["git", "rev-parse", "staging"], work) };
}

/** The job, run without blocking: the stub API answers from this process, so a spawnSync would deadlock with it. */
async function runMerge(url: string, branch: string, opts: { work?: string; env?: Record<string, string> } = {}): Promise<Record<string, unknown>> {
  const work = opts.work ?? mkdtempSync(join(dir, "vm-"));
  const p = Bun.spawn(["bun", MERGE, "merge", branch, "X"], {
    cwd: work, stdout: "pipe", stderr: "pipe",
    env: { ...env, FACTORY_WORK: work, FACTORY_API: `http://127.0.0.1:${api.port}/api/factory`, FACTORY_TASK: "9", FACTORY_TOKEN: "fct.test", REPO_URL: url, ...opts.env },
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("FACTORY-RESULT "));
  if (!line) throw new Error(`no result: ${stdout}\n${stderr}`);
  return JSON.parse(line.slice("FACTORY-RESULT ".length));
}

test("a merge that ended before squash merges: the branch is gone, staging has its \"Merge <branch>:\" commit, so it succeeds with that commit", async () => {
  const { url, merge } = repo();
  expect(await runMerge(url, "task/9-x")).toEqual({ ok: true, commit: merge, already: true });
}, 40_000);

test("a branch that is gone with no merge in staging: a plain failure (back to ready to merge), not a wake-up of Claude Code", async () => {
  const { url } = repo();
  const r = await runMerge(url, "task/10-y");
  expect(r.ok).toBe(false);
  expect(r.needsAgent).toBeUndefined();
  expect(String(r.error)).toContain("task/10-y isn't in the repository any more, and staging has no merge of it");
}, 40_000);

test("a merge squashes the branch into one commit on staging: one parent, the branch's files, the title and summary, the merger as author; the branch is deleted", async () => {
  const { url, base } = unmerged();
  const job = { FACTORY_MERGE_BODY: "This task adds b and c.\n\nTests: all pass.", FACTORY_MERGE_AUTHOR_NAME: "Grace", FACTORY_MERGE_AUTHOR_EMAIL: "grace@example.com" };
  const work = mkdtempSync(join(dir, "vm-"));
  const r = await runMerge(url, "task/9-x", { work, env: job });
  expect(r.ok).toBe(true);
  const commit = String(r.commit);
  const show = (format: string) => sh(["git", "--git-dir", url, "show", "-s", `--format=${format}`, commit], dir);
  expect(sh(["git", "--git-dir", url, "rev-parse", "staging"], dir)).toBe(commit);
  expect(show("%P")).toBe(base);
  expect(show("%B")).toBe("X\n\nThis task adds b and c.\n\nTests: all pass.");
  expect(show("%an <%ae>")).toBe("Grace <grace@example.com>");
  expect(sh(["git", "--git-dir", url, "ls-tree", "--name-only", commit], dir).split("\n")).toEqual(["a.txt", "b.txt", "c.txt", "s.txt"]);
  // Nothing of the branch reaches staging but its files: not its commits, not its merge of staging.
  expect(sh(["git", "--git-dir", url, "log", "--format=%s", "staging"], dir).split("\n")).toEqual(["X", "Another task", "base"]);
  expect(sh(["git", "--git-dir", url, "branch", "--list", "task/*"], dir)).toBe("");
  // Run again in the same VM (it wrote the commit down), or in a fresh one (staging has a commit with its message): the same commit.
  expect(await runMerge(url, "task/9-x", { work, env: job })).toEqual({ ok: true, commit, already: true });
  expect(await runMerge(url, "task/9-x", { env: job })).toEqual({ ok: true, commit, already: true });
  // Another task with the same title but another summary is not this one.
  expect((await runMerge(url, "task/9-x", { env: { ...job, FACTORY_MERGE_BODY: "Something else." } })).ok).toBe(false);
}, 60_000);
