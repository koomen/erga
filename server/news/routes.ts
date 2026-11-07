// Live pages, the routes (hub.ts has the design):
//
//   GET /api/news                       an open page's socket (Upgrade: websocket): the hub tells it which of its
//                                       person's rows changed; the page says `{"since": v}` as it opens
//   GET /api/news/rows?view=&keys=      those rows, rendered as the person by the full page's own row function: each
//                                       key's HTML and place, or null for a row they no longer see
//
// Both are for a person signed in, in their browser: an agent acts with tools, and has no page to keep live.

import * as Effect from "effect/Effect";
import { NotAllowed } from "../directory/index.ts";
import { accessRows, apiKeysRows, authRows, changesRows, settingsRows, usersRows } from "../admin/index.ts";
import { docsRows } from "../pages/index.ts";
import { type LiveRows, whoOf } from "../platform.ts";
import { call, ctx, fromWeb, json, text } from "../http.ts";

/** Each live list's rows, by its data-live-view: the page's own (each checks who may see them, as its page does). */
const VIEWS: Record<string, LiveRows> = {
  docs: docsRows(false),
  "docs-archived": docsRows(true),
  users: usersRows,
  settings: settingsRows,
  access: accessRows,
  "api-keys": apiKeysRows,
  changes: changesRows,
  auth: authRows,
};

/** At most this many keys in one ask. */
const MAX_KEYS = 100;

export const newsRoutes = Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  const session = yield* call(() => platform.sessionOf(request));
  if (!session) return json({ error: "Sign in first." }, 401);
  if (session.agent) return json({ error: "Live pages are for a person's open pages: an agent reads with tools (/mcp)." }, 403);
  if (url.pathname == "/api/news") {
    if (request.headers.get("upgrade")?.toLowerCase() != "websocket") return text("A WebSocket only.", 426);
    // Only this site's own pages: a page elsewhere (another subdomain the cookie reaches) may not listen as the person.
    const origin = request.headers.get("origin");
    if (origin && origin != url.origin) return text("Not from this site", 403);
    const admin = yield* call(() => platform.directory.users.actsAsAdmin(whoOf(session)));
    const headers = new Headers({ Upgrade: "websocket", "x-erga-login": session.login.toLowerCase(), "x-erga-admin": admin ? "1" : "" });
    return fromWeb(yield* call(() => platform.news.fetch(new Request(url.origin + "/api/news", { headers }))));
  }
  if (url.pathname == "/api/news/rows" && request.method == "GET") {
    const view = VIEWS[url.searchParams.get("view") ?? ""];
    if (!view) return json({ error: `No such view: ${Object.keys(VIEWS).join(", ")}.` }, 400);
    const keys = [...new Set((url.searchParams.get("keys") ?? "").split(",").filter(Boolean))].slice(0, MAX_KEYS);
    if (!keys.length) return json({ rows: {} });
    const rows = yield* Effect.tryPromise({ try: () => view(platform, session, keys, url.origin), catch: (e) => e }).pipe(
      Effect.catchIf(
        (e): e is NotAllowed => e instanceof NotAllowed,
        (e) => Effect.succeed(e)
      ),
      Effect.orDie
    );
    if (rows instanceof NotAllowed) return json({ error: rows.message }, 403);
    return json({ rows });
  }
  return json({ error: "Not found" }, 404);
});
