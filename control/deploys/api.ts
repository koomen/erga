// The deploys' API, over the pipeline's object (control/deploys/branches.ts in
// control/deploys/pipeline-object.ts): what the Ops page and the admin agent ask.
// Served by the control Worker (control/routes.ts); in local development the
// app's own Worker serves it, over the mock Cloudflare.
//
//   GET  /api/deploys[?history=N]       admins: every target's status {targets: [...]}, with each one's last N deploys
//                                       (`history`, newest first) if asked
//   POST /api/deploys/<name>            admins: redeploy that target's branch head now; {fresh: true}: staging with a
//                                       fresh copy of production's data, in place of its frozen copy
//   POST /api/deploys/<name>/rollback   admins: put back the Worker version from before the target's live deploy (its restore
//                                       point: seconds, no build; the database keeps its schema)
//   POST /api/deploys/credential/disconnect   admins: the control Worker's Cloudflare grant revoked and forgotten (the
//                                       Ops page's Cloudflare card; Connect is a consent in a popup: control/routes.ts)
//   GET  /api/deploys/<name>/history[?limit=N]
//                                       admins: the last N deploys (default 20, at most 100)
//                                       {target, deploys: [{id, commit, state, started, ended, trigger, error, live, ...}]}
//   GET  /api/deploys/<name>/log[?deploy=<id>]
//                                       admins: the latest deploy's whole log, or that deploy's
//                                       {deployId, commit, state, trigger, started, ended, error, live, lines: [{at, text, step?}]}
//   GET  /api/events                    admins: the events, over a WebSocket (Upgrade: websocket, as the Ops page asks), else
//                                       as server-sent events: {type: "deploys"} on each change, {type: "deploy-log", target,
//                                       deployId, lines} as a deploy's lines arrive, {type: "source"} on a push or merge
//
// "Admins" are the server's admins signed in, in a browser or with an
// admin-scope token; a test person never. The caller (the control Worker's
// gate, or the app's in local development) has checked that already.

import type { CredentialStatus, TokenAnswer } from "./credential.ts";
import type { ReleasesView } from "./releases.ts";
import type { DomainsView } from "./domains.ts";
import { byLine } from "../../shared/attribution.ts";
import type { Session } from "../../server/platform.ts";
import { whoOf } from "../../server/platform.ts";
import type { DashboardDeploys } from "../../agents/admin/sessions.ts";
import { json } from "../../shared/http";

/** The pipeline's object, as these routes need it: the dashboard's calls, a target's history, and the event stream. */
export interface DeploysObject extends DashboardDeploys {
  historyOf(name: string, limit?: number): Promise<object[] | null>;
  /** The Cloudflare credential (control/deploys/credential.ts): its status; a consent's grant kept; forgotten (the control Worker's /install). */
  credentialStatus(): Promise<CredentialStatus>;
  connectCredential(answer: TokenAnswer, by: string): Promise<string>;
  disconnectCredential(): Promise<void>;
  /** Whether `origin` is the control Worker of an install made from here (control/deploys/pipeline-object.ts: the consent relay asks). */
  isInstall(origin: string): Promise<boolean>;
  /** The release store (control/deploys/releases.ts): both channels (null: no store). */
  releases(): Promise<ReleasesView | null>;
  /** Each environment's domains (its Worker's custom domains), and one added or removed (control/routes.ts, /api/domains). */
  domains(): Promise<DomainsView | { error: string; status?: number }>;
  addDomain(target: string, hostname: string, by: string): Promise<DomainsView | { error: string; status?: number }>;
  removeDomain(target: string, hostname: string, by: string): Promise<DomainsView | { error: string; status?: number }>;
  /** GET /api/events: the stream. */
  fetch(request: Request): Promise<Response>;
}

export const isDeploysApiPath = (path: string) => path == "/api/deploys" || path.startsWith("/api/deploys/") || path == "/api/events";

/** The routes above, for `session` (an admin with admin power, checked by the caller). */
export async function deploysApi(request: Request, session: Session, deploys: DeploysObject): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const by = byLine(session.login.toLowerCase(), whoOf(session).via);

  if (path == "/api/events" && method == "GET") return deploys.fetch(new Request(url, request));
  if (path == "/api/deploys" && method == "GET") return json(await deploys.status(Number(url.searchParams.get("history") ?? 0) || 0));
  const [, logOf] = /^\/api\/deploys\/([a-z]+)\/log$/.exec(path) ?? [];
  if (logOf && method == "GET") {
    const deployId = url.searchParams.get("deploy") ?? undefined;
    const log = await deploys.logOf(logOf, deployId);
    return log ? json(log) : json({ error: deployId ? `${logOf} has no deploy ${deployId} in its history.` : `There's no deploy target called ${logOf}.` }, 404);
  }
  const [, historyOf] = /^\/api\/deploys\/([a-z]+)\/history$/.exec(path) ?? [];
  if (historyOf && method == "GET") {
    const list = await deploys.historyOf(historyOf, Number(url.searchParams.get("limit") ?? 20));
    return list ? json({ target: historyOf, deploys: list }) : json({ error: `There's no deploy target called ${historyOf}.` }, 404);
  }
  // From this site's pages, or an agent's token: never another site's form.
  const ownForm = () => !!session.agent || request.headers.get("origin") == url.origin;
  const [, rollbackOf] = /^\/api\/deploys\/([a-z]+)\/rollback$/.exec(path) ?? [];
  if (rollbackOf && method == "POST") {
    if (!ownForm()) return json({ error: "Forbidden" }, 403);
    const r = await deploys.rollback(rollbackOf, `rollback by ${by}`);
    return r.ok ? json({ ok: true, target: r.status }) : json({ ok: false, error: r.error }, (r as { status?: number }).status ?? 400);
  }
  if (path == "/api/deploys/credential/disconnect" && method == "POST") {
    if (!ownForm()) return json({ error: "Forbidden" }, 403);
    await deploys.disconnectCredential();
    return json({ ok: true, credential: await deploys.credentialStatus() });
  }
  const [, name] = /^\/api\/deploys\/([a-z]+)$/.exec(path) ?? [];
  if (name && method == "POST") {
    if (!ownForm()) return json({ error: "Forbidden" }, 403);
    const fresh = ((await request.json().catch(() => ({}))) as { fresh?: unknown }).fresh === true;
    const r = fresh ? await deploys.redeployWith(name, `redeploy by ${by}`, { fresh }) : await deploys.redeploy(name, `redeploy by ${by}`);
    return r.ok ? json({ ok: true, target: r.status }) : json({ ok: false, error: r.error }, (r as { status?: number }).status ?? 400);
  }
  return json({ error: `There's nothing at ${method} ${path}.` }, 404);
}
