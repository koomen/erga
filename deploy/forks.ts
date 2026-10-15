// A downstream's repository and builds, at erga.dev. An install (an Erga on
// its own domain: deploy/install.ts) has a repository of its own, a fork of
// erga.dev's, so it can have commits of its own and still take erga.dev's.
// The fork lives at erga.dev: an Artifacts repo in Erga's namespace,
// fork-<id>, made and seeded when the install is made (cloudflare/pipeline.ts
// makeFork), and erga.dev's build container builds the fork's commits (a
// downstream's account has no container). The downstream's control Worker
// reaches both with its FORK_SECRET (set on it by the install; erga.dev keeps
// its hash): POST /forks/<id>/token gives it a short-lived token for the repo,
// and POST /forks/<id>/builder/build streams a build back as the container
// does (control/builder/client.ts), so the same client runs on both sides.
//
// A commit the downstream took from erga.dev whole (a fast-forward Update)
// has its release in erga.dev's store already: the builder fetches that and
// builds nothing. Platform-neutral: the Worker and the tests run it.

import type { Builder } from "./branches";
import { containerBuilder } from "../control/builder/client";
import { bundleOf } from "./bundle";
import type { Fetch, Release } from "./pipeline";
import { storeBuilder, type ReleaseStore } from "./releases";

/** The fork's repository in Erga's Artifacts namespace. */
export const forkRepo = (id: string) => `fork-${id}`;
/** A fork's id: lowercase letters and digits, as the install makes one. */
export const isForkId = (s: string) => /^[a-z0-9]{8,40}$/.test(s);

/** A fork as erga.dev keeps it: its id, its secret's hash (never the secret), the commit it was seeded at, who made it. */
export interface ForkRecord { id: string; secretHash: string; commit: string; by: string; at: number }

export async function hashSecret(secret: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a downstream's control Worker knows of its fork: upstream's origin, the fork's id, its secret. */
export interface ForkAccess { upstream: string; id: string; secret: string }

/** A short-lived token for the fork's repository, from upstream: the remote and the token, as the repository's Remote wants them. */
export async function forkRemote(fork: ForkAccess, scope: "read" | "write", net: Fetch = globalThis.fetch.bind(globalThis)): Promise<{ url: string; token: string; expiresAt: string; headers: Record<string, string> }> {
  const r = await net(`${fork.upstream}/forks/${fork.id}/token`, { method: "POST", headers: { Authorization: `Bearer ${fork.secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ scope }) });
  const body = (await r.json().catch(() => ({}))) as { remote?: string; token?: string; expiresAt?: string; error?: string };
  if (!r.ok || !body.remote || !body.token) throw new Error(`${fork.upstream} gave no token for the fork's repository: ${body.error ?? `HTTP ${r.status}`}`);
  return { url: body.remote, token: body.token, expiresAt: body.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(), headers: { Authorization: `Bearer ${body.token}` } };
}

/**
 * A downstream's builder: a release of upstream's store when the commit is one of upstream's (a fast-forward Update
 * brought it whole), else a build at upstream, in its container, over the fork's secret.
 */
export function forkBuilder(fork: ForkAccess, store: ReleaseStore, net: Fetch = globalThis.fetch.bind(globalThis)): Builder {
  const fromStore = storeBuilder(store);
  const proxied = (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input == "string" ? input : input instanceof URL ? input.href : input.url);
    return net(`${fork.upstream}/forks/${fork.id}/builder/${u.pathname.replace(/^\/+/, "")}${u.search}`, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${fork.secret}` } });
  };
  const remote = containerBuilder({ fetch: proxied as typeof fetch });
  return {
    async build(o, log, signal) {
      const version = o.commit.slice(0, 12);
      if (await store.manifest(version).catch(() => null)) return fromStore.build({ commit: version }, log, signal);
      log(`${version} isn't one of ${fork.upstream.replace(/^https?:\/\//, "")}'s releases: building it there`);
      return remote.build({ ...o, source: null }, log, signal);
    },
  };
}

/**
 * The build container's HTTP shape over any Builder (the mock's, in local development and the tests): POST /build
 * {commit, branch} streams {log} lines and a {bundle} line, as control/builder/server.ts does; POST /cancel answers.
 */
export function builderEndpoint(builder: Builder, source: (commit: string) => Promise<{ cloneUrl: string; token?: string } | null> = async () => null): (request: Request) => Promise<Response> {
  const running = new Map<string, AbortController>();
  return async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (url.pathname.endsWith("/cancel")) { running.get(id)?.abort(); return Response.json({ stopped: running.delete(id) }); }
    if (!url.pathname.endsWith("/build") || request.method != "POST") return new Response("Not found", { status: 404 });
    const body = (await request.json().catch(() => ({}))) as { commit?: string; branch?: string; source?: { cloneUrl: string; token?: string } | null };
    if (!body.commit) return new Response("commit?", { status: 400 });
    const abort = new AbortController();
    running.set(id, abort);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const line = (o: object) => c.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
        try {
          const release = await builder.build({ commit: body.commit!, branch: body.branch ?? "main", source: body.source ?? await source(body.commit!) }, (l) => line({ log: l }), abort.signal);
          line({ bundle: bundleOf(release) });
        } catch (e) { line({ error: (e as Error).message }); }
        running.delete(id);
        c.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  };
}

/** A fork's build request as erga.dev's builder takes it: the client's commit and branch, the source made the fork's own. */
export function forkBuildBody(body: string, source: { cloneUrl: string; token?: string }): string {
  let b: { commit?: string; branch?: string } = {};
  try { b = JSON.parse(body) as typeof b; } catch { /* the builder refuses it */ }
  return JSON.stringify({ commit: b.commit, branch: b.branch, source });
}

export type { Release };
