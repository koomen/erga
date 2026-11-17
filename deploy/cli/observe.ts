// What `bun erga` reads: git (the checkout's view of GitHub), and each registered instance's GET /api/health. What an
// instance runs comes from its platform (running.ts). Each call says what it saw; nothing here decides (flow.ts).

import { type Config, type Entry, remoteOf, repoName } from "./config";
import { type Commit, type Instance, PROTECTED, type State, stateOf } from "./flow";
import type { Ask } from "./running";
import { git, ROOT, sh } from "../root";

/** fetch, or a test's stand-in for an instance. */
export type Site = (url: string, init?: RequestInit) => Promise<Response>;

/** The GitHub repository of `origin` (owner/name), or null. */
export const repoOf = (): string | null => {
  const url = git("remote", "get-url", "origin").out;
  const m = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(url);
  return m ? m[1] : null;
};

const FETCH = ["fetch", "--quiet", "--prune", "--tags", "--force", "origin"];

/**
 * Brings the checkout's view of GitHub up to date: branches (deleted ones too) and tags. Another fetch at the same
 * moment (the ops page's, each 30 seconds, or another worktree's) can hold a ref's lock: it tries once more.
 */
export const fetchOrigin = () => {
  const r = git(...FETCH);
  if (r.ok || !/\.lock\b/.test(r.err)) return r;
  Bun.sleepSync(1000);
  return git(...FETCH);
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

export const headOf = (ref: string): string | null => {
  const r = git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
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

/**
 * The heads of `branches` on `repo` now (one git ls-remote: a read), for auto-deploy; each head that the clone does
 * not have yet is fetched into it, so that a deploy and the page's checks have the commit. `error`: why the repository
 * gave no answer, or null.
 */
export async function repoHeads(
  cwd: string,
  repo: string,
  branches: string[]
): Promise<{ heads: Record<string, string>; error: string | null }> {
  const remote = remoteOf(cwd, repo);
  const r = await gitAsync(cwd, ["ls-remote", remote, ...branches.map((b) => `refs/heads/${b}`)]);
  if (!r.ok) return { heads: {}, error: r.err.split("\n").find((l) => /^(fatal|error):/i.test(l)) ?? (r.err || "git ls-remote failed") };
  const heads = Object.fromEntries(
    r.out.split("\n").flatMap((l) => {
      const m = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/.exec(l);
      return m ? [[m[2], m[1]]] : [];
    })
  );
  for (const [branch, sha] of Object.entries(heads))
    if (!sh(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd }).ok) await gitAsync(cwd, ["fetch", "--quiet", remote, branch]);
  return { heads, error: null };
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

/** The feature branches on GitHub: each with its place against `base` (staging), and every field of a branch. */
export function branchesOf(live: Set<string> | null, cwd = ROOT, base = "origin/staging") {
  return rememberedBranches(cwd, live).map((b) => {
    const [behind, ahead] = sh(["git", "rev-list", "--left-right", "--count", `${base}...origin/${b.name}`], { cwd })
      .out.split(/\s+/)
      .map(Number);
    const m = ahead ? mergeTree(base, `origin/${b.name}`, cwd) : { tree: null, conflicts: [] };
    return { ...b, ahead: ahead || 0, behind: behind || 0, ...m };
  });
}

/** The release tags, each with its commit. */
export const tagsOf = () =>
  git("tag", "-l", "v*", "--format=%(refname:short)%1f%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)")
    .out.split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, sha] = l.split("\x1f");
      return { name, sha };
    });

/** Whether the instance at `origin` answers GET /api/health with ok, in 8 seconds. Null: no answer. */
export const healthOf = (origin: string, site: Site): Promise<boolean | null> =>
  site(`${origin}/api/health`, { signal: AbortSignal.timeout(8000), headers: { "Cache-Control": "no-cache" } }).then(
    async (r) => r.status == 200 && ((await r.json().catch(() => null)) as { ok?: unknown } | null)?.ok === true,
    () => null
  );

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
      };
    })
  );

/** Everything `bun erga status` shows. It only reads: no fetch; GitHub's branch list leaves out the ones it deleted. */
export async function readState(config: Config, ask: Ask): Promise<State> {
  const live = await githubHeads();
  return stateOf({
    github: live != null,
    heads: { main: headOf("origin/main"), staging: headOf("origin/staging") },
    instances: await instancesOf(config, ask),
    branches: branchesOf(live),
    waiting: commitsOf("origin/main..origin/staging"),
    log: commitsOf("-n", "20", "origin/main"),
    tags: tagsOf(),
  });
}
