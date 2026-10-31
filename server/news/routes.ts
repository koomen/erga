// Live pages, the routes (hub.ts has the design):
//
//   GET /api/news                       an open page's socket (Upgrade: websocket): the hub tells it which of its
//                                       person's rows changed; the page says `{"since": v}` as it opens
//   GET /api/news/rows?view=&keys=      those rows, rendered as the person by the full page's own row function: each
//                                       key's HTML and place, or null for a row they no longer have
//
// Both are for a person signed in, in their browser: an agent acts with tools, and has no page to keep live.

import * as Effect from "effect/Effect";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { docRow } from "../pages/index.ts";
import { call, ctx, fromWeb, json, text } from "../http.ts";

/** A row as an open page takes it: its HTML and its place (data-sort); null: gone from the person's view. */
export type Row = { html: string; sort: number } | null;

/** The rows a page shows, by kind ("doc"): each key's row now, as `session` sees it. */
const VIEWS: Record<string, { kind: string; rows(platform: Platform, session: Session, ids: string[]): Promise<Record<string, Row>> }> = {
  docs: {
    kind: "doc",
    async rows(platform, session, ids) {
      const [docs, hours] = await Promise.all([
        platform.docs.list(session.login, ids),
        platform.directory.config.get("delete_docs_after_hours"),
      ]);
      const now = Date.now();
      const out: Record<string, Row> = Object.fromEntries(ids.map((id) => [`doc:${id}`, null]));
      for (const d of docs) out[`doc:${d.id}`] = { html: docRow(session, d, now, hours), sort: d.modified };
      return out;
    },
  },
};

/** At most this many keys in one ask. */
const MAX_KEYS = 100;

export const newsRoutes = Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  const session = yield* call(() => platform.sessionOf(request));
  if (!session) return json({ error: "Sign in first." }, 401);
  if (session.agent) return json({ error: "Live pages are for a person's open pages: an agent reads with tools (GET /llms.txt)." }, 403);
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
    const keys = (url.searchParams.get("keys") ?? "")
      .split(",")
      .filter((k) => k.startsWith(`${view.kind}:`))
      .slice(0, MAX_KEYS);
    const ids = [...new Set(keys.map((k) => k.slice(view.kind.length + 1)))];
    return json({ rows: ids.length ? yield* call(() => view.rows(platform, session, ids)) : {} });
  }
  return json({ error: "Not found" }, 404);
});
