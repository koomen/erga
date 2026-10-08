// Erga's repository's Durable Object: one, "erga", where every push and
// merge happens one at a time (source/repo.ts, SourceRepo), with the commit
// index and the mirror's status in its SQLite. The Worker (worker/source.ts)
// checks who's asking and hands it the request.
//
// Calls name the address the request came to (`origin`), which local
// development's stand-ins for Artifacts and GitHub live at.

import { DurableObject } from "cloudflare:workers";
import { deployHook, publishEvent } from "../deploy/index";
import { ZERO } from "../source/git";
import { byLine } from "../attribution";
import { SourceError, SourceRepo, type Actor, type MergedTask } from "../source/repo";
import { artifactsRemote, githubRemote } from "./artifacts";
import { directoryOf, keptKeys } from "./d1";
import type { Env } from "./env";
import type { GitGrant } from "../factory/git-grant";
import type { SourceAnswer, SourceRead } from "../source/browse";

export class SourceHost extends DurableObject<Env> {
  private origin = "";
  private repo: SourceRepo;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    // The mirror's token: the one an admin stored on /admin/api-keys, else the Worker secret.
    const keys = keptKeys(ctx, env);
    this.repo = new SourceRepo({
      db: { exec: <T>(q: string, ...params: (string | number | null)[]) => sql.exec(q, ...params).toArray() as T[] },
      artifacts: async () => {
        const r = await artifactsRemote(env, "write", this.origin);
        if (!r) throw new SourceError("Erga's repository isn't set up on this server (no Artifacts binding).", 503);
        return r;
      },
      // The source tools (factory/agent.ts) read with a read token: they can't write, whatever they ask.
      reader: async () => {
        const r = await artifactsRemote(env, "read", this.origin);
        if (!r) throw new SourceError("Erga's repository isn't set up on this server (no Artifacts binding).", 503);
        return r;
      },
      github: () => githubRemote(keys(), this.origin),
      moved: (m) => {
        ctx.waitUntil(publishEvent({ type: "source", branch: m.branch, commit: m.new }, env).catch(() => {}));
        ctx.waitUntil(deployHook(m.branch, m.new, env, `${m.how} by ${byLine(m.by, m.via)}`).catch((e) => console.error(`deploy hook (${m.branch}):`, e)));
        // staging moved by a push past the staging rule (an admin's override): in the change log, with the reason.
        if (m.branch == "staging" && m.override) {
          ctx.waitUntil((async () => {
            const change = { key: "staging", from: m.old == ZERO ? null : m.old, to: m.new, release: { ...this.repo.newCommits(m.old, m.new), override: m.override } };
            await directoryOf(env).config.record(m.by, [change], m.at, m.via ?? null);
          })().catch((e) => console.error("change log (staging):", e)));
        }
        // main moved: the production deploy, in the change log (/admin/changes), with the commits it brought.
        if (m.branch == "main") {
          ctx.waitUntil((async () => {
            const change = { key: "main", from: m.old == ZERO ? null : m.old, to: m.new, release: { ...this.repo.newCommits(m.old, m.new), ...(m.override ? { override: m.override } : {}) } };
            await directoryOf(env).config.record(m.by, [change], m.at, m.via ?? null);
          })().catch((e) => console.error("change log (main):", e)));
        }
      },
      changed: () => ctx.waitUntil(publishEvent({ type: "source" }, env).catch(() => {})),
      // The production gate (deploy/gate.ts): main only to a commit whose full test run passed. The Pipeline object has
      // it (staging's server, and locally) or asks staging's server (production); one that can't tell refuses.
      gate: async (commit) => {
        const v = await env.PIPELINE.getByName("deploys").gateVerdict(commit).catch((e: Error) => ({ ok: false, reason: `Production deploys only a staging commit whose full test run passed, and the test results couldn't be read (${e.message}).` }));
        return v.ok ? null : `${v.reason ?? "The tests haven't passed."} See ${this.origin || "the Factory page"}${this.origin ? "/admin/factory" : ""}#tests-${commit.slice(0, 12)} (GET /api/gate/${commit}).`;
      },
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
      // The Worker checked the factory token's signature (worker/source.ts) before it sent the grant here.
      const grant = JSON.parse(request.headers.get("x-erga-grant") ?? "null") as GitGrant | null;
      return new Response(await repo.receive(new Uint8Array(await request.arrayBuffer()), actor, grant ?? undefined) as BodyInit, { headers: { "Content-Type": "application/x-git-receive-pack-result" } });
    } catch (e) {
      return new Response(`${(e as Error).message}\n`, { status: e instanceof SourceError ? e.status : 502 });
    }
  }

  advertise(origin: string, grant?: GitGrant) { return this.at(origin).advertise(grant); }
  /** `merged`: the board's merged tasks, each by its commit on staging (the Source page's task cards). */
  branches(origin: string, merged: MergedTask[] = []) { return this.at(origin).branches(merged); }

  /** An admin's override of the staging rule (an admin in a browser: worker/source.ts checks it), with a reason, or { error }. */
  async allowStagingPush(origin: string, who: Actor, reason: string): Promise<{ login: string; reason: string; until: number } | { error: string; status: number }> {
    const repo = this.at(origin);
    try {
      const o = repo.allowStagingPush(who, reason);
      await directoryOf(this.env).config.record(who.login, [{ key: "staging", from: null, to: null, stagingOverride: { reason: o.reason, until: o.until } }], o.at, who.via ?? null);
      return o;
    } catch (e) {
      return { error: (e as Error).message, status: e instanceof SourceError ? e.status : 502 };
    }
  }
  /** `by`: who asked (attribution.ts, byLine). */
  mirrorNow(origin: string, by?: string) { return this.at(origin).mirror(by); }
  files(origin: string, commit: string) { return this.at(origin).files(commit); }

  /** The factory's agent reading the source (source/browse.ts): the answer, or { error } it can act on. */
  async read(origin: string, q: SourceRead): Promise<SourceAnswer | { error: string }> {
    try { return await this.at(origin).read(q); } catch (e) {
      return { error: e instanceof SourceError ? e.message : `Erga couldn't read its repository: ${(e as Error).message}` };
    }
  }

  /** The factory: the branches and staging's newest commits (SourceRepo.stagingLog), or { error }. */
  async stagingLog(origin: string): Promise<{ heads: Record<string, string>; commits: { sha: string; subject: string }[]; merges: Record<string, string> } | { error: string }> {
    try { return await this.at(origin).stagingLog(); } catch (e) { return { error: (e as Error).message }; }
  }

  /** A merge, as POST /api/source/merge asks: { commit } or { error, status }. */
  async merge(origin: string, who: Actor, commit?: string, override?: string): Promise<{ commit: string; fastForward: boolean; upToDate: boolean; override?: boolean } | { error: string; status: number }> {
    try { return await this.at(origin).merge(who, commit, override); } catch (e) {
      if (e instanceof SourceError) return { error: e.message, status: e.status };
      return { error: `The merge failed: ${(e as Error).message}`, status: 502 };
    }
  }
}
