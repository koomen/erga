// What `bun erga` reads: git (the checkout's view of GitHub, after a fetch), GitHub through the gh CLI, and each
// server's GET /api/deploys/version and GET /api/health. Each call says what it saw; nothing here decides (flow.ts).

import { TARGETS } from "../targets";
import { type Branch, type Commit, PROTECTED, type Run, type Server, type State, stateOf } from "./flow";

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

/** The repository's variables (and an environment's, with `env`), or {} when gh can't read them. */
export function variablesOf(repo: string, env?: string): Record<string, string> {
  const list = ghJson<{ name: string; value: string }[]>(
    "variable",
    "list",
    "-R",
    repo,
    ...(env ? ["--env", env] : []),
    "--json",
    "name,value"
  );
  return Object.fromEntries((list ?? []).map((v) => [v.name, v.value]));
}

/**
 * The servers the workflow deploys: a fork's from its variables (ERGA_HOST, ERGA_STAGING), else Erga's own
 * (deploy/targets.json); and each GitHub environment with its own ERGA_HOST (deployed from main after production).
 */
export function serversOf(repo: string): Omit<Server, "version" | "healthy">[] {
  const vars = variablesOf(repo);
  const out: Omit<Server, "version" | "healthy">[] = vars.ERGA_HOST
    ? [
        { name: "production", host: vars.ERGA_HOST, branch: "main" },
        ...(vars.ERGA_STAGING ? [{ name: "staging", host: vars.ERGA_STAGING, branch: "staging" }] : []),
      ]
    : Object.values(TARGETS).map((t) => ({ name: t.name, host: t.host, branch: t.branch }));
  const envs = ghJson<{ environments?: { name: string }[] }>("api", `repos/${repo}/environments`)?.environments ?? [];
  for (const e of envs) {
    const host = variablesOf(repo, e.name).ERGA_HOST;
    if (host && !out.some((s) => s.host == host)) out.push({ name: e.name, host, branch: "main" });
  }
  return out;
}

/** What a server answers now: its release and its health. */
export async function answerOf(host: string): Promise<{ version: string | null; healthy: boolean | null }> {
  const get = async (path: string) => {
    const r = await fetch(`https://${host}${path}`, { signal: AbortSignal.timeout(8000), headers: { "Cache-Control": "no-cache" } }).catch(
      () => null
    );
    return r ? { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null } : null;
  };
  const [v, h] = await Promise.all([get("/api/deploys/version"), get("/api/health")]);
  return {
    version: typeof v?.body?.version == "string" ? (v.body.version as string) : null,
    healthy: h ? h.status == 200 && h.body?.ok === true : null,
  };
}

interface GhRun {
  databaseId: number;
  headSha: string;
  headBranch: string;
  status: string;
  conclusion: string;
  url: string;
  createdAt: string;
  event: string;
}
const runOf = (r: GhRun): Run => ({
  sha: r.headSha,
  branch: r.headBranch,
  status: r.status,
  conclusion: r.conclusion,
  url: r.url,
  at: Date.parse(r.createdAt),
});

/** The workflow's recent runs of pushes (all branches), newest first. */
export const runsOf = (repo: string, o: { branch?: string; commit?: string; limit?: number } = {}): (Run & { id: number })[] =>
  (
    ghJson<GhRun[]>(
      "run",
      "list",
      "-R",
      repo,
      "--workflow",
      "test.yml",
      "--event",
      "push",
      "-L",
      String(o.limit ?? 40),
      ...(o.branch ? ["--branch", o.branch] : []),
      ...(o.commit ? ["--commit", o.commit] : []),
      "--json",
      "databaseId,headSha,headBranch,status,conclusion,url,createdAt,event"
    ) ?? []
  ).map((r) => ({ ...runOf(r), id: r.databaseId }));

/** A run's jobs. */
export const jobsOf = (repo: string, id: number): NonNullable<Run["jobs"]> =>
  ghJson<{ jobs: { name: string; status: string; conclusion: string; url: string }[] }>(
    "run",
    "view",
    String(id),
    "-R",
    repo,
    "--json",
    "jobs"
  )?.jobs ?? [];

/** Everything the dashboard and `bun erga status` show. */
export async function readState(o: { checkConflicts?: boolean } = {}): Promise<State> {
  const repo = repoOf();
  if (!repo) throw new Error("This checkout's origin is not a GitHub repository.");
  fetchOrigin();
  const servers = await Promise.all(serversOf(repo).map(async (s) => ({ ...s, ...(await answerOf(s.host)) })));
  const runs = runsOf(repo);
  // The deploy jobs of each server's latest run: the dashboard links their logs.
  const latest = new Map<string, Run & { id: number }>();
  for (const r of runs) if (!latest.has(r.branch)) latest.set(r.branch, r);
  for (const r of latest.values()) if (r.branch == "main" || r.branch == "staging") r.jobs = jobsOf(repo, r.id);
  return stateOf({
    repo,
    at: Date.now(),
    heads: { main: headOf("origin/main"), staging: headOf("origin/staging") },
    servers,
    runs,
    branches: branchesOf(o.checkConflicts ?? true),
    waiting: commitsOf("origin/main..origin/staging"),
    log: commitsOf("-n", "20", "origin/main"),
    tags: tagsOf(),
  });
}
