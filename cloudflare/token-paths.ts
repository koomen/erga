// What a token without the admin scope reaches on staging, past the admins-only guard (cloudflare/admins-only.ts lists
// the exemption and why). Apart from the guard, so the unit tests can load it.

import { RESERVED } from "../server/directory";
import { ID, OWNER } from "../server/routes";

/** The app's own first path segments that RESERVED doesn't list: never a document's owner here. */
const APP_SEGMENTS = new Set(["deploy", "git", "source"]);

/**
 * A path in reach of a token without the admin scope on staging: the server's API and MCP for agents, a
 * document's versions and tree, and a document's own host (/<owner>/<doc>/api/..., /d/<id>/doc/...). Not the
 * homepage's API, the deploys', the Source page's, the admin agent's or anything else under /api.
 */
export function tokenPath(path: string): boolean {
  path = path.replace(/\/+$/, "") || "/";
  if (path == "/llms.txt" || path == "/api" || path == "/mcp" || path == "/api/publish") return true;
  if (path == "/api/ext" || path.startsWith("/api/ext/")) return true;
  if (/^\/api\/docs\/[^/]+\/(versions|publish|tree|versions\/[^/]+\/restore)$/.test(path)) return true;
  const [, first, second] = /^\/([^/]+)\/([^/]+)\/(?:api|doc)(?:\/|$)/.exec(path) ?? [];
  if (!first) return false;
  if (first == "d") return ID.test(second);
  return OWNER.test(first) && !RESERVED.has(first.toLowerCase()) && !APP_SEGMENTS.has(first.toLowerCase());
}
