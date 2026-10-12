// Documents' sites on Cloudflare: how the Worker reaches each site's deploys
// (one Durable Object per document that has a site, named by the document's
// id) and Cloudflare itself. In local development with ERGA_DEPLOY_MOCK=1, a
// token that starts with "mock-" talks to a pretend Cloudflare, whose sites
// the dev server shows at /__erga/site/<hostname>/<path>.

import type { Fetch } from "../deploy/pipeline";
import { mockCloudflare, mockSite } from "../deploy/mock-cloudflare";
import type { SiteOps } from "../server/sites/index.ts";
import { directoryOf } from "./d1";
import type { Env } from "./env";

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

/** A document's published version changed: if it has a site, its next deploy is scheduled (the document's object calls this). */
export async function siteChanged(env: Env, docId: string): Promise<void> {
  if (await directoryOf(env).sites.get(docId)) await env.SITES.getByName(docId).changed(docId);
}
