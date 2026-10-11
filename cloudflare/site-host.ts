// A document's site on Cloudflare (server/site-publish.ts has the design): its
// deploys, in one Durable Object for each document that has a site, named by
// the document's id.
//
// When the document's published version changes (cloudflare/doc-host.ts tells
// it), the next deploy runs a short time later (ERGA_SITE_DELAY_MS, 30
// seconds by default), each change pushing it back, on the object's alarm.
// In "latest" mode a version is cut after each burst of edits, so a site
// follows the document within a minute or so; in "manual" mode, it follows
// each publish. "Deploy now" (POST /api/docs/<id>/site/deploy) runs it at
// once. A deploy that fails leaves the last good one live, and says why.
//
// Each deploy reads the site's row, its person's token and the published
// version afresh, so a token replaced on /settings is used at the next one.
// Every change of state is told to everyone who has the document open
// ({ type: "site" } on its /api/events).
//
// In local development with ERGA_DEPLOY_MOCK=1, a token that starts with
// "mock-" talks to a pretend Cloudflare, whose sites the dev
// server shows at /__erga/site/<hostname>/<path>.

import { DurableObject } from "cloudflare:workers";
import { Cloudflare, type Fetch } from "../deploy/pipeline";
import { mockCloudflare, mockSite } from "../deploy/mock-cloudflare";
import { byLine, SYSTEM } from "../shared/attribution";
import { deploySite, IDLE_SITE, removeSite, siteFiles, type SiteDeploy, type SiteOps } from "../server/site-publish";
import type { SiteRow } from "../server/sites";
import { directoryOf } from "./d1";
import type { Env } from "./env";
import { publishedFiles } from "./published";

interface State {
  state: SiteDeploy["state"];
  at: number | null;
  scheduledFor: number | null;
  version: number | null;
  error: string | null;
  by: string | null;
  /** Deploy again as soon as the one under way is done (it was asked for meanwhile). */
  again?: boolean;
  /** The document's id (the object's name, which it can't read). */
  docId?: string;
  /** The server's origin, from the latest request that asked for a deploy (for the note in the site's Worker). */
  origin?: string;
}

const STATE = "state";
const DELAY_MS = 30_000;

/** The pretend Cloudflare (local development only): one for the whole isolate, so every document's sites share one account. */
let mock: ReturnType<typeof mockCloudflare> | null = null;
const mockOn = (env: Env) => env.ERGA_DEPLOY_MOCK == "1";
const mockNet = () => (mock ??= mockCloudflare({ delayMs: 60 })).fetch;

/** How to reach Cloudflare with a token: the pretend one for a "mock-" token while ERGA_DEPLOY_MOCK=1, else the real API. */
export function siteNet(env: Env, token: string): Fetch {
  return mockOn(env) && token.startsWith("mock-") ? mockNet() : globalThis.fetch.bind(globalThis);
}

/** A site on the pretend Cloudflare, as a reader would see it (local development only). */
export function mockSiteFile(env: Env, hostname: string, path: string): Response | null {
  if (!mockOn(env) || !mock) return null;
  const file = mockSite(mock.state, hostname, path);
  if (!file) return null;
  const ext = /\.([^./]+)$/.exec(file.path)?.[1] ?? "";
  const types: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css", js: "application/javascript", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", json: "application/json" };
  return new Response(file.bytes, { headers: { "Content-Type": types[ext] ?? "application/octet-stream", "Cache-Control": "no-store" } });
}

/** The site API's view of the deploys, as `origin`'s server. */
export function siteOps(env: Env, origin: string): SiteOps {
  const host = (docId: string) => env.SITES.getByName(docId);
  return {
    net: (token) => siteNet(env, token),
    status: (docId) => host(docId).status(),
    deploy: (docId, by) => host(docId).deploy(docId, by, origin),
    remove: (docId, site) => host(docId).remove(docId, site),
  };
}

/** A document's published version changed: if it has a site, its next deploy is scheduled (cloudflare/doc-host.ts calls this). */
export async function siteChanged(env: Env, docId: string): Promise<void> {
  if (await directoryOf(env).sites.get(docId)) await env.SITES.getByName(docId).changed(docId);
}

export class SiteHost extends DurableObject<Env> {
  private s: State = { ...IDLE_SITE, at: null, scheduledFor: null };
  private running = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get<State>(STATE)) ?? this.s;
      // Stopped in the middle of a deploy (the object moved or restarted): it runs again.
      if (this.s.state == "deploying" && (await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(Date.now());
    });
  }

  private delay(): number {
    const ms = Number(this.env.ERGA_SITE_DELAY_MS);
    return ms > 0 ? ms : DELAY_MS;
  }

  async status(): Promise<SiteDeploy> {
    const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());
    return { state: this.s.state, at: iso(this.s.at), scheduledFor: iso(this.s.scheduledFor), version: this.s.version, error: this.s.state == "failed" ? this.s.error : null, by: this.s.by ?? byLine(SYSTEM) };
  }

  /** The document's published version changed: the next deploy runs a short time from now (debounced). */
  async changed(docId: string): Promise<void> {
    this.s.docId = docId;
    if (this.s.state == "deploying") { this.s.again = true; await this.save(); return; }
    const at = Date.now() + this.delay();
    this.s = { ...this.s, state: "scheduled", scheduledFor: at, by: null };
    await this.save();
    await this.ctx.storage.setAlarm(at);
    this.tell(docId);
  }

  /** Deploys now; answers the status (deploying). */
  async deploy(docId: string, by: string, origin?: string): Promise<SiteDeploy> {
    this.s.docId = docId;
    if (origin) this.s.origin = origin;
    this.s.by = by;
    if (this.s.state == "deploying") { this.s.again = true; await this.save(); return this.status(); }
    this.s = { ...this.s, state: "deploying", scheduledFor: null, error: null };
    await this.save();
    await this.ctx.storage.setAlarm(Date.now());
    this.tell(docId);
    return this.status();
  }

  /** Takes the site down in Cloudflare, with its person's token, and forgets its deploys. Cloudflare's refusal, if any. */
  async remove(docId: string, site: SiteRow): Promise<string | null> {
    await this.ctx.storage.deleteAlarm();
    this.s = { ...IDLE_SITE, at: null, scheduledFor: null, docId };
    await this.ctx.storage.deleteAll();
    this.tell(docId);
    const token = await directoryOf(this.env).cloudflare.token(site.login).catch(() => null);
    if (!token) return `${site.login}'s Cloudflare connection is gone, so Erga can't reach the account.`;
    try {
      await removeSite(new Cloudflare(token, siteNet(this.env, token)), site);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async alarm(): Promise<void> {
    if (this.running || !this.s.docId) return;
    this.running = true;
    const docId = this.s.docId;
    try {
      this.s = { ...this.s, state: "deploying", scheduledFor: null, again: false };
      await this.save();
      this.tell(docId);
      const r = await this.run(docId);
      this.s = r.ok ? { ...this.s, state: "deployed", at: Date.now(), version: r.version, error: null } : { ...this.s, state: "failed", error: r.error };
    } finally {
      this.running = false;
    }
    if (this.s.again) { this.s = { ...this.s, again: false, state: "scheduled", scheduledFor: Date.now() + 1000 }; await this.ctx.storage.setAlarm(this.s.scheduledFor!); }
    await this.save();
    this.tell(docId);
  }

  /** One deploy, from what the database and the document hold now. */
  private async run(docId: string): Promise<{ ok: true; version: number | null } | { ok: false; error: string }> {
    try {
      const dir = directoryOf(this.env);
      const [site, doc] = await Promise.all([dir.sites.get(docId), dir.get(docId)]);
      if (!site || !doc) return { ok: false, error: "The document has no site any more." };
      const token = await dir.cloudflare.token(site.login);
      if (!token) return { ok: false, error: `${site.login}'s Cloudflare connection is gone. ${site.login} must connect Cloudflare again on /settings.` };
      const published = await publishedFiles(this.env, docId);
      if (!published) return { ok: false, error: "The document has no published version yet." };
      const files = await siteFiles(published.index, published.files, doc.title);
      await deploySite(new Cloudflare(token, siteNet(this.env, token)), site, files, `${this.s.origin ?? ""}/${doc.owner}/${doc.slug}`);
      return { ok: true, version: published.version };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put(STATE, this.s);
  }

  /** Everyone with the document open hears that its site's state changed. */
  private tell(docId: string): void {
    this.ctx.waitUntil(this.env.DOCS.getByName(docId).notify({ type: "site" }).catch(() => {}));
  }
}
