// Who is asking: the one function the rest of the app calls, request ->
// Session | null. A request is someone's when it carries
//
//   - an agent token ("Authorization: Bearer erga_...", tokens.ts): the person
//     it stands for, as their agent (Session.agent), within its scope: admin
//     power only with the admin scope, one document only with the document
//     scope. A token that isn't good (revoked, expired) signs in nobody,
//     whatever cookie comes with it;
//   - else the session cookie sign-in.ts set: the GitHub login and display
//     name with an expiry, signed (server/signed.ts), so
//     the server trusts it without a session store. Only users may sign in
//     (users.ts), and a session lasts only while its person still is one;
//   - else a view cookie (viewCookie): the session the server's browser holds while it renders a document's page in
//     the viewer for an agent (view_page, cloudflare/render.ts). It names the person and one document, holds for a few
//     minutes, and signs them in only on that document's own paths (its viewer and its API), never with admin power
//     and never with their agent (Session.view). It runs an agent's code, so it acts as an agent (whoOf) and makes no
//     token. Anywhere else it signs in nobody, not even the dev login;
//   - in local development, someone always: the person a tab names (?user=Ada,
//     carried along in its links), else whoever this browser signed in as,
//     else the dev login, unless the browser signed out.

import * as Schema from "effect/Schema";
import { signed } from "../signed.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import type { Users } from "../directory/index.ts";
import { cookies } from "./cookies.ts";

export const SESSION_COOKIE = "erga_session";
/** Local development: this browser signed out, so it's nobody (not the dev login) until it signs in again. */
export const SIGNED_OUT = "erga_signed_out";

/**
 * The session cookie's value (server/signed.ts): who signed in; with `doc`, a view cookie, on that document only.
 * 30 days unless the seal says another time.
 */
const SessionCookie = signed(
  "session",
  // n: the person's sign-in number when it was made (Users.endSessions); none counts as 0.
  Schema.Struct({
    login: Schema.String,
    name: Schema.String,
    doc: Schema.optionalKey(Schema.String),
    n: Schema.optionalKey(Schema.Number),
  }),
  30 * 24 * 60 * 60
);

/**
 * The session cookie's value for someone who signed in, good for `seconds`, while their sign-in number is `n` (sign-out
 * raises it; 0: they never signed out, as deploy/aws/check.ts's person).
 */
export const sessionCookie = (secret: string, who: { login: string; name: string }, seconds: number, n = 0) =>
  SessionCookie.seal(secret, { login: who.login, name: who.name, n }, { seconds });

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
  const cookie = as ? null : await cookieSession(platform, request, dev, url);
  if (cookie == "refused") return null;
  const session: Session | null = as
    ? { login: loginOf(as), name: as, as }
    : (cookie ?? (dev && !cookies(request).has(SIGNED_OUT) ? { login: platform.signIn.devLogin!, name: platform.signIn.devLogin! } : null));
  // Locally everyone may sign in, and gets a user's row the first time (last seen, the next). The read rule may say no.
  const user = session ? await users.signedIn(session.login, dev ? session.name : null, { create: dev }) : null;
  if (session && !user) return null;
  // A signed-in browser session comes with admin power: Users.isAdmin decides whether that's any. A view cookie's never.
  if (session && !session.view) session.admin = true;
  // Their picture, from their row (the cookie never carries it): an old cookie shows the new picture too.
  if (session && user?.avatar) session.avatar = user.avatar;
  return session;
}

/**
 * Whoever the session cookie names, if it's valid and unexpired; "refused" for a view cookie away from its document's
 * paths (or expired), which signs in nobody.
 */
async function cookieSession(platform: Platform, request: Request, dev: boolean, url: URL): Promise<Session | null | "refused"> {
  const users = platform.directory.users;
  const raw = cookies(request).get(SESSION_COOKIE);
  const read = await SessionCookie.read(platform.secret, raw);
  if (!read) return null;
  try {
    const s = read.value;
    const doc = s.doc ?? null;
    if (read.expired) return doc == null ? null : "refused";
    if (doc != null && !(await onDocument(platform, url.pathname, doc))) return "refused";
    // Locally, someone with no row yet gets one (findSession); anyone with one passes the access rules, as on a server.
    if (!((dev && !(await users.get(s.login))) || (await users.allowed(s.login)))) return null;
    // Their sign-out since ended it, on every device (Users.endSessions): the cookie has an older sign-in number.
    if (doc == null && ((await users.get(s.login))?.sessions ?? 0) != (s.n ?? 0)) return null;
    return doc == null ? { login: s.login, name: s.name } : { login: s.login, name: s.name, onlyDoc: doc, view: true };
  } catch { return null; }
}

/** How long a view cookie holds, in seconds: one render, with room to spare. */
const VIEW_SECONDS = 300;

/** A view cookie's value (see the top of this file): `login` on the document `doc` (its id), for VIEW_SECONDS from `now`. */
export const viewCookie = (secret: string, login: string, doc: string, now = Date.now()) =>
  SessionCookie.seal(secret, { login, name: login, doc }, { now, seconds: VIEW_SECONDS });

/**
 * Whether `path` is one of the document `doc`'s own: its viewer and API at /d/<doc>/..., at its address, or at /_home;
 * or the operations (/api/tools/...), which reach only that document for a session with onlyDoc (operations/operation.ts).
 */
async function onDocument(platform: Platform, path: string, doc: string): Promise<boolean> {
  if (path.startsWith("/api/tools/")) return true;
  const [, first, second] = /^\/([^/]+)(?:\/([^/]+))?/.exec(path) ?? [];
  if (!first) return false;
  if (first == "d") return second == doc;
  const ref = first == "_home" ? "/_home" : second ? `/${first}/${second}` : null;
  return !!ref && (await platform.directory.find(ref))?.id == doc;
}

/** The person an agent token stands for, within the token's scope; null for a token that isn't good. */
async function tokenSession(platform: Platform, bearer: string, url: URL): Promise<Session | null> {
  const users = platform.directory.users;
  const token = await platform.tokens.verify(bearer).catch(() => null);
  // An ops token signs no one in: it reads only GET /api/ops (server/api.ts), which checks it itself.
  if (!token || token.scope == "ops") return null;
  const session: Session = {
    login: token.login,
    name: token.name,
    agent: token,
    // Admin power only with the admin scope (Users.isAdmin still decides); a document token, its one document.
    ...(token.scope == "admin" ? { admin: true } : {}),
    ...(token.scope == "document" ? { onlyDoc: token.docId ?? "-" } : {}),
  };
  return platform.dev(url) || (await users.allowed(token.login)) ? session : null;
}

/** A name as a login: letters and digits, the rest as dashes ("Ada Lovelace" → "ada-lovelace"). */
const loginOf = (name: string) =>
  name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 39) || "me";

/**
 * Whether the session has admin power now: an admin in person, or with an admin-scope token (Users.actsAsAdmin). An
 * admin's token without the admin scope never has it.
 */
export const actingAdmin = async (users: Users, session: Session | null) => !!session && (await users.actsAsAdmin(whoOf(session)));

