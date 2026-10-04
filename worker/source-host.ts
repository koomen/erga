// Erga's repository's Durable Object: one, "erga", where every push and
// merge happens one at a time (source/repo.ts, SourceRepo), with the commit
// index and the mirror's status in its SQLite. The Worker (worker/source.ts)
// checks who's asking and hands it the request.
//
// Calls name the address the request came to (`origin`), which local
// development's stand-ins for Artifacts and GitHub live at.

import { DurableObject } from "cloudflare:workers";
import { deployHook } from "../deploy/index";
import { SourceError, SourceRepo, type Actor } from "../source/repo";
import { artifactsRemote, githubRemote } from "./artifacts";
import type { Env } from "./env";
import { publishEvent } from "./events";

export class SourceHost extends DurableObject<Env> {
  private origin = "";
  private repo: SourceRepo;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.repo = new SourceRepo({
      db: { exec: <T>(q: string, ...params: (string | number | null)[]) => sql.exec(q, ...params).toArray() as T[] },
      artifacts: async () => {
        const r = await artifactsRemote(env, "write", this.origin);
        if (!r) throw new SourceError("Erga's repository isn't set up on this server (no Artifacts binding).", 503);
        return r;
      },
      github: () => githubRemote(env, this.origin),
      moved: (m) => {
        ctx.waitUntil(publishEvent(env, { type: "source", branch: m.branch, commit: m.new }));
        ctx.waitUntil(deployHook(m.branch, m.new, { env }).catch((e) => console.error(`deploy hook (${m.branch}):`, e)));
      },
      changed: () => ctx.waitUntil(publishEvent(env, { type: "source" })),
      background: (work) => ctx.waitUntil(work),
    });
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
  mirrorNow(origin: string) { return this.at(origin).mirror(); }
  files(origin: string, commit: string) { return this.at(origin).files(commit); }

  /** A merge, as POST /api/source/merge asks: { commit } or { error, status }. */
  async merge(origin: string, who: Actor, commit?: string): Promise<{ commit: string; fastForward: boolean; upToDate: boolean } | { error: string; status: number }> {
    try { return await this.at(origin).merge(who, commit); } catch (e) {
      if (e instanceof SourceError) return { error: e.message, status: e.status };
      return { error: `The merge failed: ${(e as Error).message}`, status: 502 };
    }
  }
}
