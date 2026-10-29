// What the control Worker has of Cloudflare: Erga's repository in Artifacts,
// Erga's GitHub App as the Worker's settings and secrets have it, and the
// release bucket.

import { forkGithubToken, forkGithubUninstall, forkRemote, type ForkAccess } from "./install/forks";
import type { InstallSpec } from "./install/install";
import { githubOrigins, installationToken, uninstall, type GithubApp, type Remote } from "./source/index.ts";
import { memoryBlobs, r2Blobs, ReleaseStore } from "./deploys/releases";
import type { HostEnv } from "./env";
import { Hex } from "effect/encoding";

// ---- Erga's repository

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
const devOrigin = (env: HostEnv, origin?: string) => env.ERGA_DEV_ORIGIN || origin || "";
const local = (env: HostEnv) => !env.ARTIFACTS && !!env.ERGA_LINK_SECRET;

/**
 * A downstream's control Worker (control/install/install.ts): its fork at upstream, reached with its FORK_SECRET (control/install/forks.ts);
 * null elsewhere.
 */
export function forkOf(env: Pick<HostEnv, "UPSTREAM" | "INSTALL" | "FORK_SECRET">): ForkAccess | null {
  const upstream = env.UPSTREAM?.trim().replace(/\/+$/, ""), secret = env.FORK_SECRET?.trim();
  if (!upstream || !secret || !env.INSTALL) return null;
  try { const id = (JSON.parse(env.INSTALL) as InstallSpec).fork; return id ? { upstream, id, secret } : null; } catch { return null; }
}

/** Whether this server has a repository at all (the binding, local development's stand-in, or a downstream's fork at upstream). */
export const hasSource = (env: HostEnv) => !!env.ARTIFACTS || local(env) || !!forkOf(env);

/** Tokens minted, kept while they have more than ten minutes left. */
const minted = new Map<string, { token: string; remote: string; expires: number }>();

export interface RepoAccess extends Remote { token: string; expiresAt: string }

/** This server's repository (Erga's own, or a downstream's fork) as a Git remote, with a token of this scope. Null when there's no repository. */
export async function artifactsRemote(env: HostEnv, scope: "read" | "write", origin?: string): Promise<RepoAccess | null> {
  if (!hasSource(env)) return null;
  const fork = forkOf(env);
  return fork ? artifactsRemoteFor(env, `fork:${fork.id}`, scope, origin, fork) : artifactsRemoteFor(env, REPO, scope, origin);
}

/**
 * A repo of Erga's namespace as a Git remote, with a token of this scope (minted through the binding, or local
 * development's stand-in); a downstream's fork, through upstream (control/install/forks.ts). Tokens are kept while they have
 * more than ten minutes left.
 */
export async function artifactsRemoteFor(
  env: HostEnv,
  repo: string,
  scope: "read" | "write",
  origin?: string,
  fork?: ForkAccess
): Promise<RepoAccess> {
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
  return `art_local_${scope}_${exp}_${Hex.encode(mac).slice(0, 40)}?expires=${exp}`;
}

// ---- the GitHub App

// Erga's GitHub App, as a Worker has it (control/source/github.ts): erga.dev's
// control Worker has the App whole (its id, slug and client id in
// deploy/targets.json, control.vars; the client secret, the private key and the webhook
// secret as its secrets). An install's control Worker has only the public
// parts (its install set them), and reaches the rest through erga.dev over
// its fork's secret (control/install/forks.ts): installation tokens, the uninstall,
// the consent's relay. Local development has the pretend GitHub
// (dev/github-mock.ts) at the dev server, ERGA_GITHUB_ORIGIN.

export type GithubAppEnv = Pick<
  HostEnv,
  | "GITHUB_APP_ID"
  | "GITHUB_APP_SLUG"
  | "GITHUB_APP_CLIENT_ID"
  | "GITHUB_APP_CLIENT_SECRET"
  | "GITHUB_APP_PRIVATE_KEY"
  | "GITHUB_WEBHOOK_SECRET"
  | "ERGA_GITHUB_ORIGIN"
  | "UPSTREAM"
  | "INSTALL"
  | "FORK_SECRET"
>;

/** The App as this Worker knows it (the public parts at least), or null where there's none (an app Worker). */
export function githubAppOf(env: GithubAppEnv): GithubApp | null {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  if (!clientId) return null;
  const { www, api } = githubOrigins(env.ERGA_GITHUB_ORIGIN);
  return {
    appId: env.GITHUB_APP_ID?.trim() ?? "", slug: env.GITHUB_APP_SLUG?.trim() || "erga-editor", clientId,
    ...(env.GITHUB_APP_CLIENT_SECRET ? { clientSecret: env.GITHUB_APP_CLIENT_SECRET } : {}),
    ...(env.GITHUB_APP_PRIVATE_KEY ? { privateKey: env.GITHUB_APP_PRIVATE_KEY } : {}),
    ...(env.GITHUB_WEBHOOK_SECRET ? { webhookSecret: env.GITHUB_WEBHOOK_SECRET } : {}),
    www, api,
  };
}

/** An installation token: minted here with the App's key, or at upstream over the fork's secret (an install). */
export async function githubTokenFor(env: GithubAppEnv, installationId: number): Promise<{ token: string; expiresAt: number }> {
  const app = githubAppOf(env);
  if (app?.privateKey) return installationToken(app, installationId);
  const fork = forkOf(env);
  if (fork) return forkGithubToken(fork, installationId);
  throw new Error("This server can't reach GitHub as the App: it has no private key, and no upstream to ask.");
}

/** The App uninstalled from the account: here with the key, or through upstream. */
export async function githubUninstallFor(env: GithubAppEnv, installationId: number): Promise<void> {
  const app = githubAppOf(env);
  if (app?.privateKey) return uninstall(app, installationId);
  const fork = forkOf(env);
  if (fork) await forkGithubUninstall(fork, installationId);
}

// ---- the release store

// The release store (control/deploys/releases.ts) as this Worker has it: the control
// Worker's bucket (RELEASES, control/wrangler.jsonc); in local development,
// over the mock Cloudflare, one in memory that the deploys' object and the
// routes that serve it share. The app Workers on erga.dev have none.

/** Local development's release store (ERGA_DEPLOY_MOCK): in memory, one per isolate. */
export const DEV_BLOBS = memoryBlobs();

/** The release store this Worker has, or null. */
export const releaseStoreOf = (env: Pick<HostEnv, "RELEASES" | "ERGA_DEPLOY_MOCK">): ReleaseStore | null =>
  env.RELEASES ? new ReleaseStore(r2Blobs(env.RELEASES)) : env.ERGA_DEPLOY_MOCK == "1" ? new ReleaseStore(DEV_BLOBS) : null;
