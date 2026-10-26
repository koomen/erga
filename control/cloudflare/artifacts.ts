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
// an expiry), signed with the dev server's secret. GitHub is a pretend GitHub
// there too (dev/github-mock.ts): local development never reaches the real ones.

import { forkRemote, type ForkAccess } from "../install/forks";
import type { InstallSpec } from "../install/install";
import type { Remote } from "../source/index.ts";
import type { Env } from "../../cloudflare/env";
import { hex } from "../../shared/bytes";

/** The repository's name in the namespace. */
export const REPO = "erga";

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

/**
 * A downstream's control Worker (control/install/install.ts): its fork at upstream, reached with its FORK_SECRET (control/install/forks.ts);
 * null elsewhere.
 */
export function forkOf(env: Pick<Env, "UPSTREAM" | "INSTALL" | "FORK_SECRET">): ForkAccess | null {
  const upstream = env.UPSTREAM?.trim().replace(/\/+$/, ""), secret = env.FORK_SECRET?.trim();
  if (!upstream || !secret || !env.INSTALL) return null;
  try { const id = (JSON.parse(env.INSTALL) as InstallSpec).fork; return id ? { upstream, id, secret } : null; } catch { return null; }
}

/** Whether this server has a repository at all (the binding, local development's stand-in, or a downstream's fork at upstream). */
export const hasSource = (env: Env) => !!env.ARTIFACTS || local(env) || !!forkOf(env);

/** Tokens minted, kept while they have more than ten minutes left. */
const minted = new Map<string, { token: string; remote: string; expires: number }>();

export interface RepoAccess extends Remote { token: string; expiresAt: string }

/** This server's repository (Erga's own, or a downstream's fork) as a Git remote, with a token of this scope. Null when there's no repository. */
export async function artifactsRemote(env: Env, scope: "read" | "write", origin?: string): Promise<RepoAccess | null> {
  if (!hasSource(env)) return null;
  const fork = forkOf(env);
  return fork ? artifactsRemoteFor(env, `fork:${fork.id}`, scope, origin, fork) : artifactsRemoteFor(env, REPO, scope, origin);
}

/**
 * A repo of Erga's namespace as a Git remote, with a token of this scope (minted through the binding, or local
 * development's stand-in); a downstream's fork, through upstream (control/install/forks.ts). Tokens are kept while they have
 * more than ten minutes left.
 */
export async function artifactsRemoteFor(env: Env, repo: string, scope: "read" | "write", origin?: string, fork?: ForkAccess): Promise<RepoAccess> {
  const key = `${repo}:${scope}`;
  const have = minted.get(key);
  if (have && have.expires - Date.now() > 10 * 60_000) return access(have.remote, have.token, have.expires);
  let remote: string, token: string, expires: number;
  if (fork) {
    const r = await forkRemote(fork, scope);
    remote = r.url; token = r.token; expires = Date.parse(r.expiresAt) || Date.now() + 3600_000;
  } else if (env.ARTIFACTS) {
    const handle = await env.ARTIFACTS.get(repo);
    try {
      remote = (await handle.info()).remote;
      const t = await handle.createToken(scope, 3600);
      token = t.plaintext;
      expires = Date.parse(t.expiresAt) || Date.now() + 3600_000;
    } finally { handle[Symbol.dispose]?.(); }
  } else {
    remote = `${devOrigin(env, origin)}/__artifacts/git/${REPO}/${repo}.git`;
    expires = Date.now() + 3600_000;
    token = await localToken(env.ERGA_LINK_SECRET!, `${REPO}/${repo}`, scope, Math.floor(expires / 1000));
  }
  minted.set(key, { remote, token, expires });
  return access(remote, token, expires);
}

const access = (url: string, token: string, expires: number): RepoAccess => ({ url, token, expiresAt: new Date(expires).toISOString(), headers: { Authorization: `Bearer ${token}` } });

/** A local repo token, as dev/git-server.ts checks it. */
async function localToken(secret: string, repo: string, scope: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${scope}:${exp}:${repo}`)));
  return `art_local_${scope}_${exp}_${hex(mac).slice(0, 40)}?expires=${exp}`;
}
