// The gate's Lambda@Edge function (SSO on AWS): the two things a CloudFront Function can't do, and nothing else. It
// holds no edge key, signs nothing and decides nothing: the CloudFront Function (cloudfront.ts) does, before it and
// after it. It is the origin request of two behaviors (/_edge/*, where only the callback comes this far, and
// /oauth/token):
//
//   /_edge/callback   one HTTPS call: the code, traded at the issuer's token endpoint with this server's client
//                     secret, for who signed in. Its answer carries that in x-erga-identity, which the viewer-response
//                     function reads, checks against the sign-in's state, and signs.
//   /oauth/token      the POST's body, sent again to the same address in the header x-erga-form, where the function
//                     decides; the function's answer goes back as it is (its status, its body, and the headers the
//                     core set: CORS's among them).
//
// Trap: the header's value is never empty (`FORM_START`). The function sends a POST with no such header here, for
// its body; a header with no value may be lost on the way, and then an empty body would go around between the two
// with no end.
//
// The client secret is in Systems Manager (the parameter GATE_LAMBDA.secret names), read once for each instance.

import type { Answer, Identity } from "../core.ts";
import { type Oidc, oidcExchange } from "./oidc.ts";

/** The deploy's settings, put here by the build: the issuers by name, and where each one's client secret is. */
declare const GATE_LAMBDA: { shell: string; idp: Record<string, Omit<Oidc, "secret"> & { secret: string }>; region: string };

interface Header {
  key?: string;
  value: string;
}
interface LambdaRequest {
  method: string;
  uri: string;
  headers: Record<string, Header[]>;
  body?: { data: string; encoding: "base64" | "text" };
}
interface LambdaResponse {
  status: string;
  headers: Record<string, Header[]>;
  body?: string;
}

const secrets = new Map<string, Promise<string>>();
/** A secret parameter's value (Systems Manager), read once. */
const secretOf = (name: string): Promise<string> => {
  let s = secrets.get(name);
  if (!s) {
    s = (async () => {
      // The Lambda runtime's own SDK.
      const sdk = "@aws-sdk/client-ssm";
      const { SSMClient, GetParameterCommand } = await import(sdk);
      const got = await new SSMClient({ region: GATE_LAMBDA.region }).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      return got.Parameter.Value as string;
    })();
    secrets.set(name, s);
  }
  return s;
};

/**
 * The headers of the function's answer to /oauth/token that go back to the viewer: all that the core sets there.
 * (Not every header: the answer came through the distribution, and CloudFront refuses its own headers in a Lambda's
 * response.)
 */
const KEPT = ["cache-control", "content-type", "referrer-policy", "x-content-type-options", "access-control-allow-origin"];

/** What the form's header starts with, so that it is never empty (see the top). A form reads it as a field with no name: nothing. */
const FORM_START = "&";

const b64 = (text: string) => Buffer.from(text).toString("base64url");
const said = (body: string, headers: Record<string, Header[]> = {}): LambdaResponse => ({
  status: "200",
  headers: { "cache-control": [{ value: "no-store" }], "content-type": [{ value: "text/plain; charset=utf-8" }], ...headers },
  body,
});

export async function handler(
  event: { Records: [{ cf: { request: LambdaRequest } }] },
  _context?: unknown,
  o: { fetch?: typeof fetch; secret?: (name: string) => Promise<string> } = {}
): Promise<LambdaResponse> {
  const request = event.Records[0].cf.request;
  const ask = o.fetch ?? fetch;
  if (request.uri == "/oauth/token") {
    const body = request.body
      ? request.body.encoding == "base64"
        ? Buffer.from(request.body.data, "base64").toString()
        : request.body.data
      : "";
    const answer = await ask(`https://${GATE_LAMBDA.shell}/oauth/token`, {
      method: "POST",
      headers: { "x-erga-form": FORM_START + body.slice(0, 8192) },
    });
    const headers: Record<string, Header[]> = {};
    for (const name of KEPT) {
      const value = answer.headers.get(name);
      if (value) headers[name] = [{ value }];
    }
    return { status: String(answer.status), headers, body: await answer.text() };
  }
  const wrote = request.headers["x-erga-exchange"]?.[0]?.value;
  if (request.uri != "/_edge/callback" || !wrote) return said("Not found");
  const x = JSON.parse(Buffer.from(wrote, "base64url").toString()) as Extract<Answer, { do: "exchange" }>;
  const idp = Object.prototype.hasOwnProperty.call(GATE_LAMBDA.idp, x.idp) ? GATE_LAMBDA.idp[x.idp] : null;
  const identity: Identity | null = idp
    ? await oidcExchange(x.idp, { ...idp, secret: await (o.secret ?? secretOf)(idp.secret) }, x, ask)
    : null;
  return identity ? said("", { "x-erga-identity": [{ value: b64(JSON.stringify(identity)) }] }) : said("Sign-in didn't work. Try again.");
}
