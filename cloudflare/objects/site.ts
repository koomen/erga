// A document's site's deploys, as a Durable Object (one per document that has
// a site, named by the document's id): the Cloudflare side of
// server/sites/deploys.ts. It gives the deploys their storage and alarm, and
// forwards the calls the Worker makes (RPC).

import { DurableObject } from "cloudflare:workers";
import { SiteDeploys, type SiteObject, type SiteRow } from "../../server/sites/index.ts";
import { directoryOf } from "../d1";
import type { Env } from "../env";
import { currentFiles } from "../current-files";
import { siteNet, siteOAuth } from "../sites";
import { documentOf } from "../document-host";

const DELAY_MS = 30_000;

export class SiteHost extends DurableObject<Env> implements SiteObject {
  private deploys = new SiteDeploys({
    storage: { get: (key) => this.ctx.storage.get(key), put: (key, value) => this.ctx.storage.put(key, value), deleteAll: () => this.ctx.storage.deleteAll() },
    alarm: { get: () => this.ctx.storage.getAlarm(), set: (at) => this.ctx.storage.setAlarm(at), delete: () => this.ctx.storage.deleteAlarm() },
    directory: directoryOf(this.env),
    current: (docId) => currentFiles(this.env, docId),
    net: (token) => siteNet(this.env, token),
    oauth: siteOAuth(this.env),
    notify: (docId) => { this.ctx.waitUntil(documentOf(this.env, docId).notify({ type: "site" }).catch(() => {})); },
    delay: () => { const ms = Number(this.env.ERGA_SITE_DELAY_MS); return ms > 0 ? ms : DELAY_MS; },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => this.deploys.load());
  }

  status() { return this.deploys.status(); }
  changed(docId: string) { return this.deploys.changed(docId); }
  deploy(docId: string, by: string, origin?: string) { return this.deploys.deploy(docId, by, origin); }
  remove(docId: string, site: SiteRow) { return this.deploys.remove(docId, site); }
  alarm() { return this.deploys.alarm(); }
}
