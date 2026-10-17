// A document's site's deploys: the state machine, one for each document that
// has a site. The Durable Object (cloudflare/objects/site.ts) gives it
// storage and an alarm, and forwards the calls.
//
// When the document's published version changes, the next deploy runs a
// short time later (`delay`, 30 seconds by default), each change pushing it
// back, on the alarm. In "latest" mode a version is cut after each burst of
// edits, so a site follows the document within a minute or so; in "manual"
// mode, it follows each publish. "Deploy now" (POST /api/docs/<id>/site/deploy)
// runs it at once. A deploy that fails leaves the last good one live, and
// says why. Each deploy reads the site's row, its person's grant and the
// published version afresh, so a new consent is used at the next one. Every change of state is told to everyone who has the document
// open ({ type: "site" } on its /api/events).

import type { Fetch } from "../../deploy/pipeline.ts";
import { byLine, SYSTEM } from "../../shared/attribution.ts";
import type { Directory } from "../directory/index.ts";
import { deploySite, IDLE_SITE, removeSite, siteCloudflare, siteFiles, type SiteDeploy } from "./publish.ts";
import type { SiteOAuth, SiteRow } from "./rows.ts";

/** What the rest of the app may ask a site's deploys (the Durable Object answers, by RPC). */
export interface SiteObject {
  status(): Promise<SiteDeploy>;
  /** The document's published version changed: the next deploy runs a short time from now (debounced). */
  changed(docId: string): Promise<void>;
  /** Deploys now; answers the status (deploying). `origin`: the server's, for the note in the site's Worker. */
  deploy(docId: string, by: string, origin?: string): Promise<SiteDeploy>;
  /** Takes the site down in Cloudflare, with its person's grant, and forgets its deploys. Cloudflare's refusal, if any. */
  remove(docId: string, site: SiteRow): Promise<string | null>;
}

/** A document's published version, as a deploy reads it. */
export interface PublishedSite { index: string; files: Record<string, string | Uint8Array>; version: number | null }

/** What a site's deploys need from where they run. */
export interface SiteDeps {
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; deleteAll(): Promise<void> };
  alarm: { get(): Promise<number | null>; set(at: number): Promise<void>; delete(): Promise<void> };
  directory: Directory;
  published(docId: string): Promise<PublishedSite | null>;
  /** How to reach Cloudflare with this token: the real API, or (local development) a pretend one. */
  net(token: string): Fetch;
  /** Cloudflare's OAuth, to refresh the person's grant. */
  oauth: SiteOAuth;
  /** Tells everyone with the document open that its site's state changed. */
  notify(docId: string): void;
  delay(): number;
}

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

export class SiteDeploys implements SiteObject {
  private s: State = { ...IDLE_SITE, at: null, scheduledFor: null };
  private running = false;

  constructor(private deps: SiteDeps) {}

  /** Reads what's stored (before anything else runs); a deploy stopped in the middle (the object moved or restarted) runs again. */
  async load(): Promise<void> {
    this.s = (await this.deps.storage.get<State>(STATE)) ?? this.s;
    if (this.s.state == "deploying" && (await this.deps.alarm.get()) == null) await this.deps.alarm.set(Date.now());
  }

  async status(): Promise<SiteDeploy> {
    const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());
    return { state: this.s.state, at: iso(this.s.at), scheduledFor: iso(this.s.scheduledFor), version: this.s.version, error: this.s.state == "failed" ? this.s.error : null, by: this.s.by ?? byLine(SYSTEM) };
  }

  async changed(docId: string): Promise<void> {
    this.s.docId = docId;
    if (this.s.state == "deploying") { this.s.again = true; await this.save(); return; }
    const at = Date.now() + this.deps.delay();
    this.s = { ...this.s, state: "scheduled", scheduledFor: at, by: null };
    await this.save();
    await this.deps.alarm.set(at);
    this.deps.notify(docId);
  }

  async deploy(docId: string, by: string, origin?: string): Promise<SiteDeploy> {
    this.s.docId = docId;
    if (origin) this.s.origin = origin;
    this.s.by = by;
    if (this.s.state == "deploying") { this.s.again = true; await this.save(); return this.status(); }
    this.s = { ...this.s, state: "deploying", scheduledFor: null, error: null };
    await this.save();
    await this.deps.alarm.set(Date.now());
    this.deps.notify(docId);
    return this.status();
  }

  async remove(docId: string, site: SiteRow): Promise<string | null> {
    await this.deps.alarm.delete();
    this.s = { ...IDLE_SITE, at: null, scheduledFor: null, docId };
    await this.deps.storage.deleteAll();
    this.deps.notify(docId);
    const token = await this.deps.directory.cloudflare.token(site.login, this.deps.oauth).catch(() => null);
    if (!token) return `${site.login}'s Cloudflare connection is gone, so Erga can't reach the account.`;
    try {
      await removeSite(siteCloudflare(token, this.deps.net(token)), site);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /** The deploy itself, when its time comes (the alarm). */
  async alarm(): Promise<void> {
    if (this.running || !this.s.docId) return;
    this.running = true;
    const docId = this.s.docId;
    try {
      this.s = { ...this.s, state: "deploying", scheduledFor: null, again: false };
      await this.save();
      this.deps.notify(docId);
      const r = await this.run(docId);
      this.s = r.ok ? { ...this.s, state: "deployed", at: Date.now(), version: r.version, error: null } : { ...this.s, state: "failed", error: r.error };
    } finally {
      this.running = false;
    }
    if (this.s.again) { this.s = { ...this.s, again: false, state: "scheduled", scheduledFor: Date.now() + 1000 }; await this.deps.alarm.set(this.s.scheduledFor!); }
    await this.save();
    this.deps.notify(docId);
  }

  /** One deploy, from what the database and the document hold now. */
  private async run(docId: string): Promise<{ ok: true; version: number | null } | { ok: false; error: string }> {
    try {
      const dir = this.deps.directory;
      const [site, doc] = await Promise.all([dir.sites.get(docId), dir.get(docId)]);
      if (!site || !doc) return { ok: false, error: "The document has no site any more." };
      const token = await dir.cloudflare.token(site.login, this.deps.oauth);
      if (!token) return { ok: false, error: `${site.login}'s Cloudflare connection is gone: ${site.login} connects Cloudflare again.` };
      const published = await this.deps.published(docId);
      if (!published) return { ok: false, error: "The document has no published version yet." };
      const files = await siteFiles(published.index, published.files, doc.title);
      await deploySite(siteCloudflare(token, this.deps.net(token)), site, files, `${this.s.origin ?? ""}/${doc.owner}/${doc.slug}`);
      return { ok: true, version: published.version };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async save(): Promise<void> {
    await this.deps.storage.put(STATE, this.s);
  }
}
