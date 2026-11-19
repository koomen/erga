// The gate's CloudFront Function on the viewer response of every behavior (cloudfront.ts): it signs, and it sets the
// cookies that the core asks a mount to add to Erga's answer.

import { after, ASK, type Caller, callerOf, type Identity, isPage, memberFor, open, signedIn } from "../core.ts";
import { type CfEvent, type CfResponse, config, IDENTITY, port, reqOf, setCookies, WIRE } from "./cloudfront.ts";

export async function handler(event: CfEvent): Promise<CfResponse> {
  const out = event.response!;
  const identity = out.headers[IDENTITY] && out.headers[IDENTITY].value;
  const ask = out.headers[ASK] && out.headers[ASK].value;
  delete out.headers[IDENTITY];
  delete out.headers[ASK];
  const q = reqOf(event);
  // Most answers go as they are, with no read of the key: nothing to sign, and no page that may need a cookie.
  if (!identity && !ask && !isPage(q)) return out;
  const c = await config();
  let change: { status?: number; headers: Record<string, string>; cookies: string[] } | null = null;
  let cookies: string[] = [];
  if (identity) {
    // The callback's end: the core checks the sign-in's state again, then signs.
    const a = await signedIn(q, c, port, JSON.parse(port.dec(identity) || "{}") as Identity);
    if (a.do == "respond") change = a;
  } else {
    // The caller as the request function found it, under its seal (cloudfront.ts, WIRE); else from the request's own
    // proof. Never from a header without the seal: a viewer writes any header.
    const sealed = event.request.headers[WIRE] && event.request.headers[WIRE].value;
    const wire = sealed ? await open<{ c: Caller }>(port, c.key, "w", sealed, Math.floor(q.now / 1000)) : null;
    const who = wire ? wire.c : await callerOf(q, c, port);
    if (who != "bad") {
      change = await after(q, c, port, ask, who);
      // A person's page that came with no member cookie gets one, as the request function's `pass` found (it can set
      // none: its answer is the request). An answer that signs out sets none of the gate's cookies: it only ends them.
      if (ask != "out") cookies = await memberFor(q, c, port, who);
    }
  }
  if (change) {
    if (change.status) {
      out.statusCode = change.status;
      out.statusDescription = "Found";
    }
    for (const k in change.headers) out.headers[k] = { value: change.headers[k] };
    cookies = cookies.concat(change.cookies);
  }
  setCookies(out.cookies, cookies);
  return out;
}
