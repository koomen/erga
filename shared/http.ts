// The answers every route table gives the same way. Here, not in server/, so that document/ has them too.

/** The header of an answer that no cache keeps. */
const NO_STORE = { "Cache-Control": "no-store" };

/** `body` as JSON, that no cache keeps; `headers` add to that. */
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
