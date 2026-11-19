// A person makes a token to paste into an agent or a script, for the Settings dialog (client/agent/settings-dialog.ts)
// and the Share menu (client/common/agent-menu.ts). Erga makes the grant (grants.ts) and asks the gate for its token
// (caller.ts: only the gate signs one): the token comes back in the answer's header x-erga-token, one time. The list
// and Revoke are the operations whoami and revoke. And a token's expiry as given.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { routeFor, type RouteRow, SECRET } from "../../shared/routes.ts";
import { call, ctx, json, NO_STORE, type Route, text } from "../http.ts";
import { page } from "../pages/index.ts";
import { whoOf } from "../platform.ts";
import { asking, callerOf } from "./caller.ts";
import { type Maker, type Scope, ScopeError } from "./grants.ts";

/** A token's expiry as given: an ISO 8601 time, a date (the end of that day, UTC), milliseconds since the epoch, or nothing (the longest). */
function expiryOf(v: unknown): number | null | "bad" {
  if (v == null || v === "") return null;
  if (typeof v == "number") return Number.isFinite(v) ? v : "bad";
  if (typeof v != "string") return "bad";
  const s = v.trim();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59Z`) : /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(t) ? t : "bad";
}

/**
 * Who makes a grant, if the request is a person's own, in their browser: their account, and the person as the gate
 * names them (the gate signs a token only for that person). Null for an agent, the server's browser, or nobody.
 */
export const makerOf = Effect.gen(function* () {
  const { request, platform } = yield* ctx;
  const session = yield* call(() => platform.sessionOf(request));
  const who = callerOf(request);
  if (!session || session.agent || session.view || who.kind != "person") return null;
  const via = whoOf(session).via;
  return { login: session.login, provider: who.p, subject: who.sub, ...(via ? { via } : {}) } satisfies Maker;
});

/** A new token, as the Settings dialog sends it. */
const NewToken = Schema.Struct({
  label: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  doc: Schema.optionalKey(Schema.String),
  expires: Schema.optionalKey(Schema.String),
});

/** POST /tokens/new { label, scope, doc?, expires? }: a new grant ({ ok, info }), and its token in x-erga-token. */
const newToken: Route = Effect.gen(function* () {
  const { request, platform, url } = yield* ctx;
  const who = yield* makerOf;
  if (!who) return json({ ok: false, error: "Tokens are made by people, signed in." }, 403);
  // Only this site's own pages may make one.
  if (request.headers.get("origin") != url.origin) return text("Forbidden", 403);
  const f = yield* call(() => request.json().catch(() => ({}))).pipe(
    Effect.flatMap((b) => Schema.decodeUnknownEffect(NewToken)(b)),
    Effect.orElseSucceed(() => ({}) as typeof NewToken.Type)
  );
  const expires = expiryOf(f.expires);
  if (expires == "bad") return json({ ok: false, error: "That expiry isn't a date." }, 400);
  const made = yield* Effect.tryPromise({
    try: () => platform.grants.make(who, f.label, { scope: (f.scope || "documents") as Scope, docId: f.doc || null, expires }),
    catch: (e) => e,
  }).pipe(
    Effect.catchIf(
      (e): e is ScopeError => e instanceof ScopeError,
      (e) => Effect.succeed(e)
    ),
    Effect.orDie
  );
  if (made instanceof ScopeError) return json({ ok: false, error: made.message }, 400);
  return asking(json({ ok: true, info: made }, 200, NO_STORE), `token ${made.id} ${Math.floor(made.expires / 1000)}`);
});

export const ROUTES: readonly RouteRow<Route>[] = [
  { method: "POST", path: "/tokens/new", run: newToken, action: "Make an agent token (Settings)", domain: "admin", exempt: SECRET },
];

export const tokensRoutes: Route = Effect.gen(function* () {
  const { request, url } = yield* ctx;
  const found = routeFor(ROUTES, request.method, url.pathname.replace(/\/+$/, ""));
  if (found) return yield* found.route.run;
  return page(
    "Not found",
    `There's nothing here. Your tokens are in Settings (the menu at your picture): <a href="/documents#settings">open it</a>.`,
    404
  );
});
