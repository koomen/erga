// The sign-in's code exchange with an OIDC issuer (Cognito, or any other): the one network call of a sign-in. The
// gate's Worker makes it (worker.ts), and on AWS, Lambda@Edge does (lambda.ts), which holds no edge key and signs
// nothing: the core signs what this gives.
//
// The ID token comes straight from the issuer's token endpoint, over TLS, with this server's client secret: so its
// signature needs no check (OpenID Connect Core 3.1.3.7), and the gate needs no RS256. Its claims are still checked:
// the issuer, this client, and its end. Its address counts only with the issuer's own word that it verified it.

import type { Identity } from "../core.ts";

export interface Oidc {
  /** The issuer (the `iss` of its tokens), and its token endpoint. */
  issuer: string;
  token: string;
  client: string;
  secret: string;
}

const claimsOf = (jwt: string): Record<string, unknown> | null => {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), (ch) => ch.charCodeAt(0))));
    return claims && typeof claims == "object" ? claims : null;
  } catch {
    return null;
  }
};

/** Who the code's sign-in was, as the issuer `name`; null: the issuer refused, or its token isn't for this client. */
export async function oidcExchange(
  name: string,
  o: Oidc,
  x: { code: string; verifier: string; redirect: string },
  ask: typeof fetch = fetch,
  now = Date.now()
): Promise<Identity | null> {
  const answer = await ask(o.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: x.code,
      redirect_uri: x.redirect,
      client_id: o.client,
      client_secret: o.secret,
      code_verifier: x.verifier,
    }),
    redirect: "manual",
  }).catch(() => null);
  if (!answer?.ok) return null;
  const body = (await answer.json().catch(() => null)) as { id_token?: unknown } | null;
  const c = typeof body?.id_token == "string" ? claimsOf(body.id_token) : null;
  if (!c || c.iss !== o.issuer || typeof c.sub != "string" || !c.sub) return null;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(o.client) || typeof c.exp != "number" || c.exp * 1000 <= now) return null;
  // An address counts only when the issuer says that it verified it (`email_verified`: true, or the text "true").
  // Trap: no claim is not a yes. Erga takes the gate's address as verified (server/identity/caller.ts), and finds a
  // person an admin added by it: an issuer that lets a person type any address would sign them in as that person.
  // An issuer that sends no such claim gives no address: its people sign in by their subject alone.
  const email = typeof c.email == "string" && (c.email_verified === true || c.email_verified === "true") ? c.email : "";
  return { p: name, sub: c.sub, email, name: typeof c.name == "string" ? c.name : "" };
}
