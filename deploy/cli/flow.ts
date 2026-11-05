// What `bun erga` decides: when a merge or a release must stop, the message of a squashed merge, the next
// release's version and notes, a rollback's version, and `bun erga status`'s text. Pure: no network, no git, no files
// (deploy/cli/observe.ts reads git and the instances; deploy/cli/main.ts acts).

/** The branches that `bun erga` moves: staging (merge) and main (a deploy of a primary). */
export const PROTECTED = ["staging", "main"] as const;

export interface Commit {
  sha: string;
  subject: string;
  /** The message's lines after the subject. */
  body?: string;
  at?: number;
  author?: string;
}

/** A registered instance (.erga/config.json) as it answers now: the commit it runs (GET /api/ops) and its health. */
export interface Instance {
  host: string;
  /** The primary of a staging instance. */
  stagingOf?: string;
  version: string | null;
  healthy: boolean | null;
  /** Why it gave no commit. */
  error?: string;
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
    return `${o.branch} is not a feature branch. A deploy of a primary moves main: bun erga deploy <host>.`;
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

/**
 * Where a server's deploy is: its run waits for a runner, runs (`job`: the job that runs now), or ended. `note`: what
 * GitHub still says when the server already runs the run's commit (GitHub's status can lag; the server's answer wins).
 */
/** `bun erga status`'s picture: the clone as it is (no fetch), and each registered instance's answer. */
export interface State {
  heads: { main: string | null; staging: string | null };
  /** Each primary first, then its staging instances. */
  instances: Instance[];
  branches: Branch[];
  /** Commits on staging that main does not have (a deploy of a primary takes them out). */
  waiting: Commit[];
  /** main's recent commits, and the release tag of each that has one. */
  log: (Commit & { tag?: string })[];
  latestRelease: string | null;
}

/** The state from what was read: the instances in the order of their primaries, and main's log with its tags. */
export function stateOf(o: {
  heads: State["heads"];
  instances: Instance[];
  branches: Branch[];
  waiting: Commit[];
  log: Commit[];
  tags: { name: string; sha: string }[];
}): State {
  const tagOf = new Map(o.tags.map((t) => [t.sha, t.name]));
  const hosts = new Set(o.instances.map((i) => i.host));
  const primaries = o.instances.filter((i) => !i.stagingOf || !hosts.has(i.stagingOf));
  return {
    heads: o.heads,
    instances: primaries.flatMap((p) => [p, ...o.instances.filter((i) => i.stagingOf == p.host && i != p)]),
    branches: [...o.branches].sort((a, b) => b.at - a.at),
    waiting: o.waiting,
    log: o.log.map((c) => (tagOf.has(c.sha) ? { ...c, tag: tagOf.get(c.sha)! } : c)),
    latestRelease: latestTag(o.tags.map((t) => t.name)),
  };
}

/** Where an instance's commit is in the clone: a branch's head, else whether the clone has it at all. */
function placeOf(version: string, s: State, has: (sha: string) => boolean): string {
  const at = (["main", "staging"] as const).filter((b) => s.heads[b]?.startsWith(version));
  if (at.length) return `origin/${at.join(" and origin/")}'s head`;
  return has(version) ? "not a branch's head" : "a commit this clone does not have (git fetch)";
}

/** `bun erga status` as text. `has`: whether the clone has a commit. */
export function statusText(s: State, has: (sha: string) => boolean = () => true): string {
  const out: string[] = [
    `main ${s.heads.main?.slice(0, 12) ?? "?"}, staging ${s.heads.staging?.slice(0, 12) ?? "?"} (as this clone knows them)`,
    "",
  ];
  out.push("Instances (.erga/config.json):");
  if (!s.instances.length) out.push("- none: bun erga register <host>");
  for (const i of s.instances)
    out.push(
      `${i.stagingOf ? "  - " : "- "}${i.host}${i.stagingOf ? ` (staging of ${i.stagingOf})` : ""}: ${i.version ? `runs ${i.version}, ${placeOf(i.version, s, has)}` : (i.error ?? "no answer")}; health ${i.healthy == null ? "unknown" : i.healthy ? "ok" : "FAIL"}`
    );
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
    : "Don't push to main directly. A deploy of a primary moves main: bun erga deploy <host>. bun erga skill tells the rest.";
}
