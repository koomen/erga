// A domain's publishing, as a Durable Object (one for each domain, named by the domain): the Cloudflare side of
// server/sites/publishing.ts. It gives the publishing its storage and alarm, and forwards the calls the Worker makes (RPC).
//
// Trap: the class is exported as `Home`, bound as HOME, and the Erga domain's object is named "home" (cloudflare/platform.ts,
// siteOf). Those names are the objects' storage: a namespace can't be renamed with what it holds, and the Erga domain's
// holds the live snapshot.

import { DurableObject } from "cloudflare:workers";
import { mimeOf } from "../../document/api/view";
import { Publishing, type SiteObject } from "../../server/sites/index.ts";
import { directoryOf } from "../d1";
import type { Env } from "../env";
import { documentOf } from "./document-stub";

/** A document's files as they are now: its page, its files and its current version's number; null if there's no such document. */
async function currentFiles(
  env: Env,
  docId: string
): Promise<{ index: string; files: Record<string, string | Uint8Array>; version: number | null } | null> {
  const r = await documentOf(env, docId).currentFiles();
  return r && { index: r.index, files: Object.fromEntries(r.files), version: r.version.n };
}

export class Home extends DurableObject<Env> implements SiteObject {
  private publishing = new Publishing({
    storage: {
      get: (key) => this.ctx.storage.get(key),
      put: ((a: string | Record<string, unknown>, b?: unknown) =>
        typeof a == "string" ? this.ctx.storage.put(a, b) : this.ctx.storage.put(a)) as Publishing["deps"]["storage"]["put"],
      delete: (keys) => this.ctx.storage.delete(keys as string[]),
      list: async (prefix) => [...(await this.ctx.storage.list({ prefix })).keys()],
    },
    alarm: { set: (at) => this.ctx.storage.setAlarm(at), delete: () => this.ctx.storage.deleteAlarm() },
    document: (docId) => directoryOf(this.env).get(docId),
    current: (docId) => currentFiles(this.env, docId),
    notify: (docId) => documentOf(this.env, docId).notify({ type: "publishing" }),
    mimeOf,
    testFailures: !!this.env.ERGA_LINK_SECRET,
    log: (line) => console.log(line),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => this.publishing.load());
  }

  status() {
    return this.publishing.status();
  }
  link(o: Parameters<SiteObject["link"]>[0]) {
    return this.publishing.link(o);
  }
  publish(doc: string, by: string) {
    return this.publishing.publish(doc, by);
  }
  unlink(doc: string) {
    return this.publishing.unlink(doc);
  }
  forget(doc: string) {
    return this.publishing.forget(doc);
  }
  served(known?: string | null) {
    return this.publishing.served(known);
  }
  file(gen: string, path: string) {
    return this.publishing.file(gen, path);
  }
  alarm() {
    return this.publishing.alarm();
  }
}
