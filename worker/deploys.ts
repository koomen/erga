// The branch deploys' routes (deploy/branches.ts, in worker/pipeline.ts), and
// the snapshot endpoints staging copies production's documents through
// (deploy/snapshot.ts):
//
//   GET  /api/deploys[?history=N]       admins: every target's status {targets: [...]}, with each one's last N deploys
//                                       (`history`, newest first) if asked
//   POST /api/deploys/<name>            admins: redeploy that target's branch head now; {fresh: true}: staging with a
//                                       fresh copy of production's data, however new its copy is
//   GET  /api/deploys/<name>/history[?limit=N]
//                                       admins (or another of Erga's servers): the last N deploys (default 20, at most
//                                       100) {target, deploys: [{id, commit, state, started, ended, trigger, error, live, ...}]}
//   GET  /api/deploys/<name>/log[?deploy=<id>]
//                                       admins (or another of Erga's servers): the latest deploy's whole log, or that
//                                       deploy's {deployId, commit, state, trigger, started, ended, error, live, lines: [{at, text, step?}]}
//   GET  /api/events                    admins: server-sent events, {type: "deploys"} on each change, {type: "deploy-log",
//                                       target, deployId, lines} as a deploy's lines arrive ({type: "source"} from #39)
//   GET  /api/deploys/version           anyone: {version}, the release this server runs (the pipeline waits for it)
//   GET  /api/deploys/status[?history=N] another of Erga's servers (DEPLOY_HOOK_SECRET): this server's own target
//   POST /api/deploys/<name>/hook       another of Erga's servers (DEPLOY_HOOK_SECRET): {branch, commit} or {redeploy}
//   POST /api/snapshot/docs[/import]    SNAPSHOT_TOKEN: read documents' storage (any server), write it (staging only)
//   GET  /admin/deploys                 redirects to /admin/source: the dashboard of source and deploys
//
// "Admins" are the server's admins signed in, in a browser or with an agent
// token; a test person never.

import { snapshotDoor } from "../deploy/snapshot";
import { PRODUCTION } from "../deploy/targets";
import { whoOf, withTokens, type Platform } from "../front";
import type { Env } from "./env";
import { LOCKED } from "../users";
import { byLine } from "../attribution";

/** Whether this path is one of these routes. */
export const isDeploysPath = (path: string) =>
  path == "/api/deploys" || path.startsWith("/api/deploys/") || path == "/api/events" || path.startsWith("/api/snapshot/") || path == "/admin/deploys";

export async function deploysDoor(request: Request, env: Env, base: Platform): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const stub = () => env.PIPELINE.getByName("deploys");

  if (path == "/api/deploys/version" && (method == "GET" || method == "HEAD")) return Response.json({ version: env.ERGA_VERSION ?? null, target: env.DEPLOY_TARGET || null }, { headers: { "Cache-Control": "no-store" } });

  if (path.startsWith("/api/snapshot/")) {
    // Never into production, whatever its settings say.
    const production = env.DEPLOY_TARGET == "production" || url.hostname == PRODUCTION.host;
    return (await snapshotDoor(request, {
      token: env.SNAPSHOT_TOKEN,
      importAllowed: env.SNAPSHOT_IMPORT == "1" && !production,
      store: {
        export: (id) => env.DOCS.getByName(id).exportStorage(id),
        import: (snap) => env.DOCS.getByName(snap.id).importStorage(snap),
        wipe: (id) => env.DOCS.getByName(id).wipeStorage(),
      },
    })) ?? Response.json({ error: "Not found" }, { status: 404 });
  }

  // The deploys' page is the Source page's dashboard now (/admin/source).
  if (path == "/admin/deploys") return new Response(null, { status: 302, headers: { Location: "/admin/source" } });

  // A deploy's log, and a target's history: for admins, and for another of Erga's servers (production's dashboard shows staging's).
  const [, logOf] = /^\/api\/deploys\/([a-z]+)\/log$/.exec(path) ?? [];
  const [, historyOf] = /^\/api\/deploys\/([a-z]+)\/history$/.exec(path) ?? [];
  const deployId = url.searchParams.get("deploy") ?? undefined;
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const logAnswer = async (name: string) => {
    const log = await stub().logOf(name, deployId);
    return log ? Response.json(log, noStore) : Response.json({ error: deployId ? `${name} has no deploy ${deployId} in its history.` : `There's no deploy target called ${name}.` }, { status: 404 });
  };
  const historyAnswer = async (name: string) => {
    const deploys = await stub().historyOf(name, Number(url.searchParams.get("limit") ?? 20));
    return deploys ? Response.json({ target: name, deploys }, noStore) : Response.json({ error: `There's no deploy target called ${name}.` }, { status: 404 });
  };
  if ((logOf || historyOf) && method == "GET" && peer(request, env)) return logOf ? logAnswer(logOf) : historyAnswer(historyOf);

  // Server to server: another of Erga's servers, with the shared secret.
  const [, hookOf] = /^\/api\/deploys\/([a-z]+)\/hook$/.exec(path) ?? [];
  if (path == "/api/deploys/status" || hookOf) {
    if (!peer(request, env)) return Response.json({ error: "Not found" }, { status: 404 });
    if (path == "/api/deploys/status" && method == "GET") return Response.json({ target: await stub().own(Number(url.searchParams.get("history") ?? 0) || 0) });
    if (hookOf && method == "POST") {
      const body = (await request.json().catch(() => ({}))) as { branch?: string; commit?: string; redeploy?: boolean; trigger?: string };
      const r = await stub().remoteHook(hookOf, body);
      return Response.json(r, { status: r.ok ? 200 : 400 });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Admins only, from here.
  const platform = withTokens(base, url);
  const session = await platform.sessionOf(request);
  const admin = !!session && !session.test && (await platform.directory.users.isAdmin(whoOf(session)));
  if (!admin) return Response.json({ error: session ? "Only an admin can do that." : "Sign in as an admin, or use an admin-scope token (/tokens)." }, { status: session ? 403 : 401 });
  // Admin power: the browser's, or an admin-scope token's.
  if (!(await platform.directory.users.actsAsAdmin(whoOf(session!)))) return Response.json({ error: LOCKED, locked: true }, { status: 403 });
  if (path == "/api/events" && method == "GET") return stub().fetch(new Request(url, request));
  if (path == "/api/deploys" && method == "GET") return Response.json(await stub().status(Number(url.searchParams.get("history") ?? 0) || 0), noStore);
  if (logOf && method == "GET") return logAnswer(logOf);
  if (historyOf && method == "GET") return historyAnswer(historyOf);
  const [, name] = /^\/api\/deploys\/([a-z]+)$/.exec(path) ?? [];
  if (name && method == "POST") {
    // From this site's pages, or an agent's token: never another site's form.
    if (!session!.agent && request.headers.get("origin") != url.origin) return Response.json({ error: "Forbidden" }, { status: 403 });
    const fresh = ((await request.json().catch(() => ({}))) as { fresh?: unknown }).fresh === true;
    const r = fresh ? await stub().redeployWith(name, `redeploy by ${byLine(session!.login.toLowerCase(), whoOf(session!).via)}`, { fresh }) : await stub().redeploy(name, `redeploy by ${byLine(session!.login.toLowerCase(), whoOf(session!).via)}`);
    return r.ok ? Response.json({ ok: true, target: r.status }) : Response.json({ ok: false, error: r.error }, { status: r.status ?? 400 });
  }
  return Response.json({ error: `There's nothing at ${method} ${path}.` }, { status: 404 });
}

/** The request carries this server's DEPLOY_HOOK_SECRET (staging's admins-only guard asks too: worker/admins-only.ts). */
export function peer(request: Request, env: Env): boolean {
  const secret = env.DEPLOY_HOOK_SECRET?.trim() || (env.ERGA_DEPLOY_MOCK == "1" ? "mock-hook-secret-0123456789abcdef" : "");
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (secret.length < 16 || bearer.length != secret.length) return false;
  let d = 0;
  for (let i = 0; i < secret.length; i++) d |= secret.charCodeAt(i) ^ bearer.charCodeAt(i);
  return d == 0;
}
