// The homepage's API for a document: whether it is the homepage, and its
// deploys. The homepage is chosen on /admin (the landing_document setting),
// never from the document.
//
//   GET  /api/docs/<id>/home          { isHome, canDeploy, locked, deploy }
//   POST /api/docs/<id>/home/deploy   admins: deploys the homepage again, now

import * as Effect from "effect/Effect";
import { byLine } from "../../shared/attribution.ts";
import { LOCKED } from "../directory/index.ts";
import { fromElsewhere } from "../pages/index.ts";
import { whoOf, type Platform } from "../platform.ts";
import { IDLE } from "./render.ts";
import { forgetHome } from "./serve.ts";
import { call, ctx, json } from "../http.ts";


/**
 * The homepage's API for a document (`id`): whether it's the homepage, and
 * its deploys. `action` is "" (/home) or "deploy" (/home/deploy).
 */
export const homeApi = (id: string, action: "" | "deploy") =>
  Effect.gen(function* () {
    const { request, url, platform } = yield* ctx;
  const deploys = platform.home;
  // The homepage deployed through this isolate: it forgets the snapshot it serves.
  const after = () => { platform.edge.background(forgetHome(platform, url)); };
  const session = yield* call(() => platform.sessionOf(request));
  if (!session) return json({ error: "Sign in first." }, 401);
  const dir = platform.directory;
  const doc = yield* call(() => dir.get(id));
  const who = whoOf(session);
  const [role, admin, unlocked] = yield* call(() =>
    Promise.all([doc ? dir.access(who, doc) : null, dir.users.isAdmin(who), dir.users.actsAsAdmin(who)])
  );
  if (!doc || doc.test || (!role && !admin)) return json({ error: "There's no such document." }, 404);
  const state = () =>
    call(async () => {
    const isHome = (await dir.homeId()) == doc.id;
    // An admin acting through a token without the admin scope is told so (locked), and can't deploy with that token.
    return { isHome, canDeploy: isHome && unlocked, locked: admin && !unlocked, deploy: isHome ? await deploys.status() : IDLE };
  });
  if (request.method == "GET" || request.method == "HEAD") {
    if (action) return json({ error: "Not found" }, 404);
    return json(yield* state());
  }
  if (request.method != "POST" || action != "deploy") return json({ error: "GET, or POST to /home/deploy. Choose the homepage on /admin (the landing_document setting)." }, 405);
  // Another site may not do this on someone's behalf (an agent's token is its own proof).
  if (!session.agent && (fromElsewhere(request) || (request.headers.has("origin") && request.headers.get("origin") != url.origin))) return json({ error: "Not from this site." }, 403);
  if (!admin) return json({ error: "Only an admin can deploy the homepage." }, 403);
  if (!unlocked) return json({ error: LOCKED, locked: true }, 403);
  if ((yield* call(() => dir.homeId())) != doc.id) return json({ error: "This document isn't the homepage." }, 409);
  yield* call(() => deploys.deploy(byLine(who.login, who.via)));
  after();
  return json(yield* state());
});
