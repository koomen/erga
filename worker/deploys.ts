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
//   GET  /admin/deploys                 redirects to /admin/factory: the dashboard of source and deploys
//
// The production gate (deploy/gate.ts, worker/gate.ts): each staging commit's full test run. Staging's server runs
// it; production's answers these from staging's (the routes take DEPLOY_HOOK_SECRET too, for that).
//
//   GET  /api/gate[?limit=N]            admins (or another of Erga's servers): the runs, newest first {runs, runner,
//                                       shards, host}: each {commit, state, attempt, trigger, started, ended, shards,
//                                       failed, flaky, error}
//   GET  /api/gate/<sha>                admins (or another server): one commit's run and the verdict {run, verdict:
//                                       {ok, state, reason}}: may main move to it?
//   GET  /api/gate/<sha>/log?shard=N    admins (or another server): a shard's log, once it ended {log}
//   POST /api/gate/<sha>/run            admins (or another server, {by}): run the commit's tests (again) {run}
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
  path == "/api/deploys" || path.startsWith("/api/deploys/") || path == "/api/events" || path.startsWith("/api/snapshot/") || path == "/admin/deploys" || path == "/api/gate" || path.startsWith("/api/gate/");

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

  // The deploys' page is the Factory page's dashboard now (/admin/factory).
  if (path == "/admin/deploys") return new Response(null, { status: 302, headers: { Location: "/admin/factory" } });

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

  // The production gate: another of Erga's servers (production asks staging's), or admins (below).
  const isGate = path == "/api/gate" || path.startsWith("/api/gate/");
  if (isGate && peer(request, env)) return gateAnswer(request, env, url, path, null);

  // Admins only, from here.
  const platform = withTokens(base, url);
  const session = await platform.sessionOf(request);
  const admin = !!session && !session.test && (await platform.directory.users.isAdmin(whoOf(session)));
  if (!admin) return Response.json({ error: session ? "Only an admin can do that." : "Sign in as an admin, or use an admin-scope token (/tokens)." }, { status: session ? 403 : 401 });
  // Admin power: the browser's, or an admin-scope token's.
  if (!(await platform.directory.users.actsAsAdmin(whoOf(session!)))) return Response.json({ error: LOCKED, locked: true }, { status: 403 });
  if (isGate) {
    // From this site's pages, or an agent's token: never another site's form.
    if (method == "POST" && !session!.agent && request.headers.get("origin") != url.origin) return Response.json({ error: "Forbidden" }, { status: 403 });
    return gateAnswer(request, env, url, path, byLine(session!.login.toLowerCase(), whoOf(session!).via));
  }
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

/** /api/gate...: for an admin (`by`, who asked and how: attribution.ts, byLine) or another of Erga's servers (null; a run names who asked there). */
async function gateAnswer(request: Request, env: Env, url: URL, path: string, by: string | null): Promise<Response> {
  const stub = env.PIPELINE.getByName("deploys");
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const fail = (e: unknown, status = 502) => Response.json({ error: (e as Error)?.message ?? String(e) }, { status });
  try {
    if (path == "/api/gate" && request.method == "GET") {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50));
      return Response.json(await stub.gateList(limit), noStore);
    }
    const [, sha, what] = /^\/api\/gate\/([0-9a-f]{40})(?:\/(log|run))?$/.exec(path) ?? [];
    if (!sha) return Response.json({ error: "Name the commit by its full id (40 hex digits): /api/gate/<sha>." }, { status: 404 });
    if (!what && request.method == "GET") return Response.json(await stub.gateGet(sha), noStore);
    if (what == "log" && request.method == "GET") {
      const shard = Number(url.searchParams.get("shard") ?? 0);
      if (!(shard >= 1)) return Response.json({ error: "Which shard? ?shard=1, 2, ..." }, { status: 400 });
      return Response.json({ log: await stub.gateLog(sha, shard) }, noStore);
    }
    if (what == "run" && request.method == "POST") {
      const body = (await request.json().catch(() => ({}))) as { by?: string };
      const who = by ?? (typeof body.by == "string" && body.by ? `${body.by.slice(0, 120)} (passed on)` : "another server");
      return Response.json({ run: await stub.gateStart(sha, who) });
    }
  } catch (e) { return fail(e); }
  return Response.json({ error: `There's nothing at ${request.method} ${path}.` }, { status: 404 });
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
