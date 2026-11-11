// The answers every route table gives the same way, and where a request came from. Here, not in server/, so that
// document/ has them too.

/** The header of an answer that no cache keeps. */
const NO_STORE = { "Cache-Control": "no-store" };

/** `body` as JSON, that no cache keeps; `headers` add to that. */
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

/**
 * The address a request came from, as the front in front of the server saw it: Cloudflare's header (which can't be
 * sent from outside), else the last address of X-Forwarded-For, which the front adds itself (AWS's load balancer,
 * CloudFront: the server's port is open to them only). Null with neither (local development).
 */
export const callerAddress = (headers: Headers): string | null =>
  headers.get("cf-connecting-ip") ?? (headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || null);
