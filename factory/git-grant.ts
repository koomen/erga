// The factory's git tokens (fgt.…), as Erga's Git endpoint checks them
// (worker/source.ts, source/repo.ts) and the dev server's stand-in does
// (dev/factory.ts). The Worker mints them (worker/factory.ts, gitToken):
//
//   fgt.<base64url of the UTF-8 JSON { scope, branch, exp, by?, via?, id? }>.<hex HMAC-SHA256 of that, with HMAC(secret, "erga-factory-git")>
//
// A task's token reads staging, main and its own branch (task/…), and pushes
// its own branch, deleting it included. A merge token also moves staging,
// once, and only to the merge itself: one new commit on top of staging, whose
// other parent is the task's branch as pushed (with staging in it), with that
// branch's files (mergeShape). Nothing else: not main, not another task's
// branch, no other commit on staging. The VM is one user, so the task's own
// code can read the merge job's environment: a merge token taken that way
// does no more than the merge the admin asked for.
//
// Platform-neutral: Web Crypto only (the Worker, Bun and the tests).

/** What a git token allows: read, and push `branch` (a task's); a merge token also pushes staging. */
export interface GitGrant {
  scope: "task" | "merge";
  branch: string;
  /** Seconds since 1970. */
  exp: number;
  /** The admin who asked (a login: the task's person, or for a merge whoever pressed Merge), for the push's record and its deploy. */
  by?: string;
  /** How they did it (attribution.ts): "the factory (task #3)". */
  via?: string;
  /** A merge token's own id: it moves staging once (source/repo.ts keeps the ids it has spent). */
  id?: string;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(key: Uint8Array<ArrayBuffer> | string, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", typeof key == "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** base64url, unpadded, of bytes or of a text's UTF-8 bytes: what a token's body is. btoa alone throws on text past Latin-1 (a curly apostrophe, an emoji). */
export function b64url(s: string | Uint8Array): string {
  let bin = "";
  for (const b of typeof s == "string" ? enc.encode(s) : s) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The text in a base64url body: its bytes as UTF-8 (as the Worker mints them now), or, if they aren't valid UTF-8, as Latin-1 (as older tokens were, with btoa alone). */
export function fromB64url(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); } catch { return bin; }
}

/** The grant a token carries, if `secret` signed it, it names a task branch, and it hasn't ended; else null. */
export async function verifyGitToken(secret: string, token: string): Promise<GitGrant | null> {
  const m = /^fgt\.([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(token);
  if (!m || !secret) return null;
  const want = hex(await hmac(new Uint8Array(await hmac(secret, "erga-factory-git")), m[1]));
  if (want.length != m[2].length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2].charCodeAt(i);
  if (diff) return null;
  try {
    const g = JSON.parse(fromB64url(m[1])) as GitGrant;
    if ((g.scope != "task" && g.scope != "merge") || !isTaskBranch(g.branch) || !(g.exp * 1000 > Date.now())) return null;
    return g;
  } catch { return null; }
}

/** A factory task's branch name (factory/prompt.ts, branchName): task/<id>-<slug>. */
export const isTaskBranch = (b: unknown): b is string => typeof b == "string" && /^task\/\d+-[a-z0-9-]+$/.test(b);

/** Whether a grant may read (list and fetch) `ref`: staging, main and its own branch, never another task's. */
export const readAllowed = (grant: GitGrant, ref: string) =>
  ref == "HEAD" || ref == "refs/heads/staging" || ref == "refs/heads/main" || ref == `refs/heads/${grant.branch}`;

/** What mergeShape needs to know of a commit. */
export interface CommitFacts { tree: string; parents: string[] }

/**
 * Whether a merge token's move of staging, from `old` to `next`, is the merge itself (factory/vm/merge.ts): `next`
 * has the parents [old, head], where `head` is the task's branch as it is now and has `old` in it, and `next` has
 * head's files. The reason if not. `commit` reads a commit (null if unknown); `isAncestor(a, b)`: b comes from a.
 */
export function mergeShape(grant: GitGrant, old: string, next: string, head: string | undefined,
  commit: (sha: string) => CommitFacts | null, isAncestor: (a: string, b: string) => boolean): string | null {
  const why = (s: string) => `a merge token moves staging only to the merge of ${grant.branch}: ${s}`;
  if (grant.scope != "merge") return why("this isn't a merge token");
  if (!grant.id) return why("this token is an older one, with no id: merge again");
  if (!head) return why(`push ${grant.branch} first`);
  const c = commit(next), h = commit(head);
  if (!c || !h) return why("its commits aren't known");
  if (c.parents.length != 2 || c.parents[0] != old || c.parents[1] != head) return why(`the new commit must have two parents: staging's head (${old.slice(0, 7)}), then the branch's (${head.slice(0, 7)})`);
  if (!isAncestor(old, head)) return why(`merge staging into ${grant.branch} first, and push it`);
  if (c.tree != h.tree) return why(`the new commit must have the files of ${grant.branch} (${head.slice(0, 7)})`);
  return null;
}

/** Whether a grant allows these ref updates; the reason if not. */
export function refsAllowed(grant: GitGrant, refs: { next: string; ref: string }[]): string | null {
  for (const { next, ref } of refs) {
    const deleting = /^0+$/.test(next);
    if (ref == `refs/heads/${grant.branch}`) continue;
    if (grant.scope == "merge" && ref == "refs/heads/staging" && !deleting) continue;
    return `this token may push ${grant.branch}${grant.scope == "merge" ? " and staging" : ""} only, not ${ref}`;
  }
  return null;
}
