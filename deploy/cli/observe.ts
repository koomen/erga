// What `bun erga` reads: git (the checkout's view of GitHub), and each registered instance's GET /api/ops (with its ops
// token) and GET /api/health. Each call says what it saw; nothing here decides (flow.ts).

import { type Config, originOf } from "./config";
import { healthOf } from "./deploy";
import { type Branch, type Commit, type Instance, PROTECTED, type State, stateOf } from "./flow";
import { readOps } from "./ops";

export const ROOT = new URL("../..", import.meta.url).pathname;

/** A command's result: its exit, and what it printed. */
export function sh(cmd: string[], o: { cwd?: string; input?: string; env?: Record<string, string> } = {}) {
  const r = Bun.spawnSync(cmd, {
    cwd: o.cwd ?? ROOT,
    stdin: o.input != null ? new TextEncoder().encode(o.input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...o.env },
  });
  return { ok: r.exitCode == 0, code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
export const git = (...args: string[]) => sh(["git", ...args]);
/** gh's JSON answer, or null. */
export function ghJson<T>(...args: string[]): T | null {
  const r = sh(["gh", ...args]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out) as T;
  } catch {
    return null;
  }
}

/** The GitHub repository of `origin` (owner/name), or null. */
export const repoOf = (): string | null => {
  const url = git("remote", "get-url", "origin").out;
  const m = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(url);
  return m ? m[1] : null;
};

/** Brings the checkout's view of GitHub up to date: branches (deleted ones too) and tags. */
export const fetchOrigin = () => git("fetch", "--quiet", "--prune", "--tags", "--force", "origin");

export const headOf = (ref: string): string | null => {
  const r = git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  return r.ok ? r.out : null;
};

/** Commits of a range (`git log` arguments), newest first. */
export function commitsOf(...range: string[]): Commit[] {
  const r = git("log", "--format=%H%x1f%s%x1f%ct%x1f%an%x1f%b%x1e", ...range);
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

/** The files where `branch` conflicts with `onto` (git merge-tree: nothing is written to the checkout). */
export function conflictsOf(onto: string, branch: string): string[] {
  const r = git("merge-tree", "--write-tree", "--name-only", "--no-messages", onto, branch);
  if (r.code == 0) return [];
  // Exit 1: conflicts. The first line is the tree; the conflicted files follow.
  const files = r.out.split("\n").slice(1).filter(Boolean);
  return files.length ? [...new Set(files)] : [`(git merge-tree failed: ${r.err || r.code})`];
}

/** The feature branches on GitHub: each with its place against staging. */
export function branchesOf(check = true): Branch[] {
  const r = git(
    "for-each-ref",
    "refs/remotes/origin",
    "--format=%(refname:short)%1f%(objectname)%1f%(committerdate:unix)%1f%(subject)%1f%(authorname)"
  );
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\x1f"))
    .map(([ref, sha, at, subject, author]) => ({ name: ref.replace(/^origin\//, ""), sha, at: Number(at) * 1000, subject, author }))
    .filter((b) => b.name != "HEAD" && b.name != "origin" && !(PROTECTED as readonly string[]).includes(b.name))
    .map((b) => {
      const [behind, ahead] = git("rev-list", "--left-right", "--count", `origin/staging...origin/${b.name}`).out.split(/\s+/).map(Number);
      return {
        ...b,
        ahead: ahead || 0,
        behind: behind || 0,
        conflicts: check && ahead ? conflictsOf("origin/staging", `origin/${b.name}`) : check ? [] : null,
      };
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

/** What each registered instance answers now: the commit it runs (its ops token) and its health. */
export function instancesOf(config: Config, site: typeof fetch = fetch): Promise<Instance[]> {
  const get = (url: string | URL | Request, init?: RequestInit) => site(url, { ...init, signal: AbortSignal.timeout(8000) });
  return Promise.all(
    config.instances.map(async (e) => {
      const origin = originOf(e.host);
      const [ops, healthy] = await Promise.all([
        readOps(origin, e.token, get).then(
          (f) => ({ version: f.version }),
          (err: Error) => ({
            version: null,
            error: /refused/.test(err.message) ? `refuses its ops token: bun erga login ${e.host}` : "no answer",
          })
        ),
        healthOf(origin, get).catch(() => null),
      ]);
      return { host: e.host, ...(e.stagingOf ? { stagingOf: e.stagingOf } : {}), ...ops, healthy };
    })
  );
}

/** Everything `bun erga status` shows. It only reads: no fetch, so the branches are as this clone last saw them. */
export async function readState(config: Config, site?: typeof fetch): Promise<State> {
  return stateOf({
    heads: { main: headOf("origin/main"), staging: headOf("origin/staging") },
    instances: await instancesOf(config, site),
    branches: branchesOf(),
    waiting: commitsOf("origin/main..origin/staging"),
    log: commitsOf("-n", "20", "origin/main"),
    tags: tagsOf(),
  });
}
