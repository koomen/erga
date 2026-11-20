// The gate: the one check in front of every request, in every configuration. Plain functions that read a request and
// give an answer (a redirect, a cookie, a token) or who is calling (`Caller`): `gate`, for a request; `signedIn` and
// `after`, for what follows it. It does no IO: it reads no body, calls no network and keeps no state, and its only
// tools are HMAC and SHA-256 (`Port`). So it runs as it is in CloudFront Functions, in a Worker in front of Erga, and
// inside Erga's own Worker. `gate` is three parts in turn (`agents`, `edge`, `pass`): on CloudFront each part is a
// function of its own, for its own paths, under CloudFront's 10 KB (tests/gate-mounts.test.ts holds each there).
// A mount (gate/mounts/) turns its platform's request into a `Req`, does what an answer asks, and does the two things
// the gate can't: the sign-in's code exchange (a network call) and reading /oauth/token's body into a header.
//
// The configuration decides what runs, never a second design:
//
//   open       anyone may come in (OAuth mode): a request with no proof goes on as nobody. Else (SSO) only a request
//              with a proof goes on.
//   idp        who signs people in: OIDC issuers by name, or "access" (Cloudflare Access in front: the mount gives
//              each request's person, and the gate has no sign-in, no callback and no shell cookie of its own).
//   content    the documents' domain. Under the shell's host (pages.erga.dev under erga.dev): one member cookie for the
//              shell's domain, and no vouch, accept, ticket or nonce. Anywhere else: the hand-off below.
//
// Every value is `<kind>.<claims>.<HMAC>` (seal), under the one edge key:
//
//   s  shell cookie   the person (provider, subject, email, name), 30 days (Config.hours). __Host-, HttpOnly, Lax.
//   m  member cookie  a member is here: no person, no document. Ends with the shell cookie.
//   t  ticket         a nonce's hash and the member cookie's end, 60 seconds, in an address to the accept host only.
//   i  sign-in state  the state, the PKCE verifier and where to go after, 10 minutes. __Host-, HttpOnly, Lax.
//   a  agent token    the person and a grant's ID, 1 hour (or the time its person chose, on the page). A bearer token.
//                     From a code: with the mark of the code's exchange that made it (`x`).
//   c  code           the person and the grant, with the client, its redirect and its PKCE challenge, 60 seconds.
//   w  wire           the caller, from CloudFront's request function to its response function, 60 seconds
//                     (gate/mounts/cloudfront.ts, WIRE).
//   r  refresh grant  the same as the token, with the client, until the grant's end.
//   d  the mark       the accept gave this browser the member cookie, 20 seconds. In the nonce's cookie, after it.
//   (the nonce says nothing: an HMAC of the request's ID, 120 seconds, in a cookie of the content domain.)
//
// The hand-off, when content is on another site (the frame has no cookie there, and sign-in can't run in a frame):
//
//   <id>.<content>/...             no member cookie: on to the shell's vouch, with a nonce cookie and the nonce's hash
//   <shell>/_edge/vouch            reads __Host-member (SameSite=None: the frame's request comes from another site's
//                                  page, and no browser sends a Lax cookie with it): on to the accept host, with a
//                                  ticket
//   accept.<content>/_edge/accept  the ticket is good and its hash is this browser's nonce: the member cookie for the
//                                  content domain (Partitioned), and back
//
// Each of the three steps answers a page that goes on by itself (`hop`: a meta refresh), never a 302.
// The hand-off needs a browser that keeps a cookie set in a frame on another site (Partitioned). From the browsers'
// documentation (not tested): Chrome and Edge 114, Firefox 103, Safari 26.2 on macOS 26.2, any browser on iOS or
// iPadOS 26.2. An older browser's nonce never comes to the accept: it gets a page that says so (`unsupported`), each
// time, and nothing goes on from there. Content on the shell's site opens in every browser.
// Trap: WebKit sends no cookie at all, not even the shell's own SameSite=None one, with a frame's request that a 302
// from another site started; with a request that the other site's page started, it sends them (dev/gate-browsers.ts
// shows both). A page costs no more requests than a redirect.
//
// What answers a request with no proof, where not everyone may come in: only these. Anything else is a 401 or a 404,
// and nothing else goes on to Erga.
//
//   the agents' metadata, /oauth/token,   an agent's app has no proof before its token. The token endpoint gives one
//   /oauth/register                       only for a code with its PKCE verifier, or for a refresh grant; register
//                                         keeps nothing, and takes only redirects that authorize takes anyway.
//   /_edge/sign-in, /_edge/callback       where a proof is made. The callback counts only with the browser's state.
//   a document's page (other site)        a page that goes on to the vouch, and a nonce: nothing of the document.
//   accept.<content>/_edge/accept         its proof is the ticket, with the browser's nonce.
//
// The vouch and sign-out's frame on the accept host need a member cookie.
//
// Trap: the ticket goes only to the accept host, which has no documents. A document's script reads the address of any
// frame on its own origin (an error page's too), so a ticket in an address there is a ticket stolen.
// Trap: a document's script can set a cookie for the whole content domain, with any name. So two cookies may share a
// name: the gate takes any one that is good (`each`), and never trusts a cookie's presence, only its signature.
// Trap: the gate's cookies and tokens never reach Erga (`GATE_COOKIES`; a mount drops them and Authorization; behind
// Access, Access's proof too: its header and its cookies). Erga hears only the caller, in a header that the mount
// always writes itself.

/** The gate's tools, from where it runs. Each text result is base64url. */
export interface Port {
  hmac(key: string, text: string): string | Promise<string>;
  sha256(text: string): string | Promise<string>;
  /** UTF-8 text as base64url, and back (null: not base64url). */
  enc(text: string): string;
  dec(text: string): string | null;
  /** The optional deny list: a person removed before their proofs end. */
  denied?(sub: string): boolean | Promise<boolean>;
}

/** One OIDC issuer (GitHub: an adapter in the mount's exchange). */
export interface Idp {
  /** Its authorization endpoint, and this server's client there. */
  authorize: string;
  client: string;
  scope: string;
  /** More query values for the authorization endpoint. */
  more?: Record<string, string>;
}

export interface Config {
  /** The edge key. */
  key: string;
  /** The shell's host (with its port, locally), and the content domain: documents at <label>.<content>. */
  shell: string;
  content: string;
  /** HTTPS (not on this machine): Secure, __Host- and SameSite=None need it. */
  https: boolean;
  /** Anyone may come in; a request with no proof goes on as nobody. */
  open: boolean;
  /** Who signs people in. */
  idp: Record<string, Idp> | "access";
  /** Where a browser with no sign-in goes: Erga's page of providers (OAuth), else the gate's own sign-in. */
  chooser?: string;
  /** MCP's authorization server (metadata, authorize, token). Off: a person makes each token on the page. */
  oauth: boolean;
  /** OAuth redirect URIs an agent's app may use, besides this computer's (loopback). */
  redirects?: string[];
  /** The shell cookie's hours (SIGN_IN_DAYS, as hours), and a grant's days (30). */
  hours?: number;
  grantDays?: number;
  /** Local development: a suffix of every cookie's name (one server for each port). */
  tag?: string;
}

/** Who a sign-in says someone is. */
export interface Identity {
  /** The issuer's name (Config.idp's key, or "access"). */
  p: string;
  sub: string;
  email: string;
  name: string;
}

/** Who is calling, as Erga hears it. */
export type Caller =
  | { kind: "none" }
  /** On a content host: a member's browser. */
  | { kind: "member" }
  /** `i`: when they signed in (milliseconds); `e`: when this sign-in ends (seconds). */
  | ({ kind: "person"; i: number; e: number } & Identity)
  /** An agent of the person, by the grant `g`. `x`: the exchange of the grant's code that made its token (`token`). */
  | { kind: "agent"; p: string; sub: string; g: string; x?: string };

export interface Req {
  method: string;
  /** The Host header, lowercase. */
  host: string;
  path: string;
  /** The query, decoded (the first value of each name). */
  query: Record<string, string>;
  /** The headers the gate reads, lowercase: authorization, sec-fetch-dest, x-erga-form. */
  headers: Record<string, string | undefined>;
  /** Every value of each cookie. */
  cookies: Record<string, string[] | undefined>;
  /** The platform's ID of this request: unique. */
  id: string;
  /** Milliseconds. */
  now: number;
  /** idp "access" only: the person of Access's proof, which the mount checked (`e`: its end, seconds). */
  access?: (Identity & { e: number }) | null;
}

export type Answer =
  /** The gate's own answer. */
  | { do: "respond"; status: number; headers: Record<string, string>; cookies: string[]; body: string }
  /** On to Erga, with the caller; `cookies`: for the mount to add to Erga's answer. */
  | { do: "forward"; caller: Caller; cookies: string[] }
  /** The callback: the mount trades the code at the issuer, then calls `signedIn`. `x`: what `signIn`'s caller put. */
  | { do: "exchange"; idp: string; code: string; verifier: string; redirect: string; next: string; x: string }
  /** /oauth/token and /oauth/register: the mount copies the body into x-erga-form, and asks again. */
  | { do: "body" };

/** The header Erga hears the caller in; a mount always writes it. */
export const CALLER = "x-erga-caller";
/** The header /oauth/token's and /oauth/register's body comes in. */
export const FORM = "x-erga-form";
/** The header Erga's answer asks the gate in (`after`); a mount always removes it. */
export const ASK = "x-erga-gate";
/** The header a pasted token goes back in. */
export const TOKEN = "x-erga-token";

const HOUR = 3600;
/**
 * How many days a sign-in lasts when nobody says (Config.hours), and the most that a deploy or an admin may say (from
 * 1 day). The gate asks the issuer only at a sign-in: a person whom the issuer removed keeps their shell cookie until
 * its end. Only the deny list, or their removal from Erga's users, ends it before.
 */
export const SIGN_IN_DAYS = 30;
export const SIGN_IN_DAYS_MAX = 90;
const B64 = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------- values

const same = (a: string, b: string) => {
  let d = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i % (b.length || 1));
  return d == 0;
};

/** The value `<kind>.<claims>.<HMAC>`: `claims` with its end `e` (seconds). */
export async function seal(p: Port, key: string, kind: string, claims: object, e: number): Promise<string> {
  const body = `${kind}.${p.enc(JSON.stringify({ ...claims, e }))}`;
  return `${body}.${await p.hmac(key, body)}`;
}

/** A value's claims, if it is this kind's, the key's, and has not ended. */
export async function open<T = Record<string, unknown>>(
  p: Port,
  key: string,
  kind: string,
  text: string | undefined,
  now: number
): Promise<(T & { e: number }) | null> {
  if (!text || text.length > 4096) return null;
  const [k, claims, mac, more] = text.split(".");
  if (k != kind || !claims || !mac || more != null || !same(mac, await p.hmac(key, `${k}.${claims}`))) return null;
  try {
    const c = JSON.parse(p.dec(claims) ?? "");
    return c && typeof c.e == "number" && c.e > now ? c : null;
  } catch {
    return null;
  }
}

/** The first of a cookie's values that opens (two cookies may share a name). */
async function each<T = Record<string, unknown>>(p: Port, key: string, kind: string, values: string[] | undefined, now: number) {
  for (const v of values ?? []) {
    const c = await open<T>(p, key, kind, v, now);
    if (c) return c;
  }
  return null;
}

// ---------------------------------------------------------------- names, cookies, addresses

const bare = (host: string) => host.replace(/:\d+$/, "");
const scheme = (c: Config) => (c.https ? "https://" : "http://");
/** The host that takes the ticket: it has no documents. */
export const acceptHost = (c: Config) => `accept.${c.content}`;
/** Content under the shell's own host: one member cookie for both, and no hand-off. */
export const sameSite = (c: Config) => `.${c.content}`.endsWith(`.${c.shell}`);
const isContent = (host: string, c: Config) => host.endsWith(`.${c.content}`) && host != c.shell;

const host = (c: Config, n: string) => (c.https ? "__Host-" : "") + n + (c.tag ?? "");
const SHELL = (c: Config) => host(c, "erga");
const STATE = (c: Config) => host(c, "signin");
/** The member cookie's name on the shell: the content domain's own (same site), or the copy only the vouch reads. */
const SHELL_MEMBER = (c: Config) => (sameSite(c) ? MEMBER(c) : host(c, "member"));
const MEMBER = (c: Config) => `member${c.tag ?? ""}`;
const NONCE = (c: Config) => `nonce${c.tag ?? ""}`;
/** Cloudflare Access's own cookies on the shell's host: its proof is in them, as in the header that the mount reads. */
const ACCESS_COOKIES = ["CF_Authorization", "CF_AppSession", "CF_Binding"];
/** Every cookie of the gate's, and behind Access, Access's: a mount drops them from what goes on to Erga. */
export const GATE_COOKIES = (c: Config) => [
  SHELL(c),
  STATE(c),
  host(c, "member"),
  MEMBER(c),
  NONCE(c),
  ...(c.idp == "access" ? ACCESS_COOKIES : []),
];

/** A Set-Cookie. `site`: "Lax", or "None" (a frame's: with Partitioned on content). Max-Age 0 clears it. */
function cookie(c: Config, name: string, value: string, age: number, site: "Lax" | "None", domain?: string): string {
  // Without HTTPS (this machine) a browser refuses SameSite=None: Lax there, where every host is one site.
  const frame = site == "None" && c.https;
  return (
    `${name}=${value}; Path=/; Max-Age=${Math.max(0, age)}; HttpOnly` +
    (domain ? `; Domain=${bare(domain)}` : "") +
    (c.https ? "; Secure" : "") +
    `; SameSite=${frame ? "None" : "Lax"}` +
    (frame && domain ? "; Partitioned" : "")
  );
}

const qs = (o: Record<string, string>) =>
  Object.keys(o)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(o[k])}`)
    .join("&");
const withQuery = (path: string, o: Record<string, string>) => {
  const q = qs(o);
  return q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path;
};

/** A form's (or a query's) fields, the first value of each. */
export function parseForm(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split("&")) {
    const at = part.indexOf("=");
    try {
      const k = decodeURIComponent((at < 0 ? part : part.slice(0, at)).replace(/\+/g, " "));
      if (k && !(k in out)) out[k] = at < 0 ? "" : decodeURIComponent(part.slice(at + 1).replace(/\+/g, " "));
    } catch {}
  }
  return out;
}

/** A path of this site to go to next: never another site's address. */
const local = (next: string | undefined) => (next && /^\/(?![/\\])[\x21-\x7e]*$/.test(next) && !next.includes("\\") ? next : "/");

/** Whether `url` is an address on a document's host (never the accept host, never another site). */
function onContent(url: string | undefined, c: Config): url is string {
  const m = /^(https?:\/\/)([a-z0-9.-]+(?::\d+)?)(\/[\x21-\x7e]*)?$/.exec(url ?? "");
  return !!m && m[1] == scheme(c) && isContent(m[2], c) && m[2] != acceptHost(c) && !url!.includes("\\");
}

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const respond = (status: number, body = "", headers: Record<string, string> = {}, cookies: string[] = []): Answer => ({
  do: "respond",
  status,
  headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...headers },
  cookies,
  body,
});
const to = (location: string, cookies: string[] = []) => respond(302, "", { location }, cookies);
/** A page that goes on to `url` by itself: a hand-off's step (see the top). It runs no script and loads nothing. */
const hop = (url: string, cookies: string[] = []) =>
  respond(
    200,
    `<!doctype html><meta http-equiv="refresh" content="0;url=${url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}">`,
    { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'" },
    cookies
  );
/**
 * The page for a browser that can't end the hand-off (see the top): it kept no cookie that the frame set. Fixed text:
 * it runs no script and loads nothing.
 */
const unsupported = (status: number) =>
  respond(
    status,
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>This browser can't open the document</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:12vh auto;padding:0 1em;background:#fff;color:#222}h1{font-size:1.25em}</style>` +
      `<h1>This browser can't open documents on this server</h1>` +
      `<p>Use one of these browsers:</p>` +
      `<ul><li>Chrome or Edge, version 114 or later</li><li>Firefox, version 103 or later</li>` +
      `<li>Safari 26.2 or later, on macOS 26.2 or later</li>` +
      `<li>Any browser on an iPhone or iPad with iOS or iPadOS 26.2 or later</li></ul>` +
      `<p>If your browser is one of these, it blocks cookies. Allow cookies for this site, then open the document again.</p>`,
    { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" }
  );
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  respond(status, JSON.stringify(body), { "content-type": "application/json", "access-control-allow-origin": "*", ...headers });
const forward = (caller: Caller, cookies: string[] = []): Answer => ({ do: "forward", caller, cookies });
const NOBODY: Caller = { kind: "none" };
/** A page's own request (a frame's or a tab's document): the only kind a redirect to sign in helps. */
export const isPage = (q: Req) => q.method == "GET" && /^(document|iframe|frame)$/.test(q.headers["sec-fetch-dest"] ?? "");

// ---------------------------------------------------------------- the gate

/** The gate's answer to a request: its three parts in turn (see the top). */
export const gate = async (q: Req, c: Config, p: Port): Promise<Answer> =>
  (await agents(q, c, p)) ?? (await edge(q, c, p)) ?? pass(q, c, p);

/** The gate's own addresses: its paths (/_edge/...), and everything on the accept host. */
const own = (q: Req, c: Config) => q.path.startsWith("/_edge/") || q.host == acceptHost(c);

/** A request to any address but the gate's own and the agents' open ones: an answer, or on to Erga with the caller. */
export async function pass(q: Req, c: Config, p: Port): Promise<Answer> {
  const now = Math.floor(q.now / 1000);
  // (On CloudFront `edge` is another function's. An address of the gate's own never goes on, whatever sent it here.)
  if (own(q, c)) return respond(404, "Not found");
  if (isContent(q.host, c)) return content(q, c, p, now);
  // Another host (a custom domain's published site): its own, with nobody; behind SSO, nothing.
  if (q.host != c.shell) return c.open ? forward(NOBODY) : respond(404, "Not found");
  const who = await callerOf(q, c, p, now);
  if (who == "bad") return unauthorized(c);
  if (c.oauth && q.path == "/oauth/authorize") {
    if (who.kind != "person") return isPage(q) ? toSignIn(q, c) : unauthorized(c);
    return asked(q, c) ? forward(who) : respond(400, "This authorization request isn't valid.");
  }
  if (who.kind == "none" && !c.open) return isPage(q) ? toSignIn(q, c) : unauthorized(c);
  return forward(who, await memberFor(q, c, p, who, now));
}

/**
 * The member cookie for a person's page of the shell that came with none: a browser that lost it, and under Access
 * every browser's first page (there is no callback to set it). Only a page: its answer is never a shared cache's.
 * A mount adds it to Erga's answer (on CloudFront the response function asks for it here: the request function's
 * answer is the request).
 */
export const memberFor = async (q: Req, c: Config, p: Port, who: Caller, now = Math.floor(q.now / 1000)): Promise<string[]> =>
  q.host == c.shell && who.kind == "person" && isPage(q) && !(await each(p, c.key, "m", q.cookies[SHELL_MEMBER(c)], now))
    ? [await member(c, p, who.e, now)]
    : [];

const unauthorized = (c: Config) =>
  respond(401, "Sign in first.", {
    "www-authenticate": `Bearer resource_metadata="${scheme(c)}${c.shell}/.well-known/oauth-protected-resource"`,
  });

/** Off to sign in, and back to this address. Under Access there is no sign-in of the gate's: Access signs in, before it. */
const toSignIn = (q: Req, c: Config) =>
  c.idp == "access" ? unauthorized(c) : to(withQuery(c.chooser ?? "/_edge/sign-in", { next: withQuery(q.path, q.query) }));

/**
 * Who calls the shell: an agent by its token, else a person by the shell cookie (or Access's proof). "bad": a token
 * that isn't good (whatever cookie comes with it), or someone on the deny list.
 */
export async function callerOf(q: Req, c: Config, p: Port, now = Math.floor(q.now / 1000)): Promise<Caller | "bad"> {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(q.headers.authorization ?? "")?.[1];
  let who: Caller = NOBODY;
  if (bearer) {
    const a = await open<{ p: string; sub: string; g: string; x?: string }>(p, c.key, "a", bearer, now);
    if (!a) return "bad";
    who = { kind: "agent", p: a.p, sub: a.sub, g: a.g, x: a.x };
  } else if (c.idp == "access") {
    const a = q.access;
    // (Until the proof's end, at most the shell cookie's hours from now.)
    if (a && a.e > now)
      who = {
        kind: "person",
        p: "access",
        sub: a.sub,
        email: a.email,
        name: a.name,
        i: q.now,
        e: Math.min(a.e, now + (c.hours ?? SIGN_IN_DAYS * 24) * HOUR),
      };
  } else {
    const s = await each<Identity & { i: number }>(p, c.key, "s", q.cookies[SHELL(c)], now);
    if (s) who = { kind: "person", p: s.p, sub: s.sub, email: s.email, name: s.name, i: s.i, e: s.e };
  }
  return (who.kind == "person" || who.kind == "agent") && (await p.denied?.(who.sub)) ? "bad" : who;
}

/** The member cookie for the shell, until `e`: for the shell's domain (same site), or the copy that only the vouch reads. */
const member = async (c: Config, p: Port, e: number, now: number) =>
  sameSite(c)
    ? cookie(c, MEMBER(c), await seal(p, c.key, "m", {}, e), e - now, "Lax", c.shell)
    : cookie(c, SHELL_MEMBER(c), await seal(p, c.key, "m", {}, e), e - now, "None");

/** A document's host: a member's browser goes on; another's page goes to the vouch (other site); anything else gets a 401. */
async function content(q: Req, c: Config, p: Port, now: number): Promise<Answer> {
  if (await each(p, c.key, "m", q.cookies[MEMBER(c)], now)) return forward({ kind: "member" });
  if (c.open) return forward(NOBODY);
  // Only a page's own request goes for a cookie (a script's request can't follow the steps).
  if (sameSite(c) || !isPage(q)) return respond(401, "Sign in to Erga, then open the document again.");
  // And one time: the accept leaves its mark (20 seconds). A browser that has the mark and no member cookie dropped
  // the member cookie: it sees the page for it, not a loop. Sign-out ends the mark with the member cookie.
  // Trap: the mark is a signed value, as every cookie that the gate reads. A document's script can set a cookie of
  // this name for the whole content domain: a plain word here would let one document stop every other from opening.
  if (await each(p, c.key, "d", q.cookies[NONCE(c)], now)) return unsupported(401);
  const nonce = await p.hmac(c.key, `nonce.${q.id}`);
  const back = withQuery(`${scheme(c)}${q.host}${q.path}`, q.query);
  return hop(withQuery(`${scheme(c)}${c.shell}/_edge/vouch`, { back, n: await p.sha256(nonce) }), [
    cookie(c, NONCE(c), nonce, 120, "None", c.content),
  ]);
}

/** The gate's own addresses (`own`): an answer, each time. Null: another address. */
export async function edge(q: Req, c: Config, p: Port): Promise<Answer | null> {
  if (!own(q, c)) return null;
  const now = Math.floor(q.now / 1000);
  const shell = c.idp != "access" && q.host == c.shell;
  if (q.method != "GET") return respond(404, "Not found");
  if (q.host == acceptHost(c) && !sameSite(c)) {
    if (q.path == "/_edge/accept") return accept(q, c, p, now);
    // Sign-out's hidden frame: the content domain's member cookie ends, in the shell's partition, and the accept's
    // mark with it (else the next sign-in's first frame gets a 401 while the mark lasts). Only for a browser that has
    // the member cookie (where anyone may come in, there is no proof to ask for).
    if (q.path == "/_edge/sign-out")
      return c.open || (await each(p, c.key, "m", q.cookies[MEMBER(c)], now))
        ? respond(200, "", {}, [cookie(c, MEMBER(c), "", 0, "None", c.content), cookie(c, NONCE(c), "", 0, "None", c.content)])
        : respond(401, "Sign in first.");
  } else if (q.host == c.shell && q.path == "/_edge/vouch" && !sameSite(c)) return vouch(q, c, p, now);
  else if (shell && q.path == "/_edge/sign-in") return signIn(q, c, p, now);
  else if (shell && q.path == "/_edge/callback") return callback(q, c, p, now);
  return respond(404, "Not found");
}

// ---------------------------------------------------------------- sign-in

/** /_edge/sign-in?next=&idp=[&x=]: off to the issuer, with the state cookie. */
async function signIn(q: Req, c: Config, p: Port, now: number): Promise<Answer> {
  const idps = c.idp as Record<string, Idp>;
  const names = Object.keys(idps);
  const name = q.query.idp ?? (names.length == 1 ? names[0] : "");
  const idp = Object.prototype.hasOwnProperty.call(idps, name) ? idps[name] : null;
  if (!idp) return respond(404, "Not found");
  const s = (await p.hmac(c.key, `state.${q.id}`)).slice(0, 32);
  const v = await p.hmac(c.key, `pkce.${q.id}`);
  // `x`: a word of the mount's own, which the callback's exchange hears again (Erga's test of new sign-in values).
  const x = /^[a-z]{1,16}$/.test(q.query.x ?? "") ? q.query.x : "";
  const state = await seal(p, c.key, "i", { s, v, x: local(q.query.next), p: name, t: x }, now + 600);
  const at = withQuery(idp.authorize, {
    response_type: "code",
    client_id: idp.client,
    redirect_uri: `${scheme(c)}${c.shell}/_edge/callback`,
    scope: idp.scope,
    state: s,
    code_challenge: await p.sha256(v),
    code_challenge_method: "S256",
    ...idp.more,
  });
  return to(at, [cookie(c, STATE(c), state, 600, "Lax")]);
}

interface State {
  s: string;
  v: string;
  x: string;
  p: string;
  t: string;
}

/** The sign-in this callback ends, if the browser holds its state. */
const stateOf = async (q: Req, c: Config, p: Port, now: number) => {
  const st = await each<State>(p, c.key, "i", q.cookies[STATE(c)], now);
  return st && q.query.state && same(st.s, q.query.state) ? st : null;
};

/** /_edge/callback?code=&state=: the issuer's answer. The mount trades the code, then `signedIn` signs. */
async function callback(q: Req, c: Config, p: Port, now: number): Promise<Answer> {
  const st = await stateOf(q, c, p, now);
  if (!st) return respond(400, "This sign-in expired. Start again.");
  const clear = [cookie(c, STATE(c), "", 0, "Lax")];
  if (q.query.error || !q.query.code) return to(withQuery(c.chooser ?? "/", c.chooser ? { next: st.x, canceled: "" } : {}), clear);
  return {
    do: "exchange",
    idp: st.p,
    code: q.query.code,
    verifier: st.v,
    redirect: `${scheme(c)}${c.shell}/_edge/callback`,
    next: st.x,
    x: st.t,
  };
}

/**
 * The callback's end, after the mount traded the code: the shell cookie and the member cookie, and on to where the
 * sign-in started (`next`: another path of this site instead). It checks the callback's state again itself: an
 * identity counts only on the request that proved its sign-in.
 */
export async function signedIn(q: Req, c: Config, p: Port, id: Identity, next?: string): Promise<Answer> {
  const now = Math.floor(q.now / 1000);
  const st =
    q.method == "GET" && q.host == c.shell && q.path == "/_edge/callback" && c.idp != "access" ? await stateOf(q, c, p, now) : null;
  if (!st || st.p != id.p || !id.sub || typeof id.sub != "string") return respond(400, "This sign-in expired. Start again.");
  return to(local(next ?? st.x), [...(await signInCookies(q.now, c, p, id)), cookie(c, STATE(c), "", 0, "Lax")]);
}

/**
 * A sign-in's two cookies: the shell cookie that names `id`, and the member cookie, both for the cookie's hours.
 * (`signedIn` sets them. Local development's sign-in, which has no issuer, calls this itself: server/identity.)
 */
export async function signInCookies(nowMs: number, c: Config, p: Port, id: Identity): Promise<string[]> {
  const now = Math.floor(nowMs / 1000);
  const e = now + (c.hours ?? SIGN_IN_DAYS * 24) * HOUR;
  const person = {
    p: id.p,
    sub: id.sub.slice(0, 200),
    email: String(id.email ?? "").slice(0, 254),
    name: String(id.name ?? "").slice(0, 100),
    i: nowMs,
  };
  return [cookie(c, SHELL(c), await seal(p, c.key, "s", person, e), e - now, "Lax"), await member(c, p, e, now)];
}

// ---------------------------------------------------------------- the hand-off

/** /_edge/vouch?back=&n=, on the shell, in the frame: a member's browser gets a ticket for its nonce, to the accept host. */
async function vouch(q: Req, c: Config, p: Port, now: number): Promise<Answer> {
  const m = await each(p, c.key, "m", q.cookies[SHELL_MEMBER(c)], now);
  // With no proof it says nothing of its values: as any path of the shell, a page goes to sign in.
  if (!m) return isPage(q) ? toSignIn(q, c) : unauthorized(c);
  const { back, n } = q.query;
  if (!onContent(back, c) || !n || n.length != 43 || !B64.test(n)) return respond(400, "Not a document's address.");
  const ticket = await seal(p, c.key, "t", { n, m: m.e }, Math.min(now + 60, m.e));
  return hop(withQuery(`${scheme(c)}${acceptHost(c)}/_edge/accept`, { ticket, back }));
}

/** /_edge/accept?ticket=&back=, on the accept host: the ticket, by the browser that holds its nonce, for the member cookie. */
async function accept(q: Req, c: Config, p: Port, now: number): Promise<Answer> {
  const t = await open<{ n: string; m: number }>(p, c.key, "t", q.query.ticket, now);
  if (!t || !onContent(q.query.back, c) || !(t.m > now)) return respond(400, "Open the document again.");
  const nonces = q.cookies[NONCE(c)] ?? [];
  // A good ticket and no nonce at all: the browser kept no cookie that the frame set.
  if (!nonces.length) return unsupported(400);
  let mine = false;
  for (const v of nonces) mine = mine || same(await p.sha256(v), t.n);
  if (!mine) return respond(400, "Open the document again.");
  return hop(q.query.back, [
    cookie(c, MEMBER(c), await seal(p, c.key, "m", {}, t.m), t.m - now, "None", c.content),
    cookie(c, NONCE(c), await seal(p, c.key, "d", {}, now + 20), 20, "None", c.content),
  ]);
}

// ---------------------------------------------------------------- agents: MCP's authorization server

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/[\x21-\x7e]*)?$/;

/** An authorization request's values, if they are whole: a client, a redirect it may have, a PKCE challenge (S256). */
function asked(q: Req, c: Config) {
  const { client_id, redirect_uri, code_challenge, code_challenge_method, response_type } = q.query;
  const ok =
    response_type == "code" &&
    !!client_id &&
    client_id.length <= 200 &&
    !!redirect_uri &&
    redirect_uri.length <= 500 &&
    !redirect_uri.includes("#") &&
    (LOOPBACK.test(redirect_uri) || !!c.redirects?.includes(redirect_uri)) &&
    code_challenge_method == "S256" &&
    !!code_challenge &&
    code_challenge.length == 43 &&
    B64.test(code_challenge);
  return ok ? { client: client_id, redirect: redirect_uri, challenge: code_challenge, state: q.query.state } : null;
}

/**
 * The addresses of MCP's authorization server that are open to an agent's app with no proof: its metadata, and the
 * token endpoint. Null: another address, or the server is off.
 */
export async function agents(q: Req, c: Config, p: Port): Promise<Answer | null> {
  if (!c.oauth || q.host != c.shell) return null;
  const now = Math.floor(q.now / 1000);
  if (q.path == "/oauth/token") return token(q, c, p, now);
  if (q.path == "/oauth/register") return register(q, c, p, now);
  return metadata(q, c);
}

/**
 * POST /oauth/register (its body in x-erga-form): an agent's app registers itself (OAuth Dynamic Client Registration,
 * RFC 7591), as MCP's clients expect when a server names no client of theirs (Claude Code asks no --client-id then).
 * Nothing is kept: the answer is a client ID made here, and those of the redirects the app asked for that `asked`
 * takes anyway (this computer's, or the deploy's list). A client ID proves nothing, as before: authorize
 * checks the redirect again, the code binds it with the client and the PKCE challenge. The client ID carries the app's
 * own name (client_name, readable: "Claude-Code.x1y2z3"), the label of its approval page and its grant in Settings.
 */
async function register(q: Req, c: Config, p: Port, now: number): Promise<Answer> {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST",
  };
  if (q.method == "OPTIONS") return respond(204, "", cors);
  if (q.method != "POST") return respond(405, "POST only");
  const body = q.headers[FORM];
  if (body == null) return { do: "body" };
  const bad = (error_description: string) => json(400, { error: "invalid_client_metadata", error_description });
  let m: { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown } | null = null;
  try {
    // (A mount may start the header with "&", which keeps it from being empty: gate/mounts/lambda.ts.)
    m = JSON.parse(body.replace(/^&/, ""));
  } catch {}
  const uris = m && Array.isArray(m.redirect_uris) ? m.redirect_uris : null;
  if (!uris || !uris.length || uris.length > 10) return bad("redirect_uris: one to ten addresses");
  // An app names every redirect that it has in one request, its hosted ones too (VS Code: vscode.dev's; Cursor:
  // cursor://). The answer keeps the ones that `asked` takes, as RFC 7591 lets a server do, and refuses when none is.
  const mine = uris.filter(
    (u): u is string => typeof u == "string" && u.length <= 500 && !u.includes("#") && (LOOPBACK.test(u) || !!c.redirects?.includes(u))
  );
  if (!mine.length)
    return json(400, { error: "invalid_redirect_uri", error_description: "Only this computer's addresses (http://localhost)." });
  if (m!.token_endpoint_auth_method != null && m!.token_endpoint_auth_method != "none")
    return bad("token_endpoint_auth_method: none only (a public client)");
  const name = typeof m!.client_name == "string" ? m!.client_name : "";
  // (The app's name, before any part in brackets: Claude Code names itself "Claude Code (<the server's name>)".)
  const label =
    name
      .replace(/\s*\(.*$/, "")
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "app";
  const tail = (await p.hmac(c.key, `client.${q.id}`))
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 6)
    .toLowerCase();
  return json(201, {
    client_id: `${label}.${tail}`,
    client_id_issued_at: now,
    ...(name ? { client_name: name.slice(0, 100) } : {}),
    redirect_uris: mine,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

/** A client ID as a person reads it: the app's name that it carries (register), with no random tail or dashes. */
export const clientLabel = (clientId: string) =>
  clientId
    .replace(/\.[a-z0-9]{6}$/, "")
    .replace(/-/g, " ")
    .slice(0, 80);

/** The metadata an agent's app reads before it has a token: fixed JSON. */
function metadata(q: Req, c: Config): Answer | null {
  const origin = `${scheme(c)}${c.shell}`;
  const cache = { "cache-control": "public, max-age=3600" };
  if (q.path == "/.well-known/oauth-protected-resource" || q.path == "/.well-known/oauth-protected-resource/mcp")
    return json(
      200,
      { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "Erga" },
      cache
    );
  if (q.path == "/.well-known/oauth-authorization-server")
    return json(
      200,
      {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      },
      cache
    );
  return null;
}

interface Grant {
  p: string;
  sub: string;
  g: string;
  /** The client. */
  k: string;
  /** The grant's end (seconds). */
  u: number;
  /** The mark of the code's exchange that these tokens come of. */
  x?: string;
}

/**
 * POST /oauth/token (its body in x-erga-form): a code with its PKCE verifier, or a refresh grant, for an agent token.
 *
 * The gate keeps no state, so a code is good for each request of its 60 seconds, to whoever holds its PKCE verifier.
 * Each such exchange marks its tokens with an ID of its own (`x`), which a refresh keeps. Erga takes the tokens of
 * one exchange only for a grant, and ends the grant when a token of another comes (server/identity/grants.ts): a
 * second use of a code gives nothing, and the person sees it.
 */
async function token(q: Req, c: Config, p: Port, now: number): Promise<Answer> {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST",
  };
  if (q.method == "OPTIONS") return respond(204, "", cors);
  if (q.method != "POST") return respond(405, "POST only");
  const body = q.headers[FORM];
  if (body == null) return { do: "body" };
  const f = parseForm(body);
  const bad = (error = "invalid_grant") => json(400, { error });
  let g: (Grant & { e: number }) | null = null;
  if (f.grant_type == "authorization_code") {
    const code = await open<Grant & { r: string; ch: string }>(p, c.key, "c", f.code, now);
    const v = f.code_verifier ?? "";
    if (code && code.r == f.redirect_uri && /^[A-Za-z0-9._~-]{43,128}$/.test(v) && same(await p.sha256(v), code.ch))
      g = { ...code, x: (await p.hmac(c.key, `exchange.${q.id}`)).slice(0, 16) };
  } else if (f.grant_type == "refresh_token") g = await open<Grant>(p, c.key, "r", f.refresh_token, now);
  else return bad("unsupported_grant_type");
  if (!g || g.k != f.client_id || !(g.u > now) || (await p.denied?.(g.sub))) return bad();
  const who = { p: g.p, sub: g.sub, g: g.g, x: g.x };
  const e = Math.min(now + HOUR, g.u);
  return json(200, {
    access_token: await seal(p, c.key, "a", who, e),
    token_type: "Bearer",
    expires_in: e - now,
    refresh_token: await seal(p, c.key, "r", { ...who, k: g.k, u: g.u }, g.u),
  });
}

/**
 * Behind Access, where a browser goes last when it signs out: Access's own sign-out, on the shell's host (Cloudflare
 * answers it, before the gate). It ends Access's sign-in in this browser. Without it the next page of the shell still
 * comes with Access's proof, and the person is signed in again. Null: any other sign-in, which "out" ends (`after`).
 *
 * Sign-out's order, which the page that asks "out" keeps (Erga's: server/identity/sign-in.ts):
 *
 *   1. the page's answer asks "out": the gate's cookies on the shell end
 *   2. the page's hidden frame on the accept host: the content's member cookie ends (the frame needs that cookie)
 *   3. the page goes on to this address: Access's sign-in ends
 *
 * Access's sign-out is last: the page itself is behind Access, and so is each thing that it loads from the shell.
 */
export const signOutAt = (who: Caller): string | null => (who.kind == "person" && who.p == "access" ? "/cdn-cgi/access/logout" : null);

/**
 * What Erga's answer asks of the gate (the header x-erga-gate), on the shell: Erga authorizes, and only the gate signs.
 * Null: nothing (the mount still removes the header). Else what to change in the answer.
 *
 *   code <grant>           POST /oauth/authorize, approved: 302 back to the app with a code for the grant
 *   deny                   POST /oauth/authorize, refused: 302 back to the app with access_denied
 *   token <grant> <end>    a person's POST: an agent token for the grant, until `end` (seconds), in x-erga-token
 *   out                    sign-out: the shell's cookies end (behind Access, Access's sign-in ends after it:
 *                          `signOutAt`). Erga asks it too for a request whose sign-in is from
 *                          before its person's last sign-out: the gate keeps no state, and takes that cookie for good
 *                          until its end, so Erga refuses it (the cookie's `i`) and has the browser's cookies end
 *
 * Each needs a person here in a browser (never an agent: an agent makes no token), on the shell. `who`: the caller
 * the gate found for this request.
 */
export async function after(
  q: Req,
  c: Config,
  p: Port,
  ask: string | null | undefined,
  who: Caller
): Promise<{ status?: number; headers: Record<string, string>; cookies: string[] } | null> {
  if (!ask || q.host != c.shell) return null;
  const now = Math.floor(q.now / 1000);
  const [verb, g, end] = ask.split(" ");
  if (verb == "out")
    return {
      headers: {},
      cookies: [
        cookie(c, SHELL(c), "", 0, "Lax"),
        sameSite(c) ? cookie(c, MEMBER(c), "", 0, "Lax", c.shell) : cookie(c, SHELL_MEMBER(c), "", 0, "None"),
      ],
    };
  if (who.kind != "person" || q.method != "POST") return null;
  const days = now + (c.grantDays ?? 30) * 24 * HOUR;
  const a = c.oauth && q.path == "/oauth/authorize" ? asked(q, c) : null;
  const back = (o: Record<string, string>) => ({
    status: 302,
    headers: { location: withQuery(a!.redirect, a!.state ? { ...o, state: a!.state } : o), ...NO_STORE },
    cookies: [],
  });
  if (verb == "deny" && a) return back({ error: "access_denied" });
  if (!g || !B64.test(g) || g.length > 64) return null;
  if (verb == "code" && a)
    return back({
      code: await seal(p, c.key, "c", { p: who.p, sub: who.sub, g, k: a.client, r: a.redirect, ch: a.challenge, u: days }, now + 60),
    });
  if (verb == "token" && Number(end) > now)
    return {
      headers: { [TOKEN]: await seal(p, c.key, "a", { p: who.p, sub: who.sub, g }, Math.min(Number(end), days)), ...NO_STORE },
      cookies: [],
    };
  return null;
}
