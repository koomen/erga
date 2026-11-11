// The company's own sign-in, in front of Erga: on AWS a load balancer sends each browser to the company's OIDC sign-in
// before any request reaches the server (deploy/aws/template.ts, balancer), and then adds the header x-amzn-oidc-data
// to each request: who signed in, as a JWT that AWS signs. That sign-in is this server's own (FRONT_SIGN_IN): no
// GitHub, no Google.
//
//   /auth/front[?next=]   reads the header, and goes on as after any provider (accounts.ts): the account of this
//                         subject, or the username step for a new person. /auth/sign-in comes straight here.
//
// The header counts only when all of this holds: its signature is AWS's, of the balancer's region, for the key it
// names; its `signer` is this server's balancer (another balancer's header has the same AWS signature); its issuer
// and client are the sign-in's; it has not ended. Trap: without the check of `signer`, anyone with a load balancer of
// their own signs in as anyone. Some paths pass the balancer with no sign-in (an agent's, with its token): they carry
// no header, and this route is not one of them.
//
// The account is kept by the sign-in's `sub`, never by the email. The first admin is the person the sign-in gives the
// deploy's admin email for, verified (the setup's `admin` answer): they have no username before their first sign-in.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fromBase64, fromBase64url } from "../../shared/bytes.ts";
import type { Vouched } from "../directory/index.ts";
import { call, ctx, type Route } from "../http.ts";
import { page, safeNext } from "../pages/index.ts";
import { vouchedSignIn } from "./accounts.ts";

const FrontSignIn = Schema.Struct({
  /** The load balancer whose header counts: its ARN. */
  signer: Schema.NonEmptyString,
  /** The sign-in's issuer, and this server's client there. */
  issuer: Schema.NonEmptyString,
  client: Schema.NonEmptyString,
  /** The first admin's email address, lowercase. */
  admin: Schema.NonEmptyString,
});
export type FrontSignIn = typeof FrontSignIn.Type;

/** FRONT_SIGN_IN as the deploy wrote it; null: none (or not a value this reads: then nobody signs in with it). */
export const frontOf = (raw: string): FrontSignIn | null =>
  raw ? Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(FrontSignIn))(raw)) : null;

const HEADER = "x-amzn-oidc-data";

/** The JWT's header, as the balancer writes it. */
const Head = Schema.Struct({
  alg: Schema.Literal("ES256"),
  kid: Schema.String,
  signer: Schema.String,
  iss: Schema.String,
  client: Schema.String,
  exp: Schema.Number,
});
/** Who signed in: the claims of the sign-in's user info. Cognito gives email_verified as text. */
const Claims = Schema.Struct({
  sub: Schema.NonEmptyString,
  email: Schema.optionalKey(Schema.String),
  email_verified: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
  name: Schema.optionalKey(Schema.String),
});

/** The public key a balancer of `region` signed with, by its id. */
export type Key = (kid: string, region: string) => Promise<CryptoKey>;

const keys = new Map<string, Promise<CryptoKey>>();
/** AWS's public key (a PEM at its fixed address), imported once for each isolate. */
const awsKey: Key = (kid, region) => {
  const at = `${region}/${kid}`;
  let key = keys.get(at);
  if (!key) {
    key = fetch(`https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`).then(async (r) => {
      if (!r.ok) throw new Error(`AWS has no key ${kid}: ${r.status}`);
      const der = fromBase64((await r.text()).replace(/-----[A-Z ]+-----|\s+/g, ""));
      return crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    });
    if (keys.size > 8) keys.clear();
    keys.set(at, key);
    key.catch(() => keys.delete(at));
  }
  return key;
};

const json = (part: string): unknown => JSON.parse(new TextDecoder().decode(fromBase64url(part)));

/**
 * Who the header says signed in, if it is this balancer's and still good (the rules at the top of this file); else
 * null. `key`: where the public key comes from (the tests'; AWS's).
 */
export async function readFront(token: string, front: FrontSignIn, o: { now?: number; key?: Key } = {}): Promise<Vouched | null> {
  try {
    const [h, p, s, more] = token.split(".");
    if (!h || !p || !s || more != null) return null;
    const head = Option.getOrNull(Schema.decodeUnknownOption(Head)(json(h)));
    const region = front.signer.split(":")[3] ?? "";
    if (!head || !/^[\w-]{1,64}$/.test(head.kid) || !/^[a-z0-9-]+$/.test(region)) return null;
    if (head.signer != front.signer || head.iss != front.issuer || head.client != front.client) return null;
    if (head.exp * 1000 <= (o.now ?? Date.now())) return null;
    const key = await (o.key ?? awsKey)(head.kid, region);
    // The balancer signs the two parts as it sent them, padding too.
    const signed = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64url(s),
      new TextEncoder().encode(`${h}.${p}`)
    );
    const claims = signed ? Option.getOrNull(Schema.decodeUnknownOption(Claims)(json(p))) : null;
    if (!claims) return null;
    const email = claims.email?.trim().toLowerCase() ?? "";
    const verified = claims.email_verified === true || claims.email_verified === "true";
    return {
      provider: "front",
      subject: claims.sub,
      handle: email || claims.sub,
      name: claims.name?.trim() || null,
      emails: email ? [{ email, verified }] : [],
    };
  } catch {
    return null;
  }
}

/** Whether the sign-in in front vouches that this person has the first admin's email (the deploy's, FRONT_SIGN_IN). */
export const isFrontAdmin = (front: FrontSignIn | null | undefined, v: Pick<Vouched, "provider" | "emails">) =>
  !!front && v.provider == "front" && v.emails.some((e) => e.verified && e.email == front.admin.toLowerCase());

/** /auth/front: signs in whoever the load balancer says signed in at the company's sign-in. */
export const frontSignIn: Route = Effect.gen(function* () {
  const { platform, request, url } = yield* ctx;
  const front = platform.signIn.front;
  if (!front) return page("Not found", 'There\'s nothing here. <a href="/">Back to the start</a>.', 404);
  const v = yield* call(() => readFront(request.headers.get(HEADER) ?? "", front));
  // (No link to try again from here: the same request gives the same answer.)
  if (!v)
    return page("Sign-in failed", "Your company's sign-in didn't say who you are. Reload the page; if this stays, tell an admin.", 400);
  return yield* vouchedSignIn(platform, request, v, safeNext(url.searchParams.get("next")), {});
});

/** Where a server with a sign-in in front has no GitHub or Google sign-in: a route of theirs says so. */
export const unlessFront = (route: Route): Route =>
  Effect.gen(function* () {
    const { platform } = yield* ctx;
    if (!platform.signIn.front) return yield* route;
    return page("Not this way", 'This server signs in with your company\'s sign-in. <a class="new" href="/auth/sign-in">Sign in</a>', 404);
  });
