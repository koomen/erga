// The homepage's API for a document: whether it is the homepage, who may
// change that, and its deploys.
//
//   GET  /api/docs/<id>/home          { isHome, canSet, blocked, deploy }
//   POST /api/docs/<id>/home          { isHome: boolean }: admins; sets or clears landing_document
//   POST /api/docs/<id>/home/deploy   admins: deploys the homepage again, now

import { byLine } from "../../shared/attribution.ts";
import { ConfigError, LOCKED, NotAllowed, roleMay } from "../directory/index.ts";
import { fromElsewhere } from "../pages/index.ts";
import { whoOf, type Platform } from "../platform.ts";
import { IDLE } from "./render.ts";
import { forgetHome } from "./serve.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * The homepage's API for a document (`id`): whether it's the homepage, who
 * may change that, and its deploys. `action` is "" (/home) or "deploy"
 * (/home/deploy).
 */
export async function homeApi(request: Request, platform: Platform, id: string, action: "" | "deploy"): Promise<Response> {
  const url = new URL(request.url);
  const deploys = platform.home;
  // The homepage changed through this isolate: it forgets the snapshot it serves.
  const after = () => { platform.edge.background(forgetHome(platform, url)); };
  const session = await platform.sessionOf(request);
  if (!session) return json({ error: "Sign in first." }, 401);
  const dir = platform.directory;
  const doc = await dir.get(id);
  const who = whoOf(session);
  const [role, admin, unlocked] = await Promise.all([doc ? dir.access(who, doc) : null, session.test ? false : dir.users.isAdmin(who), session.test ? false : dir.users.actsAsAdmin(who)]);
  if (!doc || doc.test || (!role && !admin)) return json({ error: "There's no such document." }, 404);
  const state = async () => {
    const isHome = (await dir.homeId()) == doc.id;
    // An admin acting through a token without the admin scope is told so (locked), and can't set it with that token.
    const canSet = unlocked && !dir.config.isLocked("landing_document") && roleMay(await dir.access(who, doc), "edit");
    return { isHome, canSet, locked: admin && !unlocked, blocked: isHome ? null : await dir.homeBlocked(doc.id), deploy: isHome ? await deploys.status() : IDLE };
  };
  if (request.method == "GET" || request.method == "HEAD") {
    if (action) return json({ error: "Not found" }, 404);
    return json(await state());
  }
  if (request.method != "POST") return json({ error: "GET or POST" }, 405);
  // Another site may not do this on someone's behalf (an agent's token is its own proof).
  if (!session.agent && (fromElsewhere(request) || (request.headers.has("origin") && request.headers.get("origin") != url.origin))) return json({ error: "Not from this site." }, 403);
  if (!admin) return json({ error: "Only an admin can choose the homepage or deploy it." }, 403);
  if (!unlocked) return json({ error: LOCKED, locked: true }, 403);
  if (action == "deploy") {
    if ((await dir.homeId()) != doc.id) return json({ error: "This document isn't the homepage." }, 409);
    await deploys.deploy(byLine(who.login, who.via));
    after?.();
    return json(await state());
  }
  let body: { isHome?: unknown };
  try { body = await request.json() as { isHome?: unknown }; } catch { return json({ error: 'Send JSON: {"isHome": true} or {"isHome": false}.' }, 400); }
  if (typeof body?.isHome != "boolean") return json({ error: 'Send JSON: {"isHome": true} or {"isHome": false}.' }, 400);
  if (dir.config.isLocked("landing_document")) return json({ error: "The homepage is fixed by the deploy (deploy/locked-settings.ts), so it can't be changed here." }, 409);
  const isHome = (await dir.homeId()) == doc.id;
  try {
    if (body.isHome && !isHome) await dir.config.set(who, "landing_document", doc.id);
    else if (!body.isHome && isHome) await dir.config.reset(who, "landing_document");
  } catch (e) {
    if (e instanceof NotAllowed) return json({ error: e.message }, 403);
    if (e instanceof ConfigError) return json({ error: e.message }, 400);
    throw e;
  }
  after?.();
  return json(await state());
}
