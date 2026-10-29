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

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { CredentialStatus, TokenAnswer } from "./credential.ts";
import type { ReleasesView } from "./releases.ts";
import type { DomainsView } from "./domains.ts";
import { byLine } from "../../shared/attribution.ts";
import type { Session } from "../../server/platform.ts";
import { whoOf } from "../../server/platform.ts";

/** This server's branch deploys, as the admin agent's Ops page tools ask them (the pipeline's object answers, by RPC). */
export interface OpsDeploys {
  status(history?: number): Promise<object>;
  logOf(target: string, deploy?: string): Promise<object | null>;
  redeploy(name: string, trigger?: string): Promise<{ ok: boolean; status?: unknown; error?: string }>;
  redeployWith(name: string, trigger: string, o: { fresh?: boolean }): Promise<{ ok: boolean; status?: unknown; error?: string }>;
  /** Back to the Worker version before the target's live deploy (its restore point). */
  rollback(name: string, trigger?: string): Promise<{ ok: boolean; status?: unknown; error?: string }>;
  /** The release store (control/deploys/releases.ts): both channels (null: no store). */
  releases(): Promise<object | null>;
  /** Each environment's domains, and one added or removed (control/deploys/branches.ts). */
  domains(): Promise<object>;
  addDomain(target: string, hostname: string, by: string): Promise<object>;
  removeDomain(target: string, hostname: string, by: string): Promise<object>;
  /** The control Worker's Cloudflare credential (control/deploys/credential.ts): its status, and revoked (the Ops page's card). */
  credentialStatus(): Promise<CredentialStatus>;
  disconnectCredential(): Promise<void>;
}

declare module "../../server/platform.ts" {
  interface Platform {
    /** The deploys: the pipeline's object (the control Worker's, over its binding, on erga.dev). */
    deploys: OpsDeploys;
  }
}

/** The pipeline's object, as these routes need it: the Ops page's calls, a target's history, and the event stream. */
export interface DeploysObject extends OpsDeploys {
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

/** Who asks and what they act on: given with each request (the routes are made once). */
class Asking extends Context.Service<Asking, { readonly request: Request; readonly session: Session; readonly deploys: DeploysObject }>()(
  "erga/control/Asking"
) {}

/** A JSON answer, as every answer here is: no cache keeps it. */
const answer = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status, headers: { "Cache-Control": "no-store" } });
const ask = <A>(f: (deploys: DeploysObject) => Promise<A>) => Asking.use(({ deploys }) => Effect.promise(() => f(deploys)));
const query = Asking.useSync(({ request }) => new URL(request.url).searchParams);
/** From this site's pages, or an agent's token: never another site's form. */
const ownForm = Asking.useSync(({ request, session }) => !!session.agent || request.headers.get("origin") == new URL(request.url).origin);
const forbidden = answer({ error: "Forbidden" }, 403);
const by = Asking.useSync(({ session }) => byLine(session.login.toLowerCase(), whoOf(session).via));
const done = (r: { ok: boolean; status?: unknown; error?: string }) =>
  r.ok ? answer({ ok: true, target: r.status }) : answer({ ok: false, error: r.error }, (r as { status?: number }).status ?? 400);

/** A target's name in a path: lower-case letters (anything else is nothing here). */
const targetName = HttpRouter.schemaPathParams(Schema.Struct({ name: Schema.String.check(Schema.isPattern(/^[a-z]+$/)) }));
/** A redeploy's body: { fresh: true } asks for staging with a fresh copy; a body that isn't JSON asks for nothing. */
const Redeploy = Schema.fromJsonString(Schema.Struct({ fresh: Schema.optionalKey(Schema.Unknown) }));

const nothingHere = Asking.useSync(({ request }) =>
  answer({ error: `There's nothing at ${request.method} ${new URL(request.url).pathname.replace(/\/+$/, "") || "/"}.` }, 404)
);

const routes = HttpRouter.addAll(
  [
    HttpRouter.route(
      "GET",
      "/api/deploys",
      Effect.gen(function* () {
        const history = Number((yield* query).get("history") ?? 0) || 0;
        return answer(yield* ask((d) => d.status(history)));
      })
    ),
    HttpRouter.route(
      "GET",
      "/api/deploys/:name/log",
      Effect.gen(function* () {
        const { name } = yield* targetName;
        const deployId = (yield* query).get("deploy") ?? undefined;
        const log = yield* ask((d) => d.logOf(name, deployId));
        return log
          ? answer(log)
          : answer(
              { error: deployId ? `${name} has no deploy ${deployId} in its history.` : `There's no deploy target called ${name}.` },
              404
            );
      })
    ),
    HttpRouter.route(
      "GET",
      "/api/deploys/:name/history",
      Effect.gen(function* () {
        const { name } = yield* targetName;
        const limit = Number((yield* query).get("limit") ?? 20);
        const list = yield* ask((d) => d.historyOf(name, limit));
        return list ? answer({ target: name, deploys: list }) : answer({ error: `There's no deploy target called ${name}.` }, 404);
      })
    ),
    HttpRouter.route(
      "POST",
      "/api/deploys/:name/rollback",
      Effect.gen(function* () {
        const { name } = yield* targetName;
        if (!(yield* ownForm)) return forbidden;
        const trigger = `rollback by ${yield* by}`;
        return done(yield* ask((d) => d.rollback(name, trigger)));
      })
    ),
    HttpRouter.route(
      "POST",
      "/api/deploys/credential/disconnect",
      Effect.gen(function* () {
        if (!(yield* ownForm)) return forbidden;
        yield* ask((d) => d.disconnectCredential());
        return answer({ ok: true, credential: yield* ask((d) => d.credentialStatus()) });
      })
    ),
    HttpRouter.route(
      "POST",
      "/api/deploys/:name",
      Effect.gen(function* () {
        const { name } = yield* targetName;
        if (!(yield* ownForm)) return forbidden;
        const { request } = yield* Asking;
        const body = yield* Effect.promise(() => request.text().catch(() => ""));
        const fresh = Option.getOrUndefined(Schema.decodeUnknownOption(Redeploy)(body))?.fresh === true;
        const trigger = `redeploy by ${yield* by}`;
        return done(yield* ask((d) => (fresh ? d.redeployWith(name, trigger, { fresh }) : d.redeploy(name, trigger))));
      })
    ),
    HttpRouter.route("*", "*", nothingHere),
  ].map((r) =>
    HttpRouter.route(
      r.method,
      r.path,
      Effect.catchTag(r.handler, "SchemaError", () => nothingHere)
    )
  )
);

const web = HttpRouter.toWebHandler(routes, { disableLogger: true, routerConfig: { ignoreTrailingSlash: true } });

/** The routes above, for `session` (an admin with admin power, checked by the caller). */
export async function deploysApi(request: Request, session: Session, deploys: DeploysObject): Promise<Response> {
  // The event stream goes to the object as it came: a WebSocket's upgrade can't go through the router.
  const url = new URL(request.url);
  if ((url.pathname.replace(/\/+$/, "") || "/") == "/api/events" && request.method == "GET")
    return deploys.fetch(new Request(url, request));
  return web.handler(request, Context.make(Asking, { request, session, deploys }));
}
