// The factory's git tokens (fgt.…), as Erga's Git endpoint checks them
// (worker/source.ts, source/repo.ts) and the dev server's stand-in does
// (dev/factory.ts). The Worker mints them (worker/factory.ts, gitToken):
//
//   fgt.<base64url JSON { scope, branch, exp, by? }>.<hex HMAC-SHA256 of that, with HMAC(secret, "erga-factory-git")>
//
// A task's token reads the repository and pushes its own branch (task/…),
// deleting it included. A merge token also moves staging forward, never
// deletes it. Nothing else: not main, not another task's branch.
//
// Platform-neutral: Web Crypto only (the Worker, Bun and the tests).

/** What a git token allows: read, and push `branch` (a task's); a merge token also pushes staging. */
export interface GitGrant {
  scope: "task" | "merge";
  branch: string;
  /** Seconds since 1970. */
  exp: number;
  /** The admin who asked (a merge's: whoever pressed Merge), for the push's record and its deploy. */
  by?: string;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(key: Uint8Array<ArrayBuffer> | string, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", typeof key == "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

const fromB64url = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

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
