// The gate on web Requests (a Worker's): what both of Cloudflare's mounts share. Erga's own Worker calls `handle` as
// its first step (OAuth mode, or any deploy with no gate in front); the gate's own Worker (worker.ts) calls it in
// front of a private Erga, over a service binding. The same steps either way:
//
//   1. the request as the core reads it (`reqOf`);
//   2. the core's answer; the two things it can't do itself: /oauth/token's body into the header, and the sign-in's
//      code exchange (`exchange`), after which the core signs;
//   3. on to Erga (`upstream`), without the gate's cookies and tokens, with the caller in a header written here;
//   4. what Erga's answer asks of the gate (core.ts, `after`), and the cookies the core adds.
//
// Trap: the caller's header is written on every request that goes on, whatever came in under its name. Erga trusts it
// only because nothing reaches Erga but through here. A gate in front proves that with a key that the deploy gives the
// gate and Erga (`FRONT`: worker.ts sends it; on CloudFront it is the origin's fixed header): Erga answers no request
// without it.

import {
  after,
  type Answer,
  ASK,
  type Caller,
  CALLER,
  type Config,
  FORM,
  gate,
  GATE_COOKIES,
  type Identity,
  parseForm,
  type Port,
  type Req,
  signedIn,
  TOKEN,
} from "../core.ts";

/** The header a gate in front proves itself to Erga with: the key the deploy gave both (Erga's GATE_KEY). Never from outside. */
export const FRONT = "x-erga-front";

/** What the sign-in's code exchange gave: who signed in, or a page that says why not. */
export type Exchanged = { identity: Identity; next?: string; cookies?: string[] } | Response;

export interface Mount {
  /** The gate's settings for this request. */
  config(request: Request): Config | Promise<Config>;
  port: Port;
  /** The callback's network call: the code, traded at the issuer for who signed in. */
  exchange(x: Extract<Answer, { do: "exchange" }>, request: Request): Promise<Exchanged>;
  /** Behind Cloudflare Access: the person of the request's proof, checked (access.ts). */
  access?(request: Request): Promise<(Identity & { e: number }) | null>;
  /** Erga. */
  upstream(request: Request): Promise<Response>;
}

/** A Cookie header's cookies: every value of each name. */
export function parseCookies(header: string | null): Record<string, string[]> {
  const out: Record<string, string[]> = Object.create(null);
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name) (out[name] ??= []).push(part.slice(at + 1).trim());
  }
  return out;
}

/** A request as the core reads it. */
export async function reqOf(request: Request, m: Pick<Mount, "access">): Promise<Req> {
  const url = new URL(request.url);
  return {
    method: request.method,
    host: url.host.toLowerCase(),
    path: url.pathname,
    query: parseForm(url.search.slice(1)),
    headers: {
      authorization: request.headers.get("authorization") ?? undefined,
      "sec-fetch-dest": request.headers.get("sec-fetch-dest") ?? undefined,
    },
    cookies: parseCookies(request.headers.get("cookie")),
    id: `${request.headers.get("cf-ray") ?? ""}.${crypto.randomUUID()}`,
    now: Date.now(),
    ...(m.access ? { access: await m.access(request) } : {}),
  };
}

const answerOf = (a: Extract<Answer, { do: "respond" }>, more: string[] = []) => {
  const headers = new Headers(a.headers);
  for (const c of [...a.cookies, ...more]) headers.append("set-cookie", c);
  return new Response(a.status == 204 || a.status == 302 ? null : a.body, { status: a.status, headers });
};

/** The caller as the header carries it, and back (Erga's side reads it). */
export const writeCaller = (caller: Caller, port: Port) => port.enc(JSON.stringify(caller));
export function readCaller(request: Request, port: Port): Caller {
  try {
    const c = JSON.parse(port.dec(request.headers.get(CALLER) ?? "") ?? "");
    return c && typeof c.kind == "string" ? c : { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}

/** The most of /oauth/token's or /oauth/register's body that the gate reads. */
const FORM_MAX = 8192;

/** The gate's answer to a request, or Erga's behind it. */
export async function handle(request: Request, m: Mount): Promise<Response> {
  const c = await m.config(request);
  const q = await reqOf(request, m);
  let a = await gate(q, c, m.port);
  if (a.do == "body") {
    // The token endpoint takes a form, registration JSON (RFC 7591): any other body is none.
    const type = request.headers.get("content-type") ?? "";
    const body = /^application\/(x-www-form-urlencoded|json)\b/i.test(type) ? await request.text() : "";
    q.headers[FORM] = body.length > FORM_MAX ? "" : body;
    a = await gate(q, c, m.port);
  }
  if (a.do == "exchange") {
    const x = await m.exchange(a, request);
    if (x instanceof Response) return x;
    return answerOf((await signedIn(q, c, m.port, x.identity, x.next)) as Extract<Answer, { do: "respond" }>, x.cookies);
  }
  if (a.do == "respond") return answerOf(a);
  if (a.do != "forward") return new Response("Bad request", { status: 400 });
  // On to Erga: none of the gate's cookies or tokens, and the caller as the gate found it.
  const headers = new Headers(request.headers);
  const drop = new Set(GATE_COOKIES(c));
  const kept = (headers.get("cookie") ?? "").split(";").filter((part) => part.trim() && !drop.has(part.split("=")[0].trim()));
  if (kept.length) headers.set("cookie", kept.map((s) => s.trim()).join("; "));
  else headers.delete("cookie");
  if (/^Bearer\s/i.test(headers.get("authorization") ?? "")) headers.delete("authorization");
  for (const h of [ASK, FORM, TOKEN, FRONT, "cf-access-jwt-assertion"]) headers.delete(h);
  headers.set(CALLER, writeCaller(a.caller, m.port));
  const answer = await m.upstream(new Request(request, { headers }));
  const ask = answer.headers.get(ASK);
  // A socket's answer goes as it is (a copy would lose the socket).
  if (answer.status == 101 || (!ask && !a.cookies.length)) return answer;
  const change = await after(q, c, m.port, ask, a.caller);
  const out = new Headers(answer.headers);
  out.delete(ASK);
  for (const [k, v] of Object.entries(change?.headers ?? {})) out.set(k, v);
  // (An answer that signs out sets none of the gate's cookies: it only ends them.)
  for (const cookie of [...(ask == "out" ? [] : a.cookies), ...(change?.cookies ?? [])]) out.append("set-cookie", cookie);
  if (change?.status) {
    await answer.body?.cancel();
    return new Response(null, { status: change.status, headers: out });
  }
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: out });
}
