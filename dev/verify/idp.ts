// The verify harness's OIDC issuer (dev/verify.ts): a Worker with scripted people, so that a run signs in with no
// person. It is the "organization's issuer" in SSO mode, the "provider" in OAuth mode, and Cloudflare Access's
// identity provider in Access mode. It keeps no state: a code is a signed value (who, the redirect, the PKCE
// challenge, 60 seconds), so a code works more than one time, which a real issuer refuses. It checks what an issuer
// must: the client and its secret, the redirect, and PKCE (S256). Its ID tokens are RS256, with the key at /jwks:
// Access checks the signature (the gate does not: its token comes straight from the token endpoint).
//
// Its page is a form: a name and the run's password (PASSWORD, a secret that each deploy makes), so that only the
// run's own browsers sign in. Trap: it shares no code with the gate (gate/): a test that used the gate's own `seal`
// would agree with the gate's mistakes.

interface Env {
  /** Its one client, the secret of that client, and the redirect it may ask for. */
  CLIENT: string;
  CLIENT_SECRET: string;
  REDIRECT: string;
  /** The run's password, and the key of the codes. */
  PASSWORD: string;
  KEY: string;
  /** The ID tokens' key: an RSA private key, as a JWK with a `kid` (a secret that each deploy makes). */
  SIGNING_KEY: string;
}

/** The people: each one a member of the organization. */
const PEOPLE: Record<string, { sub: string; email: string; name: string }> = {
  ada: { sub: "sub-ada", email: "ada@example.com", name: "Ada" },
  bob: { sub: "sub-bob", email: "bob@example.com", name: "Bob" },
};

const text = new TextEncoder();
const b64 = (bytes: Uint8Array | string) => {
  let s = "";
  for (const b of typeof bytes == "string" ? text.encode(bytes) : bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
const hmac = async (key: string, value: string) => {
  const k = await crypto.subtle.importKey("raw", text.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", k, text.encode(value))));
};
const sha256 = async (value: string) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(value))));
/** A signed value, `<body>.<HMAC>`; and its claims back, or null. */
const sign = async (key: string, claims: object) => {
  const body = b64(JSON.stringify(claims));
  return `${body}.${await hmac(key, body)}`;
};
const read = async (key: string, value: string): Promise<Record<string, unknown> | null> => {
  const [body, mac] = value.split(".");
  // (Not in constant time: a test issuer's.)
  if (!body || !mac || mac != (await hmac(key, body))) return null;
  return JSON.parse(unb64(body));
};

/** An ID token: RS256, by the deploy's key. */
const idToken = async (env: Env, claims: object) => {
  const jwk = JSON.parse(env.SIGNING_KEY) as JsonWebKey & { kid: string };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const body = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }))}.${b64(JSON.stringify(claims))}`;
  return `${body}.${b64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, text.encode(body))))}`;
};

const plain = (status: number, body: string) => new Response(body, { status, headers: { "cache-control": "no-store" } });
const FORM = `<!doctype html><meta charset="utf-8"><title>Test issuer</title>
<form method="post"><input name="who" placeholder="ada or bob"><input name="pass" type="password"><button id="go">Sign in</button></form>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const now = Math.floor(Date.now() / 1000);
    /** This issuer's address (the `iss` of its tokens). */
    const issuer = url.origin;
    if (url.pathname == "/.well-known/openid-configuration")
      return Response.json({
        issuer: issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    if (url.pathname == "/jwks") {
      const { kty, n, e, kid } = JSON.parse(env.SIGNING_KEY) as Record<string, string>;
      return Response.json({ keys: [{ kty, n, e, kid, alg: "RS256", use: "sig" }] });
    }
    if (url.pathname == "/authorize") {
      const q = url.searchParams;
      const challenge = q.get("code_challenge") ?? "";
      if (q.get("client_id") != env.CLIENT || q.get("redirect_uri") != env.REDIRECT || q.get("response_type") != "code")
        return plain(400, "Not this issuer's client or redirect.");
      if (q.get("code_challenge_method") != "S256" || challenge.length != 43) return plain(400, "PKCE (S256) is required.");
      if (request.method == "GET")
        return new Response(FORM, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (request.method != "POST") return plain(405, "GET or POST");
      const form = new URLSearchParams(await request.text());
      const who = form.get("who") ?? "";
      if (form.get("pass") !== env.PASSWORD) return plain(403, "Wrong password.");
      const back = new URL(env.REDIRECT);
      if (q.get("state")) back.searchParams.set("state", q.get("state")!);
      // "cancel": the person refused.
      if (who == "cancel") back.searchParams.set("error", "access_denied");
      else if (!(who in PEOPLE)) return plain(403, "Nobody of that name.");
      else back.searchParams.set("code", await sign(env.KEY, { who, challenge, nonce: q.get("nonce") ?? "", e: now + 60 }));
      return new Response(null, { status: 302, headers: { location: back.toString(), "cache-control": "no-store" } });
    }
    if (url.pathname == "/token" && request.method == "POST") {
      const f = new URLSearchParams(await request.text());
      const bad = (error: string) => Response.json({ error }, { status: 400, headers: { "cache-control": "no-store" } });
      // The client and its secret, in the form or in the Authorization header (Basic): a client may use either.
      const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      const [id, secret] = basic
        ? atob(basic)
            .split(":")
            .map((part) => decodeURIComponent(part))
        : [f.get("client_id"), f.get("client_secret")];
      if (id != env.CLIENT || secret !== env.CLIENT_SECRET) return bad("invalid_client");
      const code = f.get("grant_type") == "authorization_code" ? await read(env.KEY, f.get("code") ?? "").catch(() => null) : null;
      if (!code || !((code.e as number) > now) || f.get("redirect_uri") != env.REDIRECT) return bad("invalid_grant");
      if ((await sha256(f.get("code_verifier") ?? "")) != code.challenge) return bad("invalid_grant");
      const person = PEOPLE[code.who as string];
      const claims = {
        iss: issuer,
        aud: env.CLIENT,
        iat: now,
        exp: now + 300,
        ...person,
        email_verified: true,
        ...(code.nonce ? { nonce: code.nonce } : {}),
      };
      return Response.json(
        { id_token: await idToken(env, claims), access_token: "none", token_type: "Bearer", expires_in: 300 },
        { headers: { "cache-control": "no-store" } }
      );
    }
    return plain(404, "Not found");
  },
};
