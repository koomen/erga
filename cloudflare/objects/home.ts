// The homepage's deploys, as a Durable Object (one, named "home"): the
// Cloudflare side of server/home/deploys.ts. It gives the deploys their
// storage and alarm, and forwards the calls the Worker makes (RPC).

import { DurableObject } from "cloudflare:workers";
import { mimeOf } from "../../document/host";
import { HomeDeploys, type HomeObject } from "../../server/home/index.ts";
import { directoryOf } from "../d1";
import type { Env } from "../env";
import { currentFiles } from "../current-files";
import { documentOf } from "../document-host";

const FIVE_MINUTES = 5 * 60 * 1000;

export class Home extends DurableObject<Env> implements HomeObject {
  private deploys = new HomeDeploys({
    storage: {
      get: (key) => this.ctx.storage.get(key),
      put: ((a: string | Record<string, unknown>, b?: unknown) => (typeof a == "string" ? this.ctx.storage.put(a, b) : this.ctx.storage.put(a))) as HomeDeploys["deps"]["storage"]["put"],
      delete: (keys) => this.ctx.storage.delete(keys as string[]),
      list: async (prefix) => [...(await this.ctx.storage.list({ prefix })).keys()],
    },
    alarm: { get: () => this.ctx.storage.getAlarm(), set: (at) => this.ctx.storage.setAlarm(at), delete: () => this.ctx.storage.deleteAlarm() },
    directory: directoryOf(this.env),
    current: (docId) => currentFiles(this.env, docId),
    notify: (docId) => documentOf(this.env, docId).notify({ type: "home" }),
    delay: () => { const ms = Number(this.env.ERGA_HOME_DELAY_MS); return ms > 0 ? ms : FIVE_MINUTES; },
    mimeOf,
    testFailures: !!this.env.ERGA_LINK_SECRET,
    log: (line) => console.log(line),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => this.deploys.load());
  }

  status() { return this.deploys.status(); }
  changed(docId: string) { return this.deploys.changed(docId); }
  deploy(by?: string) { return this.deploys.deploy(by); }
  homeChanged() { return this.deploys.homeChanged(); }
  ensure() { return this.deploys.ensure(); }
  forget(docId: string) { return this.deploys.forget(docId); }
  page(known?: string | null) { return this.deploys.page(known); }
  file(gen: string, path: string) { return this.deploys.file(gen, path); }
  alarm() { return this.deploys.alarm(); }
}
