// The site API for a document: its connection and site, publishing it to a
// hostname, deploying again, taking it down.
//
//   GET    /api/docs/<id>/site          { canEdit, connection, site, deploy, tokenUrl } (?zones=1 adds your domains)
//   POST   /api/docs/<id>/site          { hostname }: publishes the document there, with your Cloudflare connection
//   POST   /api/docs/<id>/site/deploy   deploys the published version again, now
//   DELETE /api/docs/<id>/site          takes the site down: its custom domain and its Worker go from the account

import { DeployError } from "../../deploy/pipeline.ts";
import { byLine } from "../../shared/attribution.ts";
import { roleMay } from "../directory/index.ts";
import { fromElsewhere } from "../pages/index.ts";
import { whoOf, type Platform } from "../platform.ts";
import { IDLE_SITE, publishTo, SITE_PERMISSIONS, siteView, tokenTemplateUrl, zonesOf } from "./publish.ts";
import { SiteError } from "./rows.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });


/**
 * The site's API for a document (`id`): `action` is "" (/site) or "deploy"
 * (/site/deploy).
 */
export async function siteApi(request: Request, platform: Platform, id: string, action: "" | "deploy"): Promise<Response> {
  const url = new URL(request.url);
  const ops = platform.sites?.(url.origin);
  if (!ops) return json({ error: "This server doesn't publish documents to domains." }, 503);
  const session = await platform.sessionOf(request);
  if (!session) return json({ error: "Sign in first." }, 401);
  if (session.test) return json({ error: "Test people can't publish to a domain." }, 403);
  const dir = platform.directory;
  const doc = await dir.get(id);
  const who = whoOf(session);
  const role = doc ? await dir.access(who, doc) : null;
  if (!doc || doc.test || !role) return json({ error: "There's no such document." }, 404);
  const canEdit = roleMay(role, "edit");
  const state = async (extra: Record<string, unknown> = {}) => {
    const site = await dir.sites.get(doc.id);
    const connection = await dir.cloudflare.info(session.login);
    return { canEdit, connection, site: site && siteView(site), deploy: site ? await ops.status(doc.id) : IDLE_SITE, tokenUrl: tokenTemplateUrl(), permissions: SITE_PERMISSIONS, ...extra };
  };
  if (request.method == "GET" || request.method == "HEAD") {
    if (action) return json({ error: "Not found" }, 404);
    if (url.searchParams.get("zones") != "1") return json(await state());
    const r = await zonesOf(dir, ops, session.login);
    return json(await state("error" in r ? { zonesError: r.error } : { zones: r.zones }));
  }
  if (!["POST", "DELETE"].includes(request.method)) return json({ error: "GET, POST or DELETE" }, 405);
  // Another site may not do this on someone's behalf (an agent's token is its own proof).
  if (!session.agent && (fromElsewhere(request) || (request.headers.has("origin") && request.headers.get("origin") != url.origin))) return json({ error: "Not from this site." }, 403);
  if (!canEdit) return json({ error: "Only the document's editors can publish it to a domain." }, 403);
  const by = byLine(who.login, who.via);
  try {
    if (request.method == "DELETE") {
      if (action) return json({ error: "Not found" }, 404);
      const site = await dir.sites.get(doc.id);
      if (!site) return json(await state());
      const refused = await ops.remove(doc.id, site);
      await dir.sites.remove(doc.id);
      return json(await state(refused ? { warning: `Erga no longer publishes to ${site.hostname}, but Cloudflare didn't take the site down: ${refused} Delete the Worker ${site.script} in your Cloudflare dashboard to take it down.` } : {}));
    }
    if (action == "deploy") {
      if (!(await dir.sites.get(doc.id))) return json({ error: "This document isn't published to a domain." }, 409);
      await ops.deploy(doc.id, by);
      return json(await state());
    }
    const body = (await request.json().catch(() => null)) as { hostname?: unknown } | null;
    if (typeof body?.hostname != "string") return json({ error: 'Send JSON: {"hostname": "notes.example.com"}.' }, 400);
    await publishTo(dir, ops, doc, session.login, body.hostname, who.via);
    await ops.deploy(doc.id, by);
    return json(await state());
  } catch (e) {
    if (e instanceof SiteError) return json({ error: e.message }, e.status);
    if (e instanceof DeployError) return json({ error: e.message }, 502);
    throw e;
  }
}
