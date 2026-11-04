// Who is asking: the one function the rest of the app calls, request ->
// Session | null. A request is someone's when it carries
//
//   - an agent token ("Authorization: Bearer erga_...", tokens.ts): the person
//     it stands for, as their agent (Session.agent), within its scope: admin
//     power only with the admin scope, one document only with the document
//     scope. A token that isn't good (revoked, expired) signs in nobody,
//     whatever cookie comes with it;
//   - else the session cookie sign-in.ts set: the GitHub login and display
//     name with an expiry, signed with HMAC-SHA256 (the platform's secret), so
//     the server trusts it without a session store. Only users may sign in
//     (users.ts), and a session lasts only while its person still is one;
//   - in local development, someone always: the person a tab names (?user=Ada,
//     carried along in its links), else whoever this browser signed in as,
//     else the dev login, unless the browser signed out.

import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import { type Platform, type Session, whoOf } from "../platform.ts";
import type { Users } from "../directory/index.ts";
import { cookies } from "./cookies.ts";

export const SESSION_COOKIE = "erga_session";
/** Local development: this browser signed out, so it's nobody (not the dev login) until it signs in again. */
export const SIGNED_OUT = "erga_signed_out";

const key = (secret: string) => crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

/** `value` with its signature, so it can go to a browser and come back unchanged. */
export async function sign(secret: string, value: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await key(secret), new TextEncoder().encode(value));
  return `${value}.${Base64Url.encode(new Uint8Array(mac))}`;
}

/** The value a signature vouches for, or null. */
export async function unsign(secret: string, signed: string): Promise<string | null> {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  try {
    return (await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      Result.getOrThrow(Base64Url.decode(signed.slice(i + 1))) as Uint8Array<ArrayBuffer>,
      new TextEncoder().encode(value)
    ))
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Asked more than once for one request (the route, then the account corner): worked out once. */
const sessions = new WeakMap<Request, Promise<Session | null>>();

/** Who is asking, if anyone: see the top of this file. */
export function sessionOf(platform: Platform, request: Request): Promise<Session | null> {
  let session = sessions.get(request);
  if (!session) sessions.set(request, session = findSession(platform, request));
  return session;
}

async function findSession(platform: Platform, request: Request): Promise<Session | null> {
  const url = new URL(request.url);
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bearer) return tokenSession(platform, bearer, url);
  const users = platform.directory.users;
  const dev = platform.dev(url);
  const as = dev ? url.searchParams.get("user")?.trim().slice(0, 40) : null;
  const session = as ? { login: loginOf(as), name: as, as }
    : (await cookieSession(platform, request, dev)) ?? (dev && !cookies(request).has(SIGNED_OUT) ? { login: platform.signIn.devLogin!, name: platform.signIn.devLogin! } : null);
  // Locally everyone may sign in, and gets a user's row the first time (last seen, the next). The read rule may say no.
  const user = session && !session.test ? await users.signedIn(session.login, dev ? session.name : null, { create: dev }) : null;
  if (session && !session.test && !user) return null;
  // A signed-in browser session comes with admin power: Users.isAdmin decides whether that's any.
  if (session && !session.test) session.admin = true;
  // Their picture, from their row (the cookie never carries it): an old cookie shows the new picture too.
  if (session && user?.avatar) session.avatar = user.avatar;
  return session;
}

/** Whoever the session cookie names, if it's valid and unexpired. */
async function cookieSession(platform: Platform, request: Request, dev: boolean): Promise<Session | null> {
  const users = platform.directory.users;
  const raw = cookies(request).get(SESSION_COOKIE);
  const value = raw && await unsign(platform.secret, raw);
  if (!value) return null;
  try {
    const s = JSON.parse(Result.getOrThrow(Base64Url.decodeString(value))) as Session & { exp: number };
    if (typeof s.login != "string" || !(s.exp > Date.now() / 1000)) return null;
    // A test person's token was minted by a user, who must still be one.
    if (s.test) return (await users.allowed(s.test.by)) ? { login: s.login, name: s.name, test: { by: s.test.by } } : null;
    // Locally, someone with no row yet gets one (findSession); anyone with one passes the access rules, as on a server.
    return (dev && !(await users.get(s.login))) || (await users.allowed(s.login)) ? { login: s.login, name: s.name } : null;
  } catch { return null; }
}

/** The person an agent token stands for, within the token's scope; null for a token that isn't good. */
async function tokenSession(platform: Platform, bearer: string, url: URL): Promise<Session | null> {
  const users = platform.directory.users;
  const token = await platform.tokens.verify(bearer).catch(() => null);
  if (!token) return null;
  // A test person's token opens only test documents, while whoever minted their test token may sign in.
  const session: Session = {
    login: token.login, name: token.name, agent: token, ...(token.testBy ? { test: { by: token.testBy } } : {}),
    // Admin power only with the admin scope (Users.isAdmin still decides); a document token, its one document.
    ...(token.scope == "admin" && !token.testBy ? { admin: true } : {}), ...(token.scope == "document" ? { onlyDoc: token.docId ?? "-" } : {}),
  };
  if (token.testBy) return (await users.allowed(token.testBy)) ? session : null;
  return platform.dev(url) || (await users.allowed(token.login)) ? session : null;
}

/** A name as a login: letters and digits, the rest as dashes ("Ada Lovelace" → "ada-lovelace"). */
const loginOf = (name: string) =>
  name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 39) || "me";

/**
 * Whether the session has admin power now: an admin in person, or with an admin-scope token (Users.actsAsAdmin). A
 * test person never has; nor has an admin's token without the admin scope.
 */
export const actingAdmin = async (users: Users, session: Session | null) => !!session && (await users.actsAsAdmin(whoOf(session)));

