// What the tests of the gate's mounts share (tests/gate-mounts.test.ts, tests/gate-cloudfront.test.ts): the hosts, and
// a pretend issuer.

export const KEY = "an-edge-key-of-thirty-two-characters!";
export const SHELL = "erga.example.com";
export const CONTENT = "pages.example.net";
export const PAGE = `https://abc12345-ada.${CONTENT}/t/pass/`;
export const ISSUER = "https://idp.example.com";
export const IDP = { name: "sso", issuer: ISSUER, authorize: `${ISSUER}/authorize`, token: `${ISSUER}/token`, client: "client-1" };

export const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** An ID token as an issuer's token endpoint gives it (its signature is never read). */
export const idToken = (claims: Record<string, unknown>) =>
  `${b64({ alg: "RS256" })}.${b64({ iss: ISSUER, aud: "client-1", exp: Date.now() / 1000 + 300, ...claims })}.sig`;

/** A pretend issuer's token endpoint: it trades the code "good" with the client's secret and a verifier. */
export const issuer = (seen: URLSearchParams[] = []): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url != IDP.token) return new Response("nope", { status: 404 });
    const form = new URLSearchParams(String(init?.body));
    seen.push(form);
    if (form.get("code") != "good" || form.get("client_secret") != "idp-secret" || !form.get("code_verifier"))
      return new Response("{}", { status: 400 });
    return Response.json({ id_token: idToken({ sub: "sub-ada", email: "ada@example.com", email_verified: true, name: "Ada" }) });
  }) as typeof fetch;
