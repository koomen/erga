// Who is asking: the one function the rest of the app calls, request -> Session | null. The gate found the caller
// (caller.ts: it checked the proof, and Erga never sees one); this file says who that caller is here, and what they
// come with:
//
//   - an agent, by its token: the person of its grant (grants.ts), as their agent (Session.agent), within the grant's
//     scope: admin power only with the admin scope, one document only with the document scope. The grant's row is
//     read on every request. An agent whose grant isn't good (revoked, ended, another person's) is nobody, and the
//     app refuses its request before any route (`refusedAgent`);
//   - a person, by their sign-in: their account, found by the issuer and its subject for them (accounts.ts makes the
//     account at the first sign-in). Only users may sign in (users.ts), and a sign-in lasts only while its person
//     still is one, and until they sign out (Users.endSessions ends every sign-in made before it, on every device).
//     The gate keeps no state: it still takes an ended sign-in's cookie for good, so the app's answer asks the gate
//     to end that browser's cookies (`signedOut`);
//   - nobody the gate knows, in a request of the server's own browser: while it renders a document's page in the viewer
//     for an agent (view_page), Erga answers its requests for Erga's own addresses in process (cloudflare/render.ts),
//     and marks each request that the viewer's own page made (`viewRequest`). The mark names the person and one
//     document. It signs them in only on that document's own paths (its viewer and its API), never with admin power
//     and never with their agent (Session.view). It runs an agent's code, so it acts as an agent (whoOf) and makes no
//     token. Anywhere else it signs in nobody.
//
// Trap: the mark is on the Request object, in this isolate's memory. No header, cookie or address can make one, so
// nothing from outside can. Never read it from the request's content.
//
// In local development the gate's issuer is "dev" (mount.ts signs each request in as the person a tab names with
// ?user=Ada, else as the dev login, unless the browser signed in or out itself): its subject is the account's login.
// It counts on this machine only.

import { CALLER, type Caller } from "../../gate/core.ts";
import type { Users } from "../directory/index.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { redirect } from "../http.ts";
import { asking, callerOf, DEV, providerFor } from "./caller.ts";

/** Asked more than once for one request (the route, then the account corner): worked out once. */
const sessions = new WeakMap<Request, Promise<Session | null>>();

/** Who is asking, if anyone: see the top of this file. */
export function sessionOf(platform: Platform, request: Request): Promise<Session | null> {
  let session = sessions.get(request);
  if (!session) sessions.set(request, (session = admit(platform, request)));
  return session;
}

/** Whether the request is an agent's whose grant isn't good: the app answers it 401, whatever it asks. */
export const refusedAgent = async (platform: Platform, request: Request) =>
  callerOf(request).kind == "agent" && !(await sessionOf(platform, request));

async function admit(platform: Platform, request: Request): Promise<Session | null> {
  const url = new URL(request.url);
  // The server's own browser first: its request is never who a header names.
  const mark = views.get(request);
  if (mark) return view(platform, mark, url);
  const who = callerOf(request);
  if (who.kind == "agent") return agent(platform, who, url);
  if (who.kind == "person") return person(platform, request, who, url);
  return null;
}

/** The requests that came with a sign-in from before their person's last sign-out. */
const ended = new WeakSet<Request>();

/**
 * The app's answer to a request, which asks the gate to end the browser's cookies when the request came with an ended
 * sign-in (another browser of the person who signed out, or a copy of the cookie). Without it, that browser's pages go
 * around in a loop behind a gate in front: the gate lets it in, the server sends it to sign in, and the gate has
 * signed it in already.
 */
export const signedOut = <A extends Parameters<typeof asking>[0]>(request: Request, answer: A) => {
  if (!ended.has(request)) return answer;
  if (answer.status < 400) return asking(answer, "out");
  // Trap: CloudFront runs no viewer-response function on an origin's answer of 400 or more (seen on a real
  // distribution, 2026-11-19): the ask would reach the browser, and the cookies stay. So a page gets the same address
  // again, as a redirect that asks; any other request keeps its refusal, with no ask (its next page ends the cookies).
  const page = request.method == "GET" && /^(document|iframe|frame)$/.test(request.headers.get("sec-fetch-dest") ?? "");
  if (!page) return answer;
  const url = new URL(request.url);
  return asking(redirect(url.pathname + url.search, 302, { "Cache-Control": "no-store" }), "out");
};

/** Whether the caller is of local development's issuer (mount.ts), which a gate in front never is: it counts on this machine only. */
const ofDev = (platform: Platform, who: { p: string }) => platform.signIn.mode == "oauth" && who.p == DEV;

/** The account a person's sign-in is: by the issuer's subject for them; locally, the dev issuer's subject is the login. */
async function accountOf(platform: Platform, who: { p: string; sub: string }, url: URL): Promise<string | null> {
  if (ofDev(platform, who)) return platform.dev(url) ? who.sub : null;
  return (await platform.directory.identities.find(providerFor(platform, who), who.sub))?.login ?? null;
}

async function person(platform: Platform, request: Request, who: Extract<Caller, { kind: "person" }>, url: URL): Promise<Session | null> {
  const dev = platform.dev(url);
  const login = await accountOf(platform, who, url);
  if (!login) return null;
  // Their first name, as the pages call them; locally, the name the tab gave, whole.
  const name = (ofDev(platform, who) ? who.name : who.name.trim().split(/\s+/)[0]) || login;
  // Locally everyone may sign in, and gets a user's row the first time (last seen, the next). The read rule may say no.
  const user = await platform.directory.users.signedIn(login, dev ? name : null, { create: dev });
  if (!user) return null;
  // Their sign-out since ended it, on every device (Users.endSessions). Not local development's issuer: mount.ts
  // makes its sign-in anew for each request.
  if (!ofDev(platform, who) && who.i <= user.ended) {
    ended.add(request);
    return null;
  }
  const as = dev ? url.searchParams.get("user")?.trim().slice(0, 40) : null;
  return {
    login: user.login,
    name,
    // A signed-in browser session comes with admin power: Users.isAdmin decides whether that's any.
    admin: true,
    ...(as ? { as } : {}),
    // Their picture, from their row.
    ...(user.avatar ? { avatar: user.avatar } : {}),
  };
}

/** The person an agent's grant stands for, within the grant's scope; null for a grant that isn't good. */
async function agent(platform: Platform, who: Extract<Caller, { kind: "agent" }>, url: URL): Promise<Session | null> {
  // The dev issuer's grants count on this machine only, as its sign-ins do.
  const grant = ofDev(platform, who) && !platform.dev(url) ? null : await platform.grants.good(who).catch(() => null);
  const users = platform.directory.users;
  if (!grant || !(platform.dev(url) || (await users.allowed(grant.login)))) return null;
  return {
    login: grant.login,
    name: (await users.get(grant.login))?.name || grant.login,
    agent: grant,
    // Admin power only with the admin scope (Users.isAdmin still decides); a document grant, its one document.
    ...(grant.scope == "admin" ? { admin: true } : {}),
    ...(grant.scope == "document" ? { onlyDoc: grant.docId ?? "-" } : {}),
  };
}

// ---------------------------------------------------------------- the server's own browser

/** The requests of the server's own browser that Erga answers in process (see the top of this file): each one's person and document. */
const views = new WeakMap<Request, { login: string; doc: string }>();

/** What a gate or the edge in front writes in a request, or reads from it: never a page's script's to say. */
const NOT_A_PAGES = [CALLER, "authorization", "cookie", "cf-connecting-ip", "x-forwarded-for"];

/**
 * A request of the server's own browser, for the app to answer in process (cloudflare/render.ts). It is nobody the
 * gate knows, whatever its headers say (a page's script wrote some of them): it brings no caller, no token, no
 * cookie, and no address that it came from. `as`: the viewer's own page made it, so it is that person's, on the
 * document `doc` (its id).
 */
export function viewRequest(
  url: string,
  init: { method: string; headers: Headers; body?: Blob | string | null },
  as: { login: string; doc: string } | null
): Request {
  const headers = new Headers(init.headers);
  for (const h of NOT_A_PAGES) headers.delete(h);
  const request = new Request(url, { method: init.method, headers, body: init.body, redirect: "manual" });
  if (as) views.set(request, as);
  return request;
}

async function view(platform: Platform, v: { login: string; doc: string }, url: URL): Promise<Session | null> {
  if (!(await onDocument(platform, url.pathname, v.doc))) return null;
  const user = (await platform.directory.users.allowed(v.login)) ? await platform.directory.users.get(v.login) : null;
  return user ? { login: user.login, name: user.login, onlyDoc: v.doc, view: true, ...(user.avatar ? { avatar: user.avatar } : {}) } : null;
}

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

/**
 * Whether the session has admin power now: an admin in person, or with an admin-scope grant (Users.actsAsAdmin). An
 * admin's agent without the admin scope never has it.
 */
export const actingAdmin = async (users: Users, session: Session | null) => !!session && (await users.actsAsAdmin(whoOf(session)));
