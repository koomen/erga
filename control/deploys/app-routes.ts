// The app Worker's own deploy routes: what the deploy pipeline (in the
// control Worker) asks of a server it deploys, and what staging's data copy
// goes through. The deploys' API itself (/api/deploys, /api/events) is the
// control Worker's (control/deploys/api.ts); in local development the app
// hosts it too (cloudflare/index.ts).
//
//   GET  /api/deploys/version           anyone: {version, target}, the release this server runs (the pipeline waits for it)
//   GET  /api/health                    anyone: {ok, version, target, checks}: the app works (server/health.ts); 503 when it doesn't
//   POST /api/snapshot/docs[/import]    SNAPSHOT_TOKEN: read documents' storage (any server), write it (staging only)
//   GET  /api/snapshot/blob/<sha-256>   SNAPSHOT_TOKEN: one of the documents' blobs (any server), read-only

import { snapshotDoor } from "../../document/snapshot";
import { PRODUCTION } from "../../deploy/targets";
import { health } from "../../server/health";
import type { Platform } from "../../server/platform";
import type { Env } from "../../cloudflare/env";
import { documentOf } from "../../cloudflare/objects/document-stub";
import { snapshotBlob } from "../../cloudflare/blobs";
import { json } from "../../shared/http";

/** Whether this path is one of these routes. */
export const isDeploysPath = (path: string) => path == "/api/deploys/version" || path == "/api/health" || path.startsWith("/api/snapshot/");

export async function deploysDoor(request: Request, env: Env, platform: Platform): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  if (path == "/api/deploys/version" && (method == "GET" || method == "HEAD")) return Response.json({ version: env.ERGA_VERSION ?? null, target: env.DEPLOY_TARGET || null }, { headers: { "Cache-Control": "no-store" } });
  if (path == "/api/health" && (method == "GET" || method == "HEAD")) {
    const h = await health(platform);
    return json(h, h.ok ? 200 : 503);
  }
  // One blob, for staging's copy of production's documents (cloudflare/blobs.ts).
  const blob = await snapshotBlob(request, env);
  if (blob) return blob;
  if (path.startsWith("/api/snapshot/")) {
    // Never into production, whatever its settings say.
    const production = env.DEPLOY_TARGET == "production" || url.hostname == PRODUCTION.host;
    return (await snapshotDoor(request, {
      token: env.SNAPSHOT_TOKEN,
      importAllowed: env.SNAPSHOT_IMPORT == "1" && !production,
      store: {
        export: (id, page) => documentOf(env, id).exportStorage(id, page),
        import: (snap) => documentOf(env, snap.id).importStorage(snap),
        wipe: (id) => documentOf(env, id).wipeStorage(),
      },
    })) ?? Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ error: `There's nothing at ${method} ${path}.` }, { status: 404 });
}
