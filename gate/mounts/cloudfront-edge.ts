// The gate's CloudFront Function on the viewer request of /_edge/* (cloudfront.ts): the gate's own paths.

import { edge } from "../core.ts";
import { type CfEvent, type CfRequest, type CfResponse, config, EXCHANGE, port, reqOf, responseOf, scrub } from "./cloudfront.ts";

export async function handler(event: CfEvent): Promise<CfRequest | CfResponse> {
  const a = await edge(reqOf(event), await config(), port);
  // The callback: on to the Lambda, with what to trade.
  if (a && a.do == "exchange") {
    const r = scrub(event.request);
    r.headers[EXCHANGE] = { value: port.enc(JSON.stringify(a)) };
    return r;
  }
  return responseOf(a);
}
