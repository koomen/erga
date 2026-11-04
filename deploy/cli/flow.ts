// What `bun erga` decides: when a merge, a promote or a release must stop, the message of a squashed merge, the next
// release's version and notes, a rollback's version, and the dashboard's state. Pure: no network, no git, no files
// (deploy/cli/observe.ts reads GitHub and the servers; deploy/cli/main.ts acts).

/** The branches that deploy. Only `bun erga` moves them. */
export const PROTECTED = ["staging", "main"] as const;

export interface Commit {
  sha: string;
  subject: string;
  /** The message's lines after the subject. */
  body?: string;
  at?: number;
  author?: string;
}

/** A server as GET /api/deploys/version and GET /api/health answer: its release (12 characters) and its health. */
export interface Server {
  name: string;
  host: string;
  /** The branch it deploys from. */
  branch: string;
  version: string | null;
  healthy: boolean | null;
}

/** A workflow run of one commit, as `gh run list` gives it. */
export interface Run {
  sha: string;
  branch: string;
  status: string;
  conclusion: string;
  url: string;
  at: number;
  /** The deploy jobs' results, when they were read. */
  jobs?: { name: string; status: string; conclusion: string; url: string }[];
}

export interface Branch {
  name: string;
  sha: string;
  ahead: number;
  behind: number;
  /** Null: not checked. */
  conflicts: string[] | null;
  at: number;
  subject: string;
  author?: string;
}

/** Why `bun erga merge <branch>` must not go on, or null. */
export function mergeRefusal(o: { branch: string; exists: boolean; ahead: number; conflicts: string[] }): string | null {
  if (!o.branch) return "Name the branch: bun erga merge <branch>.";
  if ((PROTECTED as readonly string[]).includes(o.branch))
    return `${o.branch} is not a feature branch. To move main to staging's head, use: bun erga promote.`;
  if (!o.exists) return `There is no branch ${o.branch} on GitHub. Push it first: git push origin HEAD:${o.branch}`;
  if (o.ahead == 0) return `${o.branch} has no commits that staging does not have. Nothing to merge.`;
  if (o.conflicts.length)
    return `${o.branch} conflicts with staging in ${o.conflicts.join(", ")}. Rebase it on origin/staging, fix the conflicts, push it, and merge again.`;
  return null;
}

/** The message of the one commit a merge puts on staging: `-m`, else the branch's one commit's, else a list of them. */
export function squashMessage(branch: string, commits: Commit[], given?: string): string {
  const trailers = new Set<string>();
  const strip = (body = "") =>
    body
      .split("\n")
      .filter((l) => {
        if (/^Co-Authored-By:/i.test(l.trim())) {
          trailers.add(l.trim());
          return false;
        }
        return true;
      })
      .join("\n")
      .trim();
  let text: string;
  if (given?.trim()) {
    for (const c of commits) strip(c.body);
    text = given.trim();
  } else if (commits.length == 1) {
    const body = strip(commits[0].body);
    text = body ? `${commits[0].subject}\n\n${body}` : commits[0].subject;
  } else {
    // Oldest first, as they were made.
    for (const c of commits) strip(c.body);
    text = `Merge ${branch}: ${commits.at(-1)?.subject ?? ""}\n\n${[...commits]
      .reverse()
      .map((c) => `- ${c.subject}`)
      .join("\n")}`;
  }
  return trailers.size ? `${text}\n\n${[...trailers].join("\n")}` : text;
}

/** Why `bun erga promote` must not go on, or null: main moves only to a staging head that deployed and is healthy. */
export function promoteRefusal(o: {
  staging: string;
  main: string;
  /** main is an ancestor of staging (a fast-forward). */
  fastForward: boolean;
  run: Run | null;
  server: Server | null;
}): string | null {
  if (o.staging == o.main) return "main is at staging's head already. Nothing to promote.";
  if (!o.fastForward)
    return "main has commits that staging does not have: main can only move forward to staging. Put those commits on staging first (bun erga merge).";
  const short = o.staging.slice(0, 12);
  if (!o.run) return `GitHub has no workflow run for staging's head ${short} yet. Wait for it: bun erga status.`;
  if (o.run.status != "completed") return `Staging's run for ${short} is ${o.run.status}. Wait for it to end: ${o.run.url}`;
  if (o.run.conclusion != "success") return `Staging's run for ${short} ended with ${o.run.conclusion}: ${o.run.url}. Fix staging first.`;
  if (!o.server) return "There is no staging server to check. Promote needs a staging server that runs staging's head.";
  if (o.server.version != short)
    return `${o.server.host} runs ${o.server.version ?? "nothing that answers"}, not staging's head ${short}. Wait for the deploy, or look at its run: ${o.run.url}`;
  if (!o.server.healthy) return `${o.server.host} is not healthy: GET /api/health did not answer ok. Fix staging first.`;
  return null;
}

const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The newest release tag (vX.Y.Z) of `tags`, or null. */
export function latestTag(tags: string[]): string | null {
  const parsed = tags
    .filter((t) => SEMVER.test(t))
    .map((t) => [t, ...SEMVER.exec(t)!.slice(1).map(Number)] as [string, number, number, number]);
  parsed.sort((a, b) => b[1] - a[1] || b[2] - a[2] || b[3] - a[3]);
  return parsed[0]?.[0] ?? null;
}

/** The next release's version: `asked` (vX.Y.Z, or major, minor, patch: the default), after `last`. */
export function nextVersion(last: string | null, asked = "patch"): { version: string } | { problem: string } {
  const [maj, min, pat] = last ? SEMVER.exec(last)!.slice(1).map(Number) : [0, 0, 0];
  if (asked == "major") return { version: `v${maj + 1}.0.0` };
  if (asked == "minor") return { version: `v${maj}.${min + 1}.0` };
  if (asked == "patch") return { version: last ? `v${maj}.${min}.${pat + 1}` : "v0.1.0" };
  const m = SEMVER.exec(asked);
  if (!m) return { problem: `${asked} is not a version: use vX.Y.Z, or major, minor or patch.` };
  const [a, b, c] = m.slice(1).map(Number);
  if (last && (a < maj || (a == maj && (b < min || (b == min && c <= pat)))))
    return { problem: `${asked} is not after the last release, ${last}.` };
  return { version: asked };
}

/** Why `bun erga release` must not go on, or null. */
export function releaseRefusal(o: { mainTagged: string | null; commits: number }): string | null {
  if (o.mainTagged) return `main's head is the release ${o.mainTagged} already.`;
  if (o.commits == 0) return "main has no commits since the last release.";
  return null;
}

/** A release's notes: main's commits since the last release, newest first. */
export function releaseNotes(last: string | null, commits: Commit[]): string {
  const lines = commits.map((c) => `- ${c.subject} (${c.sha.slice(0, 7)})`);
  return `${last ? `Changes since ${last}:` : "Changes:"}\n\n${lines.join("\n")}\n`;
}

/** A Worker's deployments, newest first, as Cloudflare lists them: the version each sent most traffic to. */
export function previousVersion(
  deployments: { versions: { version_id: string; percentage: number }[] }[]
): { now: string; before: string } | null {
  const top = deployments
    .map((d) => [...d.versions].sort((a, b) => b.percentage - a.percentage)[0]?.version_id)
    .filter(Boolean) as string[];
  const now = top[0];
  const before = top.find((v) => v != now);
  return now && before ? { now, before } : null;
}

/** The dashboard's and `bun erga status`'s picture of the repository and its servers. */
export interface State {
  repo: string;
  at: number;
  heads: { main: string | null; staging: string | null };
  servers: (Server & { run: Run | null; current: boolean })[];
  branches: Branch[];
  /** Commits on staging that main does not have (they go out at the next promote). */
  waiting: Commit[];
  /** main's recent commits, and the release tag of each that has one. */
  log: (Commit & { tag?: string })[];
  latestRelease: string | null;
}

/** The state from what was read: each server with its branch's last run, and whether it runs its branch's head. */
export function stateOf(o: {
  repo: string;
  at: number;
  heads: State["heads"];
  servers: Server[];
  runs: Run[];
  branches: Branch[];
  waiting: Commit[];
  log: Commit[];
  tags: { name: string; sha: string }[];
}): State {
  const tagOf = new Map(o.tags.map((t) => [t.sha, t.name]));
  return {
    repo: o.repo,
    at: o.at,
    heads: o.heads,
    servers: o.servers.map((s) => {
      const head = s.branch == "main" ? o.heads.main : o.heads.staging;
      const run = o.runs.filter((r) => r.branch == s.branch).sort((a, b) => b.at - a.at)[0] ?? null;
      return { ...s, run, current: !!head && s.version == head.slice(0, 12) };
    }),
    branches: [...o.branches].sort((a, b) => b.at - a.at),
    waiting: o.waiting,
    log: o.log.map((c) => (tagOf.has(c.sha) ? { ...c, tag: tagOf.get(c.sha)! } : c)),
    latestRelease: latestTag(o.tags.map((t) => t.name)),
  };
}

/** `bun erga status` as text. */
export function statusText(s: State): string {
  const out: string[] = [`${s.repo}: main ${s.heads.main?.slice(0, 12) ?? "?"}, staging ${s.heads.staging?.slice(0, 12) ?? "?"}`, ""];
  out.push("Servers:");
  for (const v of s.servers) {
    const run = v.run ? `last run ${v.run.conclusion || v.run.status} (${v.run.url})` : "no run";
    out.push(
      `- ${v.name} https://${v.host}: ${v.version ?? "no answer"}${v.current ? " (its branch's head)" : ` (not ${v.branch}'s head)`}, health ${v.healthy == null ? "unknown" : v.healthy ? "ok" : "FAIL"}; ${run}`
    );
  }
  out.push("", "Feature branches:");
  if (!s.branches.length) out.push("- none");
  for (const b of s.branches)
    out.push(
      `- ${b.name}: ${b.ahead} ahead, ${b.behind} behind staging; ${b.ahead == 0 ? "nothing to merge" : b.conflicts == null ? "not checked" : b.conflicts.length ? `conflicts in ${b.conflicts.join(", ")}` : "merges cleanly"}. ${b.subject}`
    );
  out.push("", `On staging, not on main (${s.waiting.length}):`);
  if (!s.waiting.length) out.push("- none");
  for (const c of s.waiting) out.push(`- ${c.sha.slice(0, 7)} ${c.subject}`);
  out.push("", `main (latest release ${s.latestRelease ?? "none"}):`);
  for (const c of s.log.slice(0, 10)) out.push(`- ${c.sha.slice(0, 7)} ${c.tag ? `[${c.tag}] ` : ""}${c.subject}`);
  return out.join("\n");
}

/** Why a push to `ref` must stop (the pre-push hook), or null. `cli`: `bun erga` makes it. */
export function pushRefusal(ref: string, cli: boolean): string | null {
  const name = ref.replace(/^refs\/heads\//, "");
  if (cli || !(PROTECTED as readonly string[]).includes(name)) return null;
  return name == "staging"
    ? "Don't push to staging directly. Push your branch (git push origin HEAD:<branch>), then: bun erga merge <branch>. bun erga skill tells the rest."
    : "Don't push to main directly. Pete moves main: bun erga promote. bun erga skill tells the rest.";
}
