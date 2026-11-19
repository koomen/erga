// The gate as CloudFront Functions (SSO on AWS). It is the core and this adapter, and nothing else: HMAC and SHA-256
// from the runtime's `crypto`, the edge key and the deny list from the functions' KeyValueStore (the one key store),
// no network and no body. gate/build.ts builds it with the deploy's settings in place of GATE_CONFIG, as four
// functions (cloudfront-<part>.ts; this file is what they share), each under CloudFront's 10 KB. Each of the first
// three is the viewer request of its own paths' behavior, and answers 404 for any other address:
//
//   edge       /_edge/*: the gate's own paths (`edge`): the sign-in's start and callback, and the hand-off's steps. The
//              callback goes on to Lambda@Edge (lambda.ts) with what to trade (x-erga-exchange).
//   agents     /.well-known/oauth-* and /oauth/token (`agents`): fixed JSON, and the token endpoint. Its POST goes on
//              to the Lambda for its body, which sends it here again in x-erga-form.
//   request    every other behavior (`pass`). Its own response, or the request on to the origin with the caller's
//              header and without the gate's cookies and tokens. It writes x-forwarded-host too (a behavior has one
//              viewer-request function, and Erga's server reads its own host from it). It can't write the scheme:
//              CloudFront refuses a function that writes x-forwarded-proto (cloudfront-request.ts).
//   response   the viewer response of every behavior. It signs: the callback's cookies, from the identity the Lambda
//              gave (x-erga-identity); and what Erga's answer asks (x-erga-gate: a code, a token, sign-out). And it
//              sets the member cookie for a person's page that came with none (the core's `memberFor`).
//
// An instance's stacks make all of it (deploy/aws/template.ts: the behaviors, the store, the origin's header; with
// deploy/aws/gate.ts, which builds the code and writes the edge key).
// Erga's machine is private: only the distribution reaches it (a VPC origin), with a fixed origin header that only
// the distribution knows (x-erga-front: the value of Erga's GATE_KEY, set as the origin's custom header, which
// replaces any header of that name from a viewer). Erga answers no request without it. The caller's header is written here on every request that goes on.
//
// The runtime (cloudfront-js-2.0) refuses much of this file's syntax and the core's: gate/build.ts lowers each build
// (gate/lower.ts), and fails on what is left of it. A real distribution ran the four functions as built (2026-11-18),
// and showed that a viewer-response function runs after an origin-request Lambda's own response, and that a
// WebSocket's first request passes the request function. The response function's event has the request as the viewer
// sent it (AWS's documentation: "the actual request that CloudFront received from the viewer"), with the viewer's
// cookies and any header the viewer wrote: so it reads no header of the gate's own from it, and finds the caller
// again from the request's proof (cloudfront-response.ts).

import crypto from "crypto";
// @ts-expect-error The CloudFront Functions runtime's module.
import cf from "cloudfront";
import { type Answer, ASK, CALLER, type Config, FORM, type Port, type Req } from "../core.ts";

/** The deploy's settings (all but the key), put here by the build. */
declare const GATE_CONFIG: Omit<Config, "key">;

/** The Lambda's two headers: what to trade (to it), and who signed in (from it). */
export const EXCHANGE = "x-erga-exchange";
export const IDENTITY = "x-erga-identity";

interface Value {
  value: string;
  multiValue?: { value: string }[];
  attributes?: string;
}
export interface CfRequest {
  method: string;
  uri: string;
  querystring: Record<string, Value>;
  headers: Record<string, Value>;
  cookies: Record<string, Value>;
}
export interface CfResponse {
  statusCode: number;
  statusDescription?: string;
  headers: Record<string, Value>;
  cookies: Record<string, Value>;
  body?: { encoding: "text"; data: string };
}
export interface CfEvent {
  context: { requestId: string };
  request: CfRequest;
  response?: CfResponse;
}

const kvs = cf.kvs();
export const port: Port = {
  hmac: (key, text) => crypto.createHmac("sha256", key).update(text).digest("base64url"),
  sha256: (text) => crypto.createHash("sha256").update(text).digest("base64url"),
  enc: (text) => Buffer.from(text).toString("base64url"),
  dec: (text) => Buffer.from(text, "base64url").toString(),
  denied: (sub) => kvs.exists(`deny:${sub}`),
};

/** The deploy's settings, with the edge key from the KeyValueStore. */
export const config = async (): Promise<Config> => ({ ...GATE_CONFIG, key: await kvs.get("key") });

const plain = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return "";
  }
};

/** The event's request as the core reads it. */
export const reqOf = (event: CfEvent): Req => {
  const r = event.request;
  const query: Record<string, string> = {};
  for (const k in r.querystring) query[plain(k)] = plain(r.querystring[k].value);
  const cookies: Record<string, string[]> = {};
  for (const k in r.cookies) cookies[k] = r.cookies[k].multiValue ? r.cookies[k].multiValue!.map((v) => v.value) : [r.cookies[k].value];
  const header = (name: string) => r.headers[name] && r.headers[name].value;
  return {
    method: r.method,
    host: (header("host") || "").toLowerCase(),
    path: r.uri,
    query,
    headers: { authorization: header("authorization"), "sec-fetch-dest": header("sec-fetch-dest"), [FORM]: header(FORM) },
    cookies,
    id: event.context.requestId,
    now: Date.now(),
  };
};

/** A response's cookies, from Set-Cookie lines. */
export const setCookies = (to: Record<string, Value>, lines: string[]) => {
  for (const line of lines) {
    const at = line.indexOf("="),
      end = line.indexOf("; ");
    to[line.slice(0, at)] = { value: line.slice(at + 1, end), attributes: line.slice(end + 2) };
  }
};

/** A request that goes on, without the gate's own headers: whatever came in under their names is not the gate's. */
/**
 * The caller as the request function found it, sealed under the edge key (kind "w"), for the response function.
 * Trap: the viewer-response event has the request as the viewer-request function left it (seen on a real
 * distribution, 2026-11-19: the gate's cookies, which that function deletes, were gone there). So the response
 * function can't find the caller in the cookies again, and must not trust a header a viewer could write: it takes
 * this one only, and only with a good seal. The request function always writes it over whatever came in (scrub).
 */
export const WIRE = "x-erga-wire";

export const scrub = (r: CfRequest): CfRequest => {
  for (const h of [CALLER, WIRE, EXCHANGE, IDENTITY, ASK]) delete r.headers[h];
  return r;
};

/** The core's own answer, as CloudFront takes it. Any other answer here (none: not this function's address) is a 404. */
export const responseOf = (a: Answer | null): CfResponse => {
  if (!a || a.do != "respond") a = { do: "respond", status: 404, headers: {}, cookies: [], body: "Not found" };
  const out: CfResponse = { statusCode: a.status, headers: {}, cookies: {}, body: { encoding: "text", data: a.body } };
  for (const k in a.headers) out.headers[k] = { value: a.headers[k] };
  setCookies(out.cookies, a.cookies);
  return out;
};
