// The proxy mode (mode.ts): a proxy in front of Erga signs each person in, with the company's own sign-in, before any
// request reaches the server. It then adds a header to each request: who signed in, as a JWT that the proxy signs.
// That sign-in is this server's only one: no OAuth provider.
//
//   /auth/proxy[?next=]   reads the header, and goes on as after any provider (accounts.ts): the account of this
//                         subject, or the username step for a new person. /auth/sign-in comes straight here.
//
// This file does not ask which proxy it is. A proxy is an entry of KINDS: its header's name, where its keys are, and
// what shows that a header is for this server. The deploy says which one is in front, with its values (PROXY_SIGN_IN,
// a `Proxy`). Two steps, apart: the proxy's proof (claimsOf: whose claims these are), then the person the claims are
// (vouchedOf), as every provider gives one (Vouched, server/directory/identities.ts): the app knows nothing else of a
// sign-in.
//
// A header counts only when all of this holds: its signature is the proxy's, for the key it names; it is for this
// server; it has not ended. Trap: the header of AWS's proxy has AWS's signature whichever proxy wrote it, so
// without the check of `signer` anyone with a proxy of their own signs in as anyone. Cloudflare Access's
// has the team's signature whichever application it is for: the check of `aud` is the same guard. Some paths pass the
// proxy with no sign-in (an agent's, with its token: shared/proxy-paths.ts): they carry no header, and this route is
// not one of them.
//
// The account is kept by the sign-in's `sub`, never by the email. The email address is the first of the claims `email`,
// `upn` and `preferred_username` that looks like one. A sign-in that gives none still signs in, by its `sub`: no page
// ever shows the `sub` as a name, and nobody is the first admin without an address (the deploy names them by email).

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fromBase64, fromBase64url } from "../../shared/bytes.ts";
import type { Vouched } from "../directory/index.ts";
import { call, ctx, type Route } from "../http.ts";
import { page, safeNext } from "../pages/index.ts";
import { vouchedSignIn } from "./accounts.ts";
import { noSuchSignIn, signInFailed } from "./sign-in.ts";

/** AWS's proxy: an Application Load Balancer with an OIDC sign-in (deploy/aws/template.ts). */
const AwsAlb = Schema.Struct({
  kind: Schema.Literal("aws-alb"),
  /** The proxy whose header counts: its ARN. */
  signer: Schema.NonEmptyString,
  /** The sign-in's issuer, and this server's client there. */
  issuer: Schema.NonEmptyString,
  client: Schema.NonEmptyString,
});

/** Cloudflare Access: an Access application in front of the server's address. */
const CloudflareAccess = Schema.Struct({
  kind: Schema.Literal("cloudflare-access"),
  /** The Zero Trust team's name: its sign-in is at https://<team>.cloudflareaccess.com. */
  team: Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)),
  /** The Access application whose header counts: its audience tag. */
  aud: Schema.NonEmptyString,
});

const Proxy = Schema.Union([AwsAlb, CloudflareAccess]);
/** The proxy in front of a server, as its deploy says (PROXY_SIGN_IN). */
export type Proxy = typeof Proxy.Type;

/** PROXY_SIGN_IN as the deploy wrote it; null: not a value this reads (then nobody signs in: mode.ts). */
export const proxyOf = (raw: string): Proxy | null => Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(Proxy))(raw));

/** The public key a proxy signed with, by its id. */
export type Key = (kid: string, proxy: Proxy) => Promise<CryptoKey>;

/** One kind of proxy. `C`: its values. */
interface Kind<C extends Proxy> {
  /** Its name, for the admin page. */
  label: string;
  /** The header it adds to each request it lets through. */
  header: string;
  /** How it signs: the JWT's `alg`, and what Web Crypto verifies it with. */
  alg: string;
  verify: Parameters<SubtleCrypto["verify"]>[0];
  /** Its public key, by the id in the JWT's header. */
  key(kid: string, c: C): Promise<CryptoKey>;
  /** Whether the JWT's header says it is for this server and has not ended: asked before the key is. */
  head(head: Record<string, unknown>, c: C, now: number): boolean;
  /** Whether the claims say so: asked once the signature holds. */
  claims(claims: Record<string, unknown>, c: C, now: number): boolean;
  /** Whether the proxy's sign-in verified the address in the `email` claim. */
  verified(claims: Record<string, unknown>): boolean;
  /** Its values, for the admin page: none is a secret. */
  shown(c: C): { name: string; value: string }[];
}

const keys = new Map<string, Promise<CryptoKey>>();
/** A key, imported once for each isolate. */
const kept = (at: string, get: () => Promise<CryptoKey>): Promise<CryptoKey> => {
  let key = keys.get(at);
  if (!key) {
    key = get();
    if (keys.size > 8) keys.clear();
    keys.set(at, key);
    key.catch(() => keys.delete(at));
  }
  return key;
};

const regionOf = (c: typeof AwsAlb.Type) => c.signer.split(":")[3] ?? "";

const awsAlb: Kind<typeof AwsAlb.Type> = {
  label: "AWS Application Load Balancer",
  header: "x-amzn-oidc-data",
  alg: "ES256",
  verify: { name: "ECDSA", hash: "SHA-256" },
  // AWS's public key: a PEM at its fixed address, of the proxy's region.
  key: (kid, c) =>
    kept(`aws:${regionOf(c)}/${kid}`, async () => {
      const r = await fetch(`https://public-keys.auth.elb.${regionOf(c)}.amazonaws.com/${kid}`);
      if (!r.ok) throw new Error(`AWS has no key ${kid}: ${r.status}`);
      const der = fromBase64((await r.text()).replace(/-----[A-Z ]+-----|\s+/g, ""));
      return crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    }),
  // The proxy writes these in the JWT's header.
  head: (h, c, now) =>
    /^[a-z0-9-]+$/.test(regionOf(c)) &&
    h.signer == c.signer &&
    h.iss == c.issuer &&
    h.client == c.client &&
    typeof h.exp == "number" &&
    h.exp * 1000 > now,
  claims: () => true,
  // Cognito gives email_verified as text.
  verified: (claims) => claims.email_verified === true || claims.email_verified === "true",
  shown: (c) => [
    { name: "ARN", value: c.signer },
    { name: "Issuer", value: c.issuer },
    { name: "Client ID", value: c.client },
  ],
};

const teamOrigin = (c: typeof CloudflareAccess.Type) => `https://${c.team}.cloudflareaccess.com`;

const cloudflareAccess: Kind<typeof CloudflareAccess.Type> = {
  label: "Cloudflare Access",
  header: "cf-access-jwt-assertion",
  alg: "RS256",
  verify: { name: "RSASSA-PKCS1-v1_5" },
  // The team's public keys: a JWKS at its fixed address.
  key: (kid, c) =>
    kept(`cloudflare:${c.team}/${kid}`, async () => {
      const r = await fetch(`${teamOrigin(c)}/cdn-cgi/access/certs`);
      if (!r.ok) throw new Error(`Cloudflare Access has no keys for ${c.team}: ${r.status}`);
      const jwk = ((await r.json()) as { keys?: (JsonWebKey & { kid?: string })[] }).keys?.find((k) => k.kid == kid);
      if (!jwk) throw new Error(`Cloudflare Access has no key ${kid}`);
      return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    }),
  head: () => true,
  // Access writes these in the claims. `aud`: a list of the applications the token is for.
  claims: (claims, c, now) =>
    claims.iss == teamOrigin(c) &&
    (Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(c.aud) &&
    typeof claims.exp == "number" &&
    claims.exp * 1000 > now,
  // Access lets a person through only by the address their sign-in gave it.
  verified: () => true,
  shown: (c) => [
    { name: "Team", value: teamOrigin(c) },
    { name: "Application (aud)", value: c.aud },
  ],
};

/** The kinds of proxy, by the `kind` of a `Proxy`. */
const KINDS: { [K in Proxy["kind"]]: Kind<Extract<Proxy, { kind: K }>> } = { "aws-alb": awsAlb, "cloudflare-access": cloudflareAccess };
const kindOf = (proxy: Proxy) => KINDS[proxy.kind] as Kind<Proxy>;

/** The proxy mode, as the Authentication page and the admin agent see it: null `kind`: the deploy's value isn't one this reads. */
export interface ProxyStatus {
  kind: string | null;
  label: string;
  header: string | null;
  values: { name: string; value: string }[];
}

export const proxyStatus = (proxy: Proxy | null): ProxyStatus =>
  proxy
    ? {
        kind: proxy.kind,
        label: kindOf(proxy).label,
        header: kindOf(proxy).header,
        values: kindOf(proxy).shown(proxy),
      }
    : { kind: null, label: "Not set up", header: null, values: [] };

const json = (part: string): unknown => JSON.parse(new TextDecoder().decode(fromBase64url(part)));
const Claims = Schema.Record(Schema.String, Schema.Unknown);
const record = (part: string) => Option.getOrNull(Schema.decodeUnknownOption(Claims)(json(part)));

/**
 * The claims of a header's JWT, if this server's proxy signed it for this server and it has not ended (the rules at
 * the top of this file); else null. `key`: where the public key comes from (the tests'; the proxy's).
 */
export async function claimsOf(token: string, proxy: Proxy, o: { now?: number; key?: Key } = {}): Promise<Record<string, unknown> | null> {
  const kind = kindOf(proxy);
  const now = o.now ?? Date.now();
  try {
    const [h, p, s, more] = token.split(".");
    if (!h || !p || !s || more != null) return null;
    const head = record(h);
    if (!head || head.alg != kind.alg || typeof head.kid != "string" || !/^[\w-]{1,128}$/.test(head.kid)) return null;
    if (!kind.head(head, proxy, now)) return null;
    const key = await (o.key ?? ((kid, c) => kind.key(kid, c)))(head.kid, proxy);
    // The proxy signs the two parts as it sent them, padding too.
    const signed = await crypto.subtle.verify(kind.verify, key, fromBase64url(s), new TextEncoder().encode(`${h}.${p}`));
    const claims = signed ? record(p) : null;
    return claims && kind.claims(claims, proxy, now) ? claims : null;
  } catch {
    return null;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The claims that may hold the person's email address, in the order they are tried. */
const EMAIL_CLAIMS = ["email", "upn", "preferred_username"];

/**
 * The person the claims are; null without a `sub`. Their email address: the first of EMAIL_CLAIMS that looks like one.
 * The `email` claim's is verified when the proxy's kind says so, and `upn`'s is (a directory gives it); never
 * `preferred_username`'s, which a person may choose: it names them, and matches nobody an admin added. Without an
 * address, `handle` is "": the `sub` is never a name.
 */
export function vouchedOf(claims: Record<string, unknown>, proxy: Proxy): Vouched | null {
  const text = (claim: string) => (typeof claims[claim] == "string" ? claims[claim].trim() : "");
  const subject = text("sub");
  if (!subject) return null;
  const claim = EMAIL_CLAIMS.find((c) => EMAIL.test(text(c)));
  const email = claim ? text(claim).toLowerCase() : "";
  const verified = claim == "email" ? kindOf(proxy).verified(claims) : claim == "upn";
  return { provider: "proxy", subject, handle: email, name: text("name") || null, emails: email ? [{ email, verified }] : [], groups: [] };
}

/** Who a header says signed in: its proof, then its person. */
export async function readProxy(token: string, proxy: Proxy, o: { now?: number; key?: Key } = {}): Promise<Vouched | null> {
  const claims = await claimsOf(token, proxy, o);
  return claims ? vouchedOf(claims, proxy) : null;
}

/** /auth/proxy: signs in whoever the proxy says signed in at the company's sign-in. */
export const proxySignIn: Route = Effect.gen(function* () {
  const { platform, request, url } = yield* ctx;
  const signIn = platform.signIn;
  if (signIn.mode != "proxy") return noSuchSignIn();
  const proxy = signIn.proxy;
  if (!proxy)
    return page(
      "Sign-in isn't set up",
      "This server signs in with your company's sign-in, and its setting for it (<code>PROXY_SIGN_IN</code>) isn't one it can read. The person who deployed this server sets it.",
      503
    );
  const v = yield* call(() => readProxy(request.headers.get(kindOf(proxy).header) ?? "", proxy));
  if (!v) return signInFailed(`the proxy's header (${kindOf(proxy).header}) is missing, not this proxy's, or old`);
  return yield* vouchedSignIn(platform, request, v, safeNext(url.searchParams.get("next")), {});
});
