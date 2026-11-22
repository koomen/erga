// What `bun erga` reads of git (the checkout's view of GitHub). What an instance runs, and its health, come from its
// platform (running.ts). Each call says what it saw; nothing here decides (flow.ts).

import { type Config, type Entry, remoteOf, repoName } from "./config";
import { type Commit, type Instance, latestTag, PROTECTED, type State, stateOf } from "./flow";
import type { Ask } from "./running";
import { parseRefs, type ReleaseTag } from "../deployer/tags";
import { git, ROOT, sh } from "../root";

/** The GitHub repository of `origin` (owner/name), or null. */
export const repoOf = (cwd = ROOT): string | null => {
  const url = sh(["git", "remote", "get-url", "origin"], { cwd }).out;
  const m = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(url);
  return m ? m[1] : null;
};

const FETCH = ["fetch", "--quiet", "--prune", "--tags", "--force", "origin"];

/**
 * Brings the checkout's view of GitHub up to date: branches (deleted ones too) and tags. Another fetch at the same
 * moment (the ops page's, each 30 seconds, or another worktree's) can hold a ref's lock: it tries once more.
 */
export const fetchOrigin = (cwd = ROOT) => {
  const r = sh(["git", ...FETCH], { cwd });
  if (r.ok || !/\.lock\b/.test(r.err)) return r;
  Bun.sleepSync(1000);
  return sh(["git", ...FETCH], { cwd });
};

/** fetchOrigin, for the ops page: it does not block, and stops after `timeout` ms. Null when it worked, else why not. */
export async function fetchGitHub(cwd = ROOT, timeout = 30_000): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", ...FETCH], {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const err = (await new Response(p.stderr).text()).trim();
    const code = await p.exited;
    if (code == 0) return null;
    return p.signalCode
      ? `git fetch took more than ${timeout / 1000} s`
      : (err.split("\n").find((l) => /^(fatal|error):/i.test(l)) ?? err) || `git fetch: exit ${code}`;
  } catch (e) {
    // The clone went away (a test's), or git is not there.
    return `git fetch: ${(e as Error).message}`;
  }
}

export const headOf = (ref: string, cwd = ROOT): string | null => {
  const r = sh(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd });
  return r.ok ? r.out : null;
};

/** Commits of a range (`git log` arguments), newest first. */
export const commitsOf = (...range: string[]) => commitsIn(ROOT, ...range);
/** The commits of a range, newest first, in the clone `cwd`: each with every field. */
export function commitsIn(cwd: string, ...range: string[]): Required<Commit>[] {
  const r = sh(["git", "log", "--format=%H%x1f%s%x1f%ct%x1f%an%x1f%b%x1e", ...range], { cwd });
  if (!r.ok || !r.out) return [];
  return r.out
    .split("\x1e")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [sha, subject, at, author, body] = x.split("\x1f");
      return { sha, subject, at: Number(at) * 1000, author, body: body?.trim() ?? "" };
    });
}

/**
 * The merge of `branch` onto `onto` (git merge-tree: nothing is written to the checkout): its tree, which is the tree of
 * the commit that `bun erga merge` then makes (the key of its tests' record, test-run.ts), or the files that conflict.
 */
export function mergeTree(onto: string, branch: string, cwd = ROOT): { tree: string | null; conflicts: string[] } {
  const r = sh(["git", "merge-tree", "--write-tree", "--name-only", "--no-messages", onto, branch], { cwd });
  const [tree, ...rest] = r.out.split("\n");
  if (r.code == 0) return { tree, conflicts: [] };
  // Exit 1: conflicts. The first line is the tree; the conflicted files follow.
  const files = rest.filter(Boolean);
  return { tree: null, conflicts: files.length ? [...new Set(files)] : [`(git merge-tree failed: ${r.err || r.code})`] };
}

/**
 * The branches that GitHub has now (git ls-remote: a read; it changes nothing in the clone), or null when it does not
 * answer. A merge deletes its branch on GitHub, and the clone remembers it until a fetch with --prune.
 */
export async function githubHeads(cwd = ROOT): Promise<Set<string> | null> {
  try {
    const p = Bun.spawn(["git", "ls-remote", "--heads", "origin"], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 10_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) != 0) return null;
    return new Set(out.split("\n").flatMap((l) => /\trefs\/heads\/(.+)$/.exec(l)?.[1] ?? []));
  } catch {
    // The clone went away (a test's), or git is not there.
    return null;
  }
}

/** git, for the ops page: it does not block, and stops after 30 seconds. */
async function gitAsync(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { ok: (await p.exited) == 0, out: out.trim(), err: err.trim() };
  } catch (e) {
    // The clone went away (a test's), or git is not there.
    return { ok: false, out: "", err: (e as Error).message };
  }
}

/** The clone's own ref for a branch of a repository that an instance tracks: it keeps the branch's commits in the clone, and no push sends it. */
export const trackedRef = (repo: string, branch: string) =>
  `refs/erga/${repoName(repo)
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")}/${branch}`;

/**
 * The heads of `branches` and all semver release tags (vX.Y.Z, newest first) on `repo` now (one git ls-remote: a read),
 * for the ops page's commits and for auto-deploy. A head that the clone's own ref (trackedRef) is not at is fetched
 * into that ref, so that the page's log, a deploy and the checks have the commit, and git keeps it.
 */
export async function repoHeads(
  cwd: string,
  repo: string,
  branches: string[]
): Promise<{ heads: Record<string, string>; tags?: ReleaseTag[]; error: string | null }> {
  const remote = remoteOf(cwd, repo);
  const r = await gitAsync(cwd, ["ls-remote", remote, ...branches.map((b) => `refs/heads/${b}`), "refs/tags/v*"]);
  if (!r.ok) return { heads: {}, error: r.err.split("\n").find((l) => /^(fatal|error):/i.test(l)) ?? (r.err || "git ls-remote failed") };
  const heads = Object.fromEntries(
    r.out.split("\n").flatMap((l) => {
      const m = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/.exec(l);
      return m ? [[m[2], m[1]]] : [];
    })
  );
  const { tags } = parseRefs(r.out, branches[0] ?? "main");
  for (const [branch, sha] of Object.entries(heads)) {
    const ref = trackedRef(repo, branch);
    if (sh(["git", "rev-parse", "--verify", "--quiet", ref], { cwd }).out != sha)
      await gitAsync(cwd, ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:${ref}`]);
  }
  return { heads, ...(tags.length ? { tags } : {}), error: null };
}

/** Whether the clone has both commits, and `head` has `commit` in its history. */
export const inHistory = (cwd: string, commit: string, head: string) =>
  sh(["git", "merge-base", "--is-ancestor", commit, head], { cwd }).ok;

/** The origin's branches that the clone remembers, less those that GitHub no longer has (`live`; null: no answer). */
function rememberedBranches(cwd: string, live: Set<string> | null) {
  return sh(
    [
      "git",
      "for-each-ref",
      "refs/remotes/origin",
      "--format=%(refname:short)%1f%(objectname)%1f%(committerdate:unix)%1f%(subject)%1f%(authorname)",
    ],
    { cwd }
  )
    .out.split("\n")
    .filter(Boolean)
    .map((l) => l.split("\x1f"))
    .map(([ref, sha, at, subject, author]) => ({ name: ref.replace(/^origin\//, ""), sha, at: Number(at) * 1000, subject, author }))
    .filter((b) => b.name != "HEAD" && b.name != "origin" && !(PROTECTED as readonly string[]).includes(b.name))
    .filter((b) => !live || live.has(b.name));
}

/** The feature branches on GitHub: each with its place against `base` (main), and every field of a branch. */
export function branchesOf(live: Set<string> | null, cwd = ROOT, base = "origin/main") {
  return rememberedBranches(cwd, live).map((b) => {
    const [behind, ahead] = sh(["git", "rev-list", "--left-right", "--count", `${base}...origin/${b.name}`], { cwd })
      .out.split(/\s+/)
      .map(Number);
    const m = ahead ? mergeTree(base, `origin/${b.name}`, cwd) : { tree: null, conflicts: [] };
    return { ...b, ahead: ahead || 0, behind: behind || 0, ...m };
  });
}

/** The release tags, each with its commit. */
export const tagsOf = (cwd = ROOT) =>
  sh(["git", "tag", "-l", "v*", "--format=%(refname:short)%1f%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)"], {
    cwd,
  })
    .out.split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, sha] = l.split("\x1f");
      return { name, sha };
    });

/**
 * How many commits of the branch that `e` tracks are after `version`, the commit it runs, as the clone last saw the
 * branch (no fetch). Null: the clone can't say: no commit, a repository that is not the clone's origin, a branch or a
 * commit that the clone does not have, or a commit that is not on the branch.
 */
export function behindOf(e: Pick<Entry, "repo" | "branch">, version: string | null, cwd = ROOT): number | null {
  const origin = sh(["git", "remote", "get-url", "origin"], { cwd });
  if (!version || !origin.ok || repoName(origin.out) != repoName(e.repo)) return null;
  const branch = `origin/${e.branch}`;
  if (!sh(["git", "merge-base", "--is-ancestor", version, branch], { cwd }).ok) return null;
  const n = sh(["git", "rev-list", "--count", `${version}..${branch}`], { cwd });
  return n.ok ? Number(n.out) : null;
}

/** A commit of a comparison: what a list shows of it. */
export type Compared = { sha: string; subject: string; at: number; author: string };

/**
 * What `branch` and `upstream` (two commits or refs of the clone) each have that the other lacks, newest first: `ahead`
 * only on the branch, `behind` only on the upstream. `same`: how many commits are on both as the same patch with
 * another id (a cherry-pick): they are on neither list. A merge commit is on no list. Null: the clone does not have both.
 * By git's history: a branch that took its upstream as one squashed commit stays behind by each upstream commit.
 */
export function compare(cwd: string, branch: string, upstream: string): { ahead: Compared[]; behind: Compared[]; same: number } | null {
  const r = sh(
    ["git", "log", "--left-right", "--cherry-mark", "--no-merges", "--format=%m%x1f%H%x1f%s%x1f%ct%x1f%an%x1e", `${branch}...${upstream}`],
    { cwd }
  );
  if (!r.ok) return null;
  const marks = r.out
    .split("\x1e")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [mark, sha, subject, at, author] = x.split("\x1f");
      return { mark, sha, subject, at: Number(at) * 1000, author };
    });
  const side = (mark: string) => marks.filter((c) => c.mark == mark).map(({ mark: _, ...c }) => c);
  // The same patch shows one time on each side.
  return { ahead: side("<"), behind: side(">"), same: Math.ceil(side("=").length / 2) };
}

/** The clone's ref of a branch of a repository: origin's when the repository is the clone's origin, else the clone's own (trackedRef), which the ops page keeps. */
const refOf = (cwd: string, repo: string, branch: string) =>
  remoteOf(cwd, repo) == "origin" ? `origin/${branch}` : trackedRef(repo, branch);

/** An instance's upstream with the two numbers, as the clone last saw both branches (no fetch). */
export function upstreamOf(e: Pick<Entry, "repo" | "branch" | "upstream">, cwd = ROOT): Instance["upstream"] {
  if (!e.upstream) return undefined;
  const c = compare(cwd, refOf(cwd, e.repo, e.branch), refOf(cwd, e.upstream.repo, e.upstream.branch));
  return { ...e.upstream, ahead: c?.ahead.length ?? null, behind: c?.behind.length ?? null };
}

/** What each registered instance runs now, and its health. */
const instancesOf = (config: Config, ask: Ask): Promise<Instance[]> =>
  Promise.all(
    config.instances.map(async (e) => {
      const a = await ask(e);
      return {
        host: e.host,
        repo: e.repo,
        branch: e.branch,
        ...a,
        behind: behindOf(e, a.version),
        ...(e.upstream ? { upstream: upstreamOf(e) } : {}),
      };
    })
  );

/** Everything `bun erga status` shows. It only reads: no fetch; GitHub's branch list leaves out the ones it deleted. */
export async function readState(config: Config, ask: Ask): Promise<State> {
  const live = await githubHeads();
  const tags = tagsOf();
  const last = latestTag(tags.map((t) => t.name));
  return stateOf({
    github: live != null,
    main: headOf("origin/main"),
    instances: await instancesOf(config, ask),
    branches: branchesOf(live),
    waiting: commitsOf(...(last ? [`${last}..origin/main`] : ["-n", "50", "origin/main"])),
    log: commitsOf("-n", "20", "origin/main"),
    tags,
  });
}
