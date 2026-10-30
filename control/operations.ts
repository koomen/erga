// The Ops page's operations (server/operations/operation.ts): the repository's (source/operations.ts) and the
// deploys' (deploys/operations.ts). They live here, above server/, because they work the control Worker's objects;
// agents/tools.ts adds them to the server's own, so the app's POST /api/tools/<name> (server/api.ts), every agent
// with admin power and the guides have them. The control Worker answers the same POST /api/tools/<name> for these
// itself (`controlTools`, from control/routes.ts), so the Ops page calls one API wherever it is served.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Operation, OperationError, runOperation } from "../server/operations/index.ts";
import { type Platform, type Session, whoOf } from "../server/platform.ts";
import { json } from "../shared/http.ts";
import { DEPLOY_OPERATIONS } from "./deploys/operations.ts";
import { SOURCE_OPERATIONS } from "./source/operations.ts";

/** The Ops page's operations, each admins' only. */
export const CONTROL_OPERATIONS: Operation[] = [...SOURCE_OPERATIONS, ...DEPLOY_OPERATIONS];

/**
 * POST /api/tools/<name> on the control Worker: one of CONTROL_OPERATIONS, as `session` (signed in here, or an
 * admin-scope token). A session alone acts only from this site's own pages. {"ok": true, "result"} or {"ok": false, "error"}.
 */
export async function controlTools(request: Request, platform: Platform, session: Session): Promise<Response> {
  const url = new URL(request.url);
  const failure = (error: string, status: number) => json({ ok: false, error }, status);
  const name = decodeURIComponent(/^\/api\/tools\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? "");
  const op = CONTROL_OPERATIONS.find((o) => o.name == name);
  if (!op || request.method != "POST")
    return failure(
      `POST ${url.origin}/api/tools/<name> runs one of the Ops page's operations: ${CONTROL_OPERATIONS.map((o) => o.name).join(", ")}.`,
      404
    );
  if (!session.agent && request.headers.get("origin") != url.origin) return failure("Only this site's own pages may do this.", 403);
  const body = await request.text().catch(() => "");
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(body || "{}");
  if (Option.isNone(parsed)) return failure("The body must be the tool's arguments, as JSON.", 400);
  const args = parsed.value ?? {};
  if (typeof args != "object" || Array.isArray(args)) return failure("The arguments must be a JSON object.", 400);
  let decoded: Record<string, unknown>;
  try {
    decoded = Schema.decodeUnknownSync(op.parameters as Schema.Codec<Record<string, unknown>>)(args, { errors: "all" });
  } catch (e) {
    return failure(`Validation failed for tool "${name}":\n${(e as Error).message}`, 400);
  }
  const caller = { dir: platform.directory, who: whoOf(session), name: session.name, origin: url.origin, platform };
  try {
    return json({ ok: true, result: await runOperation(op, decoded, caller) });
  } catch (e) {
    if (e instanceof OperationError) return failure(e.message, e.status);
    return failure(`The tool failed: ${(e as Error)?.message ?? e}`, 500);
  }
}
