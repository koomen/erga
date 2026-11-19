// The gate's CloudFront Function on the viewer request of /.well-known/oauth-* and /oauth/token (cloudfront.ts).

import { agents } from "../core.ts";
import { type CfEvent, type CfRequest, type CfResponse, config, port, reqOf, responseOf, scrub } from "./cloudfront.ts";

export async function handler(event: CfEvent): Promise<CfRequest | CfResponse> {
  const a = await agents(reqOf(event), await config(), port);
  // The token endpoint's POST with no body yet: on to the Lambda, which sends it here again in x-erga-form, with a
  // value that is never empty (lambda.ts), so that it never comes here a second time with no body yet.
  if (a && a.do == "body") return scrub(event.request);
  return responseOf(a);
}
