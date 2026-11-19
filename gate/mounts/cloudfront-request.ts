// The gate's CloudFront Function on the viewer request of every behavior but the gate's own paths and the agents'
// (cloudfront.ts).

import { CALLER, GATE_COOKIES, pass, seal } from "../core.ts";
import { type CfEvent, type CfRequest, type CfResponse, config, port, reqOf, responseOf, scrub, WIRE } from "./cloudfront.ts";

export async function handler(event: CfEvent): Promise<CfRequest | CfResponse> {
  const c = await config();
  const q = reqOf(event);
  const a = await pass(q, c, port);
  if (a.do != "forward") return responseOf(a);
  // On to Erga: without the gate's cookies and tokens, with the caller as the gate found it. (The cookies that the
  // core adds to Erga's answer, `a.cookies`, are the response function's to set: cloudfront-response.ts.)
  const r = scrub(event.request);
  for (const name of GATE_COOKIES(c)) delete r.cookies[name];
  if (/^Bearer\s/i.test(q.headers.authorization || "")) delete r.headers.authorization;
  r.headers[CALLER] = { value: port.enc(JSON.stringify(a.caller)) };
  // The same caller, sealed, for the response function (cloudfront.ts, WIRE): for this request only, so a minute.
  r.headers[WIRE] = { value: await seal(port, c.key, "w", { c: a.caller }, Math.floor(q.now / 1000) + 60) };
  // The host the viewer asked for, which Erga's server behind CloudFront (celld) takes for its own: written here on
  // every request, over whatever came in.
  // Trap: not x-forwarded-proto. CloudFront refuses a function that writes it, with a 502 for the request ("The
  // CloudFront function tried to add a disallowed header": seen on a real distribution, 2026-11-18). CloudFront says
  // the scheme itself, in CloudFront-Forwarded-Proto, when the origin request policy lists that header.
  r.headers["x-forwarded-host"] = { value: q.host };
  return r;
}
