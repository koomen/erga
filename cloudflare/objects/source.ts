// Erga's repository's Durable Object: one, "erga", where every push and
// merge happens one at a time, with the commit index, the GitHub link and the
// sync's status in its SQLite: the Cloudflare side of server/source/repo.ts.
// The routes (server/source/routes.ts) check who's asking and hand it the
// request.
//
// Calls name the address the request came to (`origin`), which local
// development's stand-ins for Artifacts and GitHub live at. GitHub's
// installation tokens come from the App's key here (erga.dev's control
// Worker), or from erga.dev over the fork's secret (an install's).

import { DurableObject } from "cloudflare:workers";
import { deployHook, publishEvent, releaseHook } from "../../deploy/hook";
import { byLine } from "../../shared/attribution";
import { SourceError, SourceRepo, ZERO, type Actor, type GithubLink, type GithubStatus, type PushEvent, type Released, type SourceAnswer, type SourceObject, type SourceRead, type UpdateResult, type UpstreamSource } from "../../server/source/index.ts";
import { artifactsRemote, forkOf } from "../artifacts";
import { githubAppOf, githubTokenFor, githubUninstallFor } from "../github-app";
import { directoryOf } from "../d1";
import type { Env } from "../env";

export class SourceHost extends DurableObject<Env> implements SourceObject {
  private origin = "";
  private repo: SourceRepo;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    const app = githubAppOf(env), fork = forkOf(env);
    this.repo = new SourceRepo({
      db: { exec: <T>(q: string, ...params: (string | number | null)[]) => sql.exec(q, ...params).toArray() as T[] },
      artifacts: async () => {
        const r = await artifactsRemote(env, "write", this.origin);
        if (!r) throw new SourceError("Erga's repository isn't set up on this server (no Artifacts binding).", 503);
        return r;
      },
      // Reads use a read token: they can't write, whatever they ask.
      reader: async () => {
        const r = await artifactsRemote(env, "read", this.origin);
        if (!r) throw new SourceError("Erga's repository isn't set up on this server (no Artifacts binding).", 503);
        return r;
      },
      // GitHub's tokens: minted here with the App's key (erga.dev), or at upstream over the fork's secret (an install).
      ...(app || fork ? { githubToken: (id: number) => githubTokenFor(env, id), githubUninstall: (id: number) => githubUninstallFor(env, id) } : {}),
      moved: (m) => {
        ctx.waitUntil(publishEvent({ type: "source", branch: m.branch, commit: m.new }, env).catch(() => {}));
        ctx.waitUntil(deployHook(m.branch, m.new, env, `${m.how} by ${byLine(m.by, m.via)}`).catch((e) => console.error(`deploy hook (${m.branch}):`, e)));
        // main moved: the production deploy, in the change log (/admin/changes), with the commits it brought.
        if (m.branch == "main") {
          ctx.waitUntil((async () => {
            const change = { key: "main", from: m.old == ZERO ? null : m.old, to: m.new, release: { ...this.repo.newCommits(m.old, m.new), ...(m.override ? { override: m.override } : {}) } };
            await directoryOf(env).config.record(m.by, [change], m.at, m.via ?? null);
          })().catch((e) => console.error("change log (main):", e)));
        }
      },
      // A release cut (a tag): the deploys' object puts it on stable (once its build is in the store).
      released: (r) => ctx.waitUntil(releaseHook(r.tag, r.commit, byLine(r.by, r.via), env).catch((e) => console.error(`release hook (${r.tag}):`, e))),
      changed: () => ctx.waitUntil(publishEvent({ type: "source" }, env).catch(() => {})),
      background: (work) => ctx.waitUntil(work),
      // A downstream (an install's control Worker: UPSTREAM names erga.dev's): its upstream's Git endpoint, read for anyone.
      upstream: () => upstreamOf(env),
    });
  }

  /** Which answer a repository call gives when it throws: a SourceError's own message and status, else a 502. */
  private static failed(e: unknown, what: string): { error: string; status: number } {
    return e instanceof SourceError ? { error: e.message, status: e.status } : { error: `${what} failed: ${(e as Error).message}`, status: 502 };
  }

  private at(origin: string) { if (origin) this.origin = origin; return this.repo; }

  /** A push (git-receive-pack's body), as the Worker forwards it: the report git reads. */
  async fetch(request: Request): Promise<Response> {
    const actor = JSON.parse(request.headers.get("x-erga-actor") ?? "null") as Actor | null;
    if (!actor) return new Response("Who's pushing?", { status: 400 });
    const repo = this.at(request.headers.get("x-erga-origin") ?? "");
    try {
      return new Response(await repo.receive(new Uint8Array(await request.arrayBuffer()), actor) as BodyInit, { headers: { "Content-Type": "application/x-git-receive-pack-result" } });
    } catch (e) {
      return new Response(`${(e as Error).message}\n`, { status: e instanceof SourceError ? e.status : 502 });
    }
  }

  advertise(origin: string) { return this.at(origin).advertise(); }
  branches(origin: string) { return this.at(origin).branches(); }
  files(origin: string, commit: string) { return this.at(origin).files(commit); }
  // GitHub (server/source/routes.ts, control/routes.ts): the status, a sync now, connected, disconnected, a push there.
  async githubStatus(origin: string): Promise<GithubStatus> { return this.at(origin).githubStatus(); }
  syncGithub(origin: string, by: string) { return this.at(origin).syncGithub(by); }
  connectGithub(origin: string, link: GithubLink, by: string) { return this.at(origin).connectGithub(link, by); }
  async disconnectGithub(origin: string): Promise<{ ok: true } | { error: string; status: number }> {
    try { await this.at(origin).disconnectGithub(); return { ok: true }; } catch (e) { return SourceHost.failed(e, "Disconnecting GitHub"); }
  }
  async githubPushed(origin: string, event: PushEvent): Promise<GithubStatus | null> { return this.at(origin).githubPushed(event); }

  /** A read of the source, as the deploy pipeline asks for a commit's migrations: the answer, or { error }. */
  async read(origin: string, q: SourceRead): Promise<SourceAnswer | { error: string }> {
    try { return await this.at(origin).read(q); } catch (e) {
      return { error: e instanceof SourceError ? e.message : `Erga couldn't read its repository: ${(e as Error).message}` };
    }
  }

  /** A release cut, as POST /api/source/release asks: the tag, or { error, status }. */
  async release(origin: string, who: Actor, o: { version?: string; notes?: string; commit?: string } = {}): Promise<Released | { error: string; status: number }> {
    try { return await this.at(origin).release(who, o); } catch (e) {
      if (e instanceof SourceError) return { error: e.message, status: e.status };
      return { error: `The release failed: ${(e as Error).message}`, status: 502 };
    }
  }

  // A downstream's Update from upstream, and the ways out of one that conflicted (POST /api/source/update[/resolve|/finish|/abandon]).
  async update(origin: string, who: Actor): Promise<UpdateResult | { error: string; status: number }> {
    try { return await this.at(origin).update(who); } catch (e) { return SourceHost.failed(e, "The update"); }
  }
  async resolveUpdate(origin: string, who: Actor, path: string, content: string | null): Promise<{ branch: string; path: string; remaining: string[] } | { error: string; status: number }> {
    try { return await this.at(origin).resolveUpdate(who, path, content); } catch (e) { return SourceHost.failed(e, "Resolving the file"); }
  }
  async finishUpdate(origin: string, who: Actor): Promise<{ commit: string; version: string } | { error: string; status: number }> {
    try { return await this.at(origin).finishUpdate(who); } catch (e) { return SourceHost.failed(e, "Finishing the merge"); }
  }
  async abandonUpdate(origin: string): Promise<{ ok: true } | { error: string; status: number }> {
    try { await this.at(origin).abandonUpdate(); return { ok: true }; } catch (e) { return SourceHost.failed(e, "Dropping the merge"); }
  }
  /** Every branch's head (the deploys' object asks, for a target never deployed from here). */
  async heads(origin: string): Promise<Record<string, string>> { return (await this.at(origin).stagingLog()).heads; }
  /** Seeds a fork's repository with this one's history up to `commit` (erga.dev's control Worker, for an install). */
  async seedFork(origin: string, fork: { url: string; headers: Record<string, string> }, commit: string): Promise<{ ok: true } | { error: string; status: number }> {
    try { await this.at(origin).seedFork(fork, commit); return { ok: true }; } catch (e) { return SourceHost.failed(e, "Seeding the fork"); }
  }

  /** A merge, as POST /api/source/merge asks: { commit } or { error, status }. */
  async merge(origin: string, who: Actor, commit?: string): Promise<{ commit: string; fastForward: boolean; upToDate: boolean } | { error: string; status: number }> {
    try { return await this.at(origin).merge(who, commit); } catch (e) {
      if (e instanceof SourceError) return { error: e.message, status: e.status };
      return { error: `The merge failed: ${(e as Error).message}`, status: 502 };
    }
  }
}

/** A downstream's upstream (its UPSTREAM setting: erga.dev's control Worker), whose Git endpoint anyone may read; null on erga.dev's own. */
export function upstreamOf(env: Pick<Env, "UPSTREAM" | "CHANNEL">): UpstreamSource | null {
  const origin = env.UPSTREAM?.trim().replace(/\/+$/, "");
  if (!origin) return null;
  return { remote: { url: `${origin}/git/erga.git`, headers: {} }, origin, channel: env.CHANNEL?.trim() == "edge" ? "edge" : "stable" };
}
