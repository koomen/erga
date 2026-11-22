// Release tags (vX.Y.Z) and auto-deploy modes (off, releases, commits), pure and small: no Effect, no Node, so both
// Cloudflare's small deployer (worker.ts) and AWS's (github.ts, look.ts, control.ts) share one implementation.

/** Whether and what auto-deploy deploys on the tracked branch: off, tagged vX.Y.Z releases only, or every commit. */
export const AUTO_MODES = ["off", "releases", "commits"] as const;
export type AutoMode = (typeof AUTO_MODES)[number];
/** The two active modes (stored in deploy_control.auto_mode alongside deploy_control.auto = 1). */
export type AutoTarget = "releases" | "commits";

/** A numbered release tag (vX.Y.Z) and the commit SHA it points to (peeled for annotated tags). */
export interface ReleaseTag {
  tag: string;
  sha: string;
}

/** The newest release tag on the tracked branch, with what GitHub's registry has for its commit. */
export interface LatestRelease {
  tag: string;
  sha: string;
  release: "released" | "none" | "refused";
}

/** Strict semver release tag: vX.Y.Z (no prerelease suffix like -rc.1, no build metadata). */
export const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;

/** Compares two semver tags: >0 when `a` is newer than `b`, <0 when older, 0 when equal. */
export function compareSemver(a: string, b: string): number {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) return 0;
  return Number(ma[1]) - Number(mb[1]) || Number(ma[2]) - Number(mb[2]) || Number(ma[3]) - Number(mb[3]);
}

/**
 * Parses git's ref list (`info/refs?service=git-upload-pack` or `git ls-remote`) for `branch`'s head and all strict
 * semver release tags (vX.Y.Z), newest first. Annotated tags have two lines (the tag object, then `^{}` with the
 * commit): the peeled commit wins.
 */
export function parseRefs(refs: string, branch: string): { head: string | null; tags: ReleaseTag[] } {
  let head: string | null = null;
  const byTag = new Map<string, { sha: string; peeled: boolean }>();
  const want = `refs/heads/${branch}`;
  for (const line of refs.split("\n")) {
    const clean = line.split("\0")[0].trimEnd();
    const ref = /([0-9a-f]{40})[ \t](.+)$/.exec(clean);
    if (!ref) continue;
    const [, sha, name] = ref;
    if (name == want) head = sha;
    else if (name.startsWith("refs/tags/")) {
      const peeled = name.endsWith("^{}");
      const tag = name.slice("refs/tags/".length, peeled ? -3 : undefined);
      if (!SEMVER.test(tag)) continue;
      const had = byTag.get(tag);
      if (!had || peeled) byTag.set(tag, { sha, peeled });
    }
  }
  const tags = [...byTag.entries()].map(([tag, v]) => ({ tag, sha: v.sha })).sort((a, b) => compareSemver(b.tag, a.tag));
  return { head, tags };
}

/** The newest semver release tag pointing to each commit SHA. */
export function tagBySha(tags: readonly ReleaseTag[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of tags) if (!out.has(t.sha)) out.set(t.sha, t.tag);
  return out;
}

/** Auto-deploy mode from the database's `auto` (0|1) and `auto_mode` ('releases'|'commits') columns. */
export function autoModeOf(auto: boolean | number | null | undefined, autoMode?: string | null): AutoMode {
  if (!auto) return "off";
  return autoMode == "releases" ? "releases" : "commits";
}

/** Whether `value` is a valid AutoMode string. */
export const isAutoMode = (value: unknown): value is AutoMode => value == "off" || value == "releases" || value == "commits";

export type AutoPick = { wait: string } | { sha: string; tag: string | null; release: "released" | "none" | "refused" };

/** Selects the auto-deploy target for `mode`, or returns why auto-deploy does nothing. */
export function pickAutoTarget(
  mode: AutoMode,
  branch: string,
  head: string,
  release: "released" | "none" | "refused",
  latestRelease: LatestRelease | null
): AutoPick {
  if (mode == "off") return { wait: "Auto-deploy is off." };
  if (mode == "releases") {
    if (!latestRelease) return { wait: `No release tag (vX.Y.Z) on ${branch} yet: nothing to deploy.` };
    return { sha: latestRelease.sha, tag: latestRelease.tag, release: latestRelease.release };
  }
  return { sha: head, tag: null, release };
}

/** Finds the newest semver tag on the tracked branch (checking head, seen commits, cached release, then at most 3 compare calls). */
export async function resolveLatestTag(
  tags: readonly ReleaseTag[],
  head: string,
  commits: readonly { sha: string }[] | undefined,
  cached: LatestRelease | null | undefined,
  onBranch: (sha: string) => Promise<boolean>
): Promise<ReleaseTag | null> {
  for (let i = 0, checked = 0; i < tags.length; i++) {
    const t = tags[i];
    if (t.sha == head || commits?.some((k) => k.sha == t.sha) || cached?.sha == t.sha) return t;
    if (checked++ >= 3) break;
    if (await onBranch(t.sha)) return t;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Parses GitHub's Atom feed of a branch's commits, newest first. Returns null if an entry cannot be read.
 * Titles are plain text trimmed to 200 characters (whatever shows them escapes them).
 */
export function parseCommitsFeed(feed: string): { sha: string; title: string; at: number }[] | null {
  const out: { sha: string; title: string; at: number }[] = [];
  for (const entry of feed.split("<entry>").slice(1)) {
    const sha = /<id>[^<]*Commit\/([0-9a-f]{40})<\/id>/.exec(entry)?.[1];
    const title = /<title>([^<]*)<\/title>/.exec(entry)?.[1];
    const at = Date.parse(/<updated>([^<]*)<\/updated>/.exec(entry)?.[1] ?? "");
    if (!sha || title == null || Number.isNaN(at)) return null;
    const plain = title.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (all, dec, hex, name) =>
      dec || hex ? String.fromCodePoint(Number.parseInt(dec ?? hex, dec ? 10 : 16) || 0xfffd) : (ENTITIES[name.toLowerCase()] ?? all)
    );
    out.push({ sha, title: plain.replace(/\s+/g, " ").trim().slice(0, 200), at });
  }
  return out;
}
