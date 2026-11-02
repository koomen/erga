// What a token without the admin scope reaches on staging, past the admins-only guard (admins-only.ts lists
// the exemption and why). Apart from the guard, so the unit tests can load it.

import { RESERVED, ID, OWNER } from "../directory/index.ts";

/** The app's own first path segments that RESERVED doesn't list: never a document's owner here. */
const APP_SEGMENTS = new Set(["deploy", "git", "source"]);

/**
 * A path in reach of a token without the admin scope on staging: the server's API and MCP for agents, the
 * operations (/api/tools), and a document's own host (/<owner>/<doc>/api/..., /d/<id>/doc/...). Not the
 * homepage's API, the deploys', the Ops page's, the admin agent's or anything else under /api.
 */
export function tokenPath(path: string): boolean {
  path = path.replace(/\/+$/, "") || "/";
  if (path == "/mcp" || path == "/api/publish") return true;
  // The one API (each operation checks the token's scope: no admin power, one document's reach).
  if (path == "/api/tools" || path.startsWith("/api/tools/")) return true;
  const [, first, second] = /^\/([^/]+)\/([^/]+)\/(?:api|doc)(?:\/|$)/.exec(path) ?? [];
  if (!first) return false;
  if (first == "d") return ID.test(second);
  return OWNER.test(first) && !RESERVED.has(first.toLowerCase()) && !APP_SEGMENTS.has(first.toLowerCase());
}
