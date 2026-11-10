// A task's work folder: a git worktree of the main clone, at worktrees/<branch>, on a feature branch of that name.
// `bun erga start <branch>` makes one from GitHub's newest staging, with its packages installed. `bun erga clean` lists
// the folders and the local branches whose task is merged and on production, by the merge records (.erga/jobs/), and
// removes them after a yes. cleanPlan decides, with no IO.

import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { PROTECTED } from "./flow";
import { sh } from "./observe";
import { proofDir } from "./proof";

/** Where a task's folder is: worktrees/<branch> in the main clone (git ignores /worktrees/). */
export const folderOf = (clone: string, branch: string) => join(clone, "worktrees", branch);

/** Why `bun erga start <branch>` must not go on, or null. */
export function startRefusal(o: { name: string | undefined; valid: boolean; branchExists: boolean; folderExists: boolean }): string | null {
  if (!o.name) return "Name the branch: bun erga start <branch>.";
  if ((PROTECTED as readonly string[]).includes(o.name)) return `${o.name} is not a feature branch name. Pick another name.`;
  if (!o.valid) return `${o.name} is not a branch name git takes.`;
  if (o.branchExists) return `There is a local branch ${o.name} already. Pick another name, or remove the old one: bun erga clean`;
  if (o.folderExists) return `There is a folder worktrees/${o.name} already. Pick another name.`;
  return null;
}

/**
 * Makes the branch `name` at GitHub's newest staging, in a folder of its own, and installs its packages. The result:
 * the folder. An error says what stopped it. `install` is for the tests.
 */
export function startFolder(o: {
  clone: string;
  name: string | undefined;
  log: (line: string) => void;
  install?: (dir: string) => string | null;
}): string {
  const git = (...args: string[]) => sh(["git", ...args], { cwd: o.clone });
  const name = o.name ?? "";
  const dir = folderOf(o.clone, name);
  const no = startRefusal({
    name: o.name,
    valid: !!name && git("check-ref-format", "--branch", name).ok,
    branchExists: !!name && git("rev-parse", "--verify", "--quiet", `refs/heads/${name}`).ok,
    folderExists: !!name && existsSync(dir),
  });
  if (no) throw new Error(no);
  const f = git("fetch", "--quiet", "origin", "staging");
  if (!f.ok) throw new Error(`git fetch failed: ${f.err}`);
  const head = git("rev-parse", "origin/staging").out;
  const add = git("worktree", "add", "--quiet", "--no-track", "-b", name, dir, "origin/staging");
  if (!add.ok) throw new Error(`git worktree add failed: ${add.err}`);
  o.log(`PASS  ${name} starts at staging's head ${head.slice(0, 12)}, as GitHub has it now.`);
  const install =
    o.install ??
    ((at: string) => {
      const i = sh(["bun", "install", "--frozen-lockfile"], { cwd: at });
      return i.ok ? null : i.err.slice(-600);
    });
  const failed = install(dir);
  if (failed) throw new Error(`bun install --frozen-lockfile failed in ${dir}: ${failed}`);
  o.log(`PASS  Its folder, with its packages: ${dir}`);
  return dir;
}

// ------------------------------------------------------------------ clean

/** A branch that a merge put on staging: the commit it became, and when (a job record's "Merged" line). */
export interface MergedBranch {
  branch: string;
  sha: string;
  at: number;
}

/** The branches that the merges of the job records put on staging (.erga/jobs/*.jsonl: merge.ts writes a "Merged" line for each). */
export function readMerges(dir: string): MergedBranch[] {
  const jobs = join(dir, "jobs");
  if (!existsSync(jobs)) return [];
  return readdirSync(jobs)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => {
      const lines = readFileSync(join(jobs, f), "utf8").split("\n");
      let at = 0;
      try {
        at = Date.parse(String(JSON.parse(lines[0]).started));
      } catch {}
      if (!at) return [];
      return lines.flatMap((l) => {
        const m = /PASS {2}Merged (\S+) as ([0-9a-f]{12}):/.exec(l);
        return m ? [{ branch: m[1], sha: m[2], at }] : [];
      });
    });
}

export interface Folder {
  path: string;
  /** Null: a detached head. */
  branch: string | null;
  /** It has changes that no commit has. */
  dirty: boolean;
  /** The folder the command runs in, or the main clone. */
  inUse: boolean;
  /** A merge's or a test run's scratch folder (the system's temporary folder), with no change for an hour: its job crashed. */
  scratch: boolean;
}

export interface LocalBranch {
  name: string;
  /** Its last commit's time. */
  at: number;
}

export interface CleanPlan {
  remove: { folder?: string; branch?: string; why: string }[];
  /** The merged ones that stay, each with its reason. */
  keep: { what: string; why: string }[];
}

/** What `bun erga clean` removes. `onMain`: production has the commit (origin/main contains it). */
export function cleanPlan(o: {
  folders: Folder[];
  branches: LocalBranch[];
  merges: MergedBranch[];
  onMain: (sha: string) => boolean;
}): CleanPlan {
  const plan: CleanPlan = { remove: [], keep: [] };
  // A branch name can come again: its last merge counts.
  const last = new Map<string, MergedBranch>();
  for (const m of o.merges) if (!last.has(m.branch) || last.get(m.branch)!.at < m.at) last.set(m.branch, m);
  for (const f of o.folders.filter((x) => x.scratch && !x.inUse))
    plan.remove.push({ folder: f.path, why: "a scratch folder that a merge or a test run left" });
  for (const b of o.branches) {
    const m = last.get(b.name);
    if (!m) continue;
    const folder = o.folders.find((f) => f.branch == b.name && !f.scratch);
    const what = folder ? `${folder.path} (${b.name})` : `the branch ${b.name}`;
    const merged = `merged as ${m.sha.slice(0, 12)}`;
    if (b.at > m.at) plan.keep.push({ what, why: `${merged}, but it has a commit from after that merge` });
    else if (folder?.dirty) plan.keep.push({ what, why: `${merged}, but the folder has changes that no commit has` });
    else if (folder?.inUse) plan.keep.push({ what, why: `${merged}, but this command runs in it` });
    else if (!o.onMain(m.sha)) plan.keep.push({ what, why: `${merged}, not on production yet: its agent stays until then` });
    else plan.remove.push({ ...(folder ? { folder: folder.path } : {}), branch: b.name, why: `${merged}, on production` });
  }
  return plan;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The clone's work folders (git worktree list), without the main clone itself. `cwd`: where the command runs. */
export function foldersOf(clone: string, cwd: string, now = Date.now()): Folder[] {
  const git = (at: string, ...args: string[]) => sh(["git", ...args], { cwd: at });
  const tmp = real(tmpdir());
  const here = real(cwd);
  return git(clone, "worktree", "list", "--porcelain")
    .out.split("\n\n")
    .map((block) => ({
      path: /^worktree (.+)$/m.exec(block)?.[1] ?? "",
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null,
    }))
    .filter((w) => w.path && existsSync(w.path) && real(w.path) != real(clone))
    .map((w) => {
      const path = real(w.path);
      const old = now - statSync(path).mtimeMs > 3_600_000;
      return {
        ...w,
        dirty: git(w.path, "status", "--porcelain").out != "",
        inUse: here == path || here.startsWith(path + sep),
        scratch: w.branch == null && path.startsWith(tmp + sep) && /^erga-(merge|tests|full)-/.test(basename(path)) && old,
      };
    });
}

/** `bun erga clean`: lists what the plan removes and what stays, asks, and removes. The result: how many it removed. */
export function cleanFolders(o: {
  dir: string;
  clone: string;
  cwd: string;
  log: (line: string) => void;
  ask?: (q: string) => boolean;
}): number {
  const git = (...args: string[]) => sh(["git", ...args], { cwd: o.clone });
  git("fetch", "--quiet", "origin", "main");
  git("worktree", "prune");
  const branches = git("for-each-ref", "refs/heads", "--format=%(refname:short)%1f%(committerdate:unix)")
    .out.split("\n")
    .filter(Boolean)
    .map((l) => l.split("\x1f"))
    .map(([name, at]) => ({ name, at: Number(at) * 1000 }))
    .filter((b) => !(PROTECTED as readonly string[]).includes(b.name));
  const plan = cleanPlan({
    folders: foldersOf(o.clone, o.cwd),
    branches,
    merges: readMerges(o.dir),
    onMain: (sha) => git("merge-base", "--is-ancestor", sha, "origin/main").ok,
  });
  for (const k of plan.keep) o.log(`KEEP  ${k.what}: ${k.why}.`);
  if (!plan.remove.length) {
    o.log("NOTE  Nothing to remove: no folder or branch is merged and on production.");
    return 0;
  }
  o.log("Remove:");
  for (const r of plan.remove) o.log(`- ${[r.folder, r.branch && `the branch ${r.branch}`].filter(Boolean).join(", ")}: ${r.why}`);
  if (o.ask && !o.ask(`Remove these ${plan.remove.length}? (yes/no) `)) {
    o.log("NOTE  Nothing is removed.");
    return 0;
  }
  let n = 0;
  for (const r of plan.remove) {
    // Without --force, git refuses a folder with a change that came after the list.
    const f = r.folder ? git("worktree", "remove", ...(r.branch ? [] : ["--force"]), r.folder) : null;
    if (f && !f.ok) {
      o.log(`FAIL  ${r.folder} stays: ${f.err}`);
      continue;
    }
    const b = r.branch ? git("branch", "-D", r.branch) : null;
    if (r.branch) rmSync(proofDir(o.dir, r.branch), { recursive: true, force: true });
    if (b && !b.ok) o.log(`FAIL  The branch ${r.branch} stays: ${b.err}`);
    else n++;
  }
  o.log(`PASS  Removed ${n} of ${plan.remove.length}.`);
  return n;
}
