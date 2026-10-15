// Where Erga's repository is: one Cloudflare Artifacts repo,
// "erga", reached through the Worker's Artifacts binding (ARTIFACTS,
// cloudflare.config.ts, only when the deploy names a namespace). Erga uses the
// binding for two things only: the repo's Git remote, and short-lived
// repo-scoped tokens for it. Everything else is plain Git over HTTPS,
// the same protocol any git client uses. Not the REST
// API: that needs a Cloudflare API token with Artifacts Edit as a secret,
// which can do far more than one repository's tokens.
//
// Erga proxies Git itself rather than hand out this
// remote: Artifacts' tokens don't know Erga's admins, Artifacts can't hold
// Erga's rules (two branches, main only forward), and every branch move must
// go through Erga so it can tell the Ops page, the deploys and the mirror.
//
// Artifacts has no local mode (the binding in `vite dev` only proxies to the
// real service), so local development uses a stand-in: the dev server serves
// a bare repository with real `git http-backend`, and
// this file mints tokens for it the way Artifacts would (read or write, with
// an expiry), signed with the dev server's secret. The GitHub mirror is a
// pretend GitHub there too: local development never reaches the real ones.

import type { Remote } from "../server/source/index.ts";
import type { Env } from "./env";

/** The repository's name in the namespace. */
export const REPO = "erga";
/** The pretend GitHub's token. */
const MOCK_GITHUB_TOKEN = "erga-dev-github-token";
/** Erga's canonical repository on GitHub, which becomes a mirror. */
export const GITHUB_DEFAULT = "https://github.com/koomen/erga.git";

/** The part of the Artifacts binding Erga uses (the binding's types: workerd's Artifacts, ArtifactsRepo). */
export interface ArtifactsBinding {
  get(name: string): Promise<{
    info(): Promise<{ remote: string }>;
    createToken(scope?: "read" | "write", ttl?: number): Promise<{ plaintext: string; expiresAt: string }>;
    [Symbol.dispose]?(): void;
  }>;
}

/** Local development: the dev server's address, where the stand-ins are (ERGA_DEV_ORIGIN, else the request's). */
const devOrigin = (env: Env, origin?: string) => env.ERGA_DEV_ORIGIN || origin || "";
const local = (env: Env) => !env.ARTIFACTS && !!env.ERGA_LINK_SECRET;

/** Whether this server has a repository at all (the binding, or local development's stand-in). */
export const hasSource = (env: Env) => !!env.ARTIFACTS || local(env);

/** Tokens minted, kept while they have more than ten minutes left. */
const minted = new Map<string, { token: string; remote: string; expires: number }>();

export interface RepoAccess extends Remote { token: string; expiresAt: string }

/** The Artifacts repo as a Git remote, with a token of this scope. Null when there's no repository. */
export async function artifactsRemote(env: Env, scope: "read" | "write", origin?: string): Promise<RepoAccess | null> {
  if (!hasSource(env)) return null;
  const key = `${scope}`;
  const have = minted.get(key);
  if (have && have.expires - Date.now() > 10 * 60_000) return access(have.remote, have.token, have.expires);
  let remote: string, token: string, expires: number;
  if (env.ARTIFACTS) {
    const repo = await env.ARTIFACTS.get(REPO);
    try {
      remote = (await repo.info()).remote;
      const t = await repo.createToken(scope, 3600);
      token = t.plaintext;
      expires = Date.parse(t.expiresAt) || Date.now() + 3600_000;
    } finally { repo[Symbol.dispose]?.(); }
  } else {
    remote = `${devOrigin(env, origin)}/__artifacts/git/${REPO}/${REPO}.git`;
    expires = Date.now() + 3600_000;
    token = await localToken(env.ERGA_LINK_SECRET!, `${REPO}/${REPO}`, scope, Math.floor(expires / 1000));
  }
  minted.set(key, { remote, token, expires });
  return access(remote, token, expires);
}

const access = (url: string, token: string, expires: number): RepoAccess => ({ url, token, expiresAt: new Date(expires).toISOString(), headers: { Authorization: `Bearer ${token}` } });

/** The GitHub mirror as a Git remote, or null when there's none (no token). Locally, the pretend GitHub. */
export function githubRemote(env: Env, origin?: string): Remote | null {
  if (local(env)) return { url: `${devOrigin(env, origin)}/__github/koomen/erga.git`, headers: { Authorization: `Basic ${btoa(`x-access-token:${MOCK_GITHUB_TOKEN}`)}` } };
  const token = env.GITHUB_MIRROR_TOKEN?.trim();
  if (!token) return null;
  return { url: env.GITHUB_MIRROR_URL?.trim() || GITHUB_DEFAULT, headers: { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` } };
}

/** Where the mirror would push, for the page when it's off. */
export const githubUrl = (env: Env) => (local(env) ? "the pretend GitHub (local development)" : env.GITHUB_MIRROR_URL?.trim() || GITHUB_DEFAULT);

/** A local repo token, as dev/git-server.ts checks it. */
async function localToken(secret: string, repo: string, scope: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${scope}:${exp}:${repo}`)));
  return `art_local_${scope}_${exp}_${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40)}?expires=${exp}`;
}
