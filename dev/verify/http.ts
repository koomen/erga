// The verify harness's checks with requests alone (dev/verify.ts): what the gate answers, whatever a browser does.
// A person here is a cookie jar that signs in at the test issuer over HTTP. The checks forge values with the gate's
// own `seal` and the run's edge key (an expired value is a real value whose time passed), and ask the origin
// afterwards which requests it saw (stub.ts, /_stub/seen): a refused request has no row there.
//
// ORIGIN is what the checks know of the origin. For the real Erga: its addresses here, and `seen` from Erga's logs.

import { readFileSync } from "node:fs";
import https from "node:https";
import { resolve } from "node:path";
import { seal } from "../../gate/core.ts";
import { webPort } from "../../gate/port.ts";
import { OPEN as ACCESS_OPEN, accessSignIn, toAccess } from "./access.ts";
import { acceptHost, docHost, otherSite, type Report, type Run } from "./run.ts";

export const ORIGIN = {
  /** An address of the shell that says who calls (JSON: caller, cookies, authorization), and one of a document. */
  whoami: "/api/whoami",
  document: "/t/pass/",
  /** The pages that ask the gate: for a code, for a token, to sign out. */
  authorize: "/oauth/authorize",
  newToken: "/tokens/new",
  signOut: "/signed-out",
  /** Which of the harness's requests the origin saw, by ID: asked as `jar`'s person. */
  async seen(run: Run, jar: Jar, ids: string[]): Promise<Record<string, Saw>> {
    const a = await ask(`https://${run.shell}/_stub/seen`, {
      jar,
      body: JSON.stringify(ids),
      headers: { "content-type": "application/json" },
    });
    if (!a.stub) throw new Error(`The origin's log did not answer: ${a.status} ${a.text.slice(0, 100)}`);
    return JSON.parse(a.text);
  },
};

interface Saw {
  id: string;
  method: string;
  host: string;
  path: string;
  caller: { kind: string; p?: string; sub?: string; g?: string; x?: string; email?: string };
  cookies: string[];
  authorization: boolean;
}

// ---------------------------------------------------------------- a client with a cookie jar

/** Cookies by where they go: "=host" (that host only) or ".domain" (it and the hosts under it). */
export type Jar = Map<string, Map<string, string>>;
export interface Answer {
  url: string;
  status: number;
  headers: Headers;
  text: string;
  /** Its Set-Cookie lines. */
  set: string[];
  /** The origin answered (not the gate). */
  stub: boolean;
}

const cookiesFor = (jar: Jar, host: string) =>
  [...jar]
    .filter(([at]) => at == `=${host}` || (at[0] == "." && (host == at.slice(1) || host.endsWith(at))))
    .flatMap(([, cookies]) => [...cookies].map(([k, v]) => `${k}=${v}`))
    .join("; ");
function keep(jar: Jar, host: string, line: string) {
  const [pair, ...attrs] = line.split("; ");
  const at = pair.indexOf("=");
  const domain = attrs.find((a) => /^domain=/i.test(a))?.slice(7);
  const key = domain ? `.${domain}` : `=${host}`;
  if (!jar.has(key)) jar.set(key, new Map());
  if (attrs.includes("Max-Age=0")) jar.get(key)!.delete(pair.slice(0, at));
  else jar.get(key)!.set(pair.slice(0, at), pair.slice(at + 1));
}
export const cookieOf = (jar: Jar, at: string, name: string) => jar.get(at)?.get(name) ?? "";

export async function ask(
  url: string,
  o: { method?: string; headers?: Record<string, string>; body?: string; jar?: Jar; dest?: string; id?: string } = {}
): Promise<Answer> {
  const host = new URL(url).hostname;
  const headers: Record<string, string> = { ...o.headers };
  if (o.dest) headers["sec-fetch-dest"] = o.dest;
  if (o.id) headers["x-verify-id"] = o.id;
  const cookie = [headers.cookie, o.jar ? cookiesFor(o.jar, host) : ""].filter(Boolean).join("; ");
  if (cookie) headers.cookie = cookie;
  if (o.body != null && !headers["content-type"]) headers["content-type"] = "application/x-www-form-urlencoded";
  const r = await fetch(url, { method: o.method ?? (o.body != null ? "POST" : "GET"), headers, body: o.body, redirect: "manual" });
  const set = r.headers.getSetCookie();
  if (o.jar) for (const line of set) keep(o.jar, host, line);
  return { url, status: r.status, headers: r.headers, text: await r.text(), set, stub: r.headers.get("x-stub") == "1" };
}

/** Whether the gate itself answered, by an answer's headers: each of its own answers has both (gate/core.ts, respond). */
const gateSaid = (header: (name: string) => unknown) =>
  header("referrer-policy") == "no-referrer" && header("x-content-type-options") == "nosniff";

/** A WebSocket's first request: its answer's status (101: the socket opened), and who answered. */
const socket = (url: string, headers: Record<string, string>): Promise<{ status: number; stub: boolean; gate: boolean }> =>
  new Promise((done) => {
    const r = https.request(url, {
      headers: {
        ...headers,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    r.on("upgrade", (res, sock) => (sock.destroy(), done({ status: 101, stub: res.headers["x-stub"] == "1", gate: false })));
    r.on(
      "response",
      (res) => (
        res.resume(), done({ status: res.statusCode ?? 0, stub: res.headers["x-stub"] == "1", gate: gateSaid((name) => res.headers[name]) })
      )
    );
    r.on("error", () => done({ status: 0, stub: false, gate: false }));
    r.end();
  });

/** Where a hand-off's page goes on to (core.ts, hop). */
const hopOf = (a: Answer) =>
  a.status == 200 && !a.stub
    ? (/^<!doctype html><meta http-equiv="refresh" content="0;url=([^"]*)">$/.exec(a.text)?.[1] ?? "").replace(/&amp;/g, "&")
    : "";
const attrs = (set: string[], name: string) =>
  set
    .find((l) => l.startsWith(`${name}=`))
    ?.split("; ")
    .slice(1)
    .sort()
    .join("; ") ?? "(not set)";

/** Signs `who` in: the gate's sign-in, the issuer's form, the callback. The answers, in order. */
export async function signIn(run: Run, who: string, jar: Jar, next = "/"): Promise<Answer[]> {
  const start = await ask(`https://${run.shell}/_edge/sign-in?next=${encodeURIComponent(next)}`, { jar, dest: "document" });
  const form = await ask(start.headers.get("location") ?? "", { body: new URLSearchParams({ who, pass: run.idp.password }).toString() });
  const back = await ask(form.headers.get("location") ?? "", { jar, dest: "document" });
  return [start, form, back];
}

/** Opens a document as a frame does, through each page that goes on by itself. The answers, in order. */
export async function openDoc(url: string, jar: Jar, id?: string): Promise<Answer[]> {
  const trail: Answer[] = [];
  for (let i = 0; i < 5 && url; i++) {
    trail.push(await ask(url, { jar, dest: "iframe", id }));
    url = hopOf(trail.at(-1)!);
  }
  return trail;
}

// ---------------------------------------------------------------- Erga's routes

/** The files that answer routes: the list that the audit's test has (not the dev server's own). */
const routeFiles = (): string[] => {
  const test = readFileSync(resolve(import.meta.dir, "../../tests/agent-actions.test.ts"), "utf8");
  const list = /const ROUTE_FILES = \[([^\]]+)\]/.exec(test)?.[1] ?? "";
  const files = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((f) => f != "cloudflare/dev.ts");
  if (files.length < 5) throw new Error("tests/agent-actions.test.ts: the list of route files did not parse.");
  return files;
};
/** The gate's own addresses, and some that no list has (a document's API, a document's files). */
const MORE = [
  ...[
    "/_edge/sign-in",
    "/_edge/callback",
    "/_edge/vouch",
    "/_edge/accept",
    "/_edge/sign-out",
    "/_edge/x",
    "/oauth/token",
    "/oauth/register",
    "/oauth/authorize",
  ].flatMap((path) => ["GET", "POST", "OPTIONS"].map((method) => ({ method, path }))),
  ...[
    "/",
    "/.well-known/openid-configuration",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/ada/untitled",
    "/d/x1/api/start",
    "/t/pass/",
    "/t/pass/file.txt",
  ].map((path) => ({
    method: "GET",
    path,
  })),
  { method: "POST", path: "/mcp" },
  { method: "POST", path: "/oauth/register" },
  { method: "WS", path: "/d/x1/api/room" },
  { method: "WS", path: "/t/pass/room" },
];

/** Every route of Erga's lists (shared/routes.ts), read from the source: its method and an address that matches. */
export function routes(): { method: string; path: string }[] {
  const out = new Map<string, { method: string; path: string }>();
  for (const file of routeFiles()) {
    const src = readFileSync(resolve(import.meta.dir, "../..", file), "utf8");
    const rows = [...src.matchAll(/\bmethod:\s*"(GET|POST|PUT|PATCH|DELETE|WS)",\s*path:\s*(["`])([^"`]+)\2/g)];
    if (!rows.length) throw new Error(`${file}: no route's row parsed.`);
    for (const m of rows) out.set(`${m[1]} ${m[3]}`, { method: m[1], path: m[3].replace(/<[^>]+>|:\w+/g, "x1") });
  }
  for (const r of MORE) out.set(`${r.method} ${r.path}`, r);
  return [...out.values()];
}

/**
 * The addresses that answer with no proof (the plan's open paths; and what the gate answers there). The vouch, and
 * sign-out's frame on the accept host, are not among them: with no member cookie each answers 401. Behind Access the
 * gate has no sign-in and no callback.
 */
const OPEN = (run: Run) =>
  [
    ...(run.who == "access" ? [] : ["shell GET /_edge/sign-in 302", "shell GET /_edge/callback 400"]),
    "shell GET /.well-known/oauth-protected-resource 200",
    "shell GET /.well-known/oauth-protected-resource/mcp 200",
    "shell GET /.well-known/oauth-authorization-server 200",
    "shell GET /oauth/token 405",
    "shell POST /oauth/token 400",
    "shell OPTIONS /oauth/token 204",
    "shell GET /oauth/register 405",
    "shell POST /oauth/register 400",
    "shell OPTIONS /oauth/register 204",
    "accept GET /_edge/accept 400",
  ].filter((row) => otherSite(run) || !/accept/.test(row));

// ---------------------------------------------------------------- the checks

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const uid = () => crypto.randomUUID();
/** A value with one character of its claims changed, under the old signature. */
const forged = (v: string) => v.replace(/\.(.)/, (_m, ch) => `.${ch == "A" ? "B" : "A"}`);
const pool = async <T, R>(items: T[], run: (item: T) => Promise<R>, n = 12): Promise<R[]> => {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]);
      }
    })
  );
  return out;
};

export async function httpChecks(run: Run, report: Report): Promise<void> {
  const shell = `https://${run.shell}`;
  const sso = run.who != "oauth";
  const access = run.who == "access";
  const other = otherSite(run);
  const now = Math.floor(Date.now() / 1000);
  const mint = (kind: string, claims: object, e: number, key = run.key) => seal(webPort, key, kind, claims, e);
  const SHELL = "__Host-erga";
  /** The cookie that names the person on the shell: the gate's own, or Access's. */
  const PROOF = access ? "CF_Authorization" : SHELL;
  const COPY = other ? "__Host-member" : "member";
  const memberAt = other ? `=${run.shell}` : `.${run.shell}`;

  // --- sign-in
  const ada: Jar = new Map();
  const noProof = await ask(`${shell}/documents?x=1`, { dest: "document" });
  if (access)
    report.add(
      "Access: a page with no proof goes to the team's sign-in",
      toAccess(run, noProof),
      `${noProof.status} ${(noProof.headers.get("location") ?? "").slice(0, 60)}`
    );
  else if (sso)
    report.add(
      "A page with no proof goes to sign in, and back to its address",
      noProof.status == 302 && noProof.headers.get("location") == `/_edge/sign-in?next=${encodeURIComponent("/documents?x=1")}`,
      `${noProof.status} ${noProof.headers.get("location")}`
    );
  else
    report.add(
      "OAuth: a page with no proof goes on as nobody",
      noProof.stub && JSON.parse(noProof.text).caller.kind == "none",
      `${noProof.status}`
    );
  /** The answer that ends the sign-in: it sets the gate's cookies. */
  let back: Answer;
  if (access) {
    const trail = await accessSignIn(run, "ada", ada, "/documents?x=1");
    back = trail.at(-1)!;
    report.add(
      "Sign-in: Access, the issuer (PKCE), the team's callback, and back to the page",
      back.stub && back.url == `${shell}/documents?x=1` && JSON.parse(back.text).caller.kind == "person",
      trail.map((a) => `${a.status} ${new URL(a.url).host}`).join(" > ")
    );
    const proof = trail.flatMap((a) => (new URL(a.url).host == run.shell ? a.set : [])).find((l) => l.startsWith(`${PROOF}=`)) ?? "";
    report.add(
      "Access's cookie on the shell is HttpOnly and Secure; the gate sets no shell cookie of its own",
      /; HttpOnly/i.test(proof) && /; Secure/i.test(proof) && !back.set.some((l) => l.startsWith(`${SHELL}=`)),
      proof.replace(/=[^;]*/, "=…") || "(not set)"
    );
    report.add(
      "The member cookie's copy on the shell comes with the person's first page: __Host-, HttpOnly, SameSite=None",
      /^HttpOnly; Max-Age=\d+; Path=\/; SameSite=None; Secure$/.test(attrs(back.set, COPY)),
      attrs(back.set, COPY)
    );
  } else {
    const [start, form, callback] = await signIn(run, "ada", ada, "/documents?x=1");
    back = callback;
    report.add(
      "Sign-in: the gate, the issuer (PKCE), the callback, and back",
      start.status == 302 && form.status == 302 && back.status == 302 && back.headers.get("location") == "/documents?x=1",
      `${start.status} ${form.status} ${back.status} ${back.headers.get("location")}`
    );
    report.add(
      "The shell cookie: __Host-, HttpOnly, Secure, Lax, 12 hours",
      attrs(back.set, SHELL) == "HttpOnly; Max-Age=2592000; Path=/; SameSite=Lax; Secure",
      attrs(back.set, SHELL)
    );
    report.add(
      other
        ? "The member cookie's copy on the shell: __Host-, HttpOnly, SameSite=None"
        : "The member cookie: the shell's domain, HttpOnly, Lax",
      attrs(back.set, COPY) ==
        (other
          ? "HttpOnly; Max-Age=2592000; Path=/; SameSite=None; Secure"
          : `Domain=${run.shell}; HttpOnly; Max-Age=2592000; Path=/; SameSite=Lax; Secure`),
      attrs(back.set, COPY)
    );
    const canceled = await signIn(run, "cancel", new Map());
    report.add(
      "A sign-in that the person refused sets no cookie",
      canceled[2].status == 302 && !canceled[2].set.some((l) => /^(__Host-erga|member|__Host-member)=[^;]/.test(l)),
      `${canceled[2].status} ${canceled[2].headers.get("location")}`
    );
    // A callback in a browser that did not start the sign-in (no state cookie): refused.
    const stolen = await ask(form.headers.get("location")!, { dest: "document" });
    report.add(
      "A callback with no state cookie is refused",
      stolen.status == 400 && !stolen.set.length,
      `${stolen.status} ${stolen.text.slice(0, 40)}`
    );
  }
  /** The person's proof on the shell: the gate's shell cookie, or Access's cookie. */
  const shellCookie = cookieOf(ada, `=${run.shell}`, PROOF);
  const memberCookie = cookieOf(ada, memberAt, COPY);
  const me = await ask(shell + ORIGIN.whoami, {
    jar: ada,
    headers: { cookie: "other=1", "x-erga-caller": b64({ kind: "person", sub: "sub-bob" }) },
  });
  const saw = me.stub ? (JSON.parse(me.text) as Saw) : null;
  report.add(
    "The origin hears the person from the gate, whatever header came in",
    saw?.caller.kind == "person" &&
      saw.caller.email == "ada@example.com" &&
      (access ? saw.caller.p == "access" : saw.caller.sub == "sub-ada"),
    JSON.stringify(saw?.caller)
  );
  report.add(
    access
      ? "The gate's cookies and Access's proof do not reach the origin; other cookies do"
      : "The gate's cookies do not reach the origin; other cookies do",
    !!saw && saw.cookies.join() == "other",
    `the origin's cookies: ${saw?.cookies.join(", ")}`
  );

  // --- the hand-off, and its values
  {
    const doc = (n: number) => `https://${docHost(run, n)}${ORIGIN.document}`;
    const first = await openDoc(doc(1), ada);
    const page = first.at(-1)!;
    if (sso && other) {
      report.add(
        "Hand-off: the document, the vouch, the accept, the document (4 requests)",
        first.length == 4 && page.stub,
        first.map((a) => `${a.status} ${new URL(a.url).host}${new URL(a.url).pathname}`).join(" > ")
      );
      report.add(
        "The nonce: the content domain, HttpOnly, SameSite=None, Partitioned, 120 s",
        attrs(first[0].set, "nonce") == `Domain=${run.content}; HttpOnly; Max-Age=120; Partitioned; Path=/; SameSite=None; Secure`,
        attrs(first[0].set, "nonce")
      );
      report.add(
        "The member cookie: the content domain, HttpOnly, SameSite=None, Partitioned",
        /^Domain=\S+; HttpOnly; Max-Age=\d+; Partitioned; Path=\/; SameSite=None; Secure$/.test(attrs(first[2]?.set ?? [], "member")),
        attrs(first[2]?.set ?? [], "member")
      );
      report.add(
        "The ticket goes only to the accept host",
        new URL(first[2]?.url ?? shell).host == acceptHost(run) && !first[3]?.url.includes("ticket"),
        ""
      );
      // The same ticket again: in a browser with no nonce, in this one (its nonce is done), and with another nonce.
      const accept = first[2].url;
      const bare = await ask(accept, { dest: "iframe" });
      const again = await ask(accept, { jar: ada, dest: "iframe" });
      const wrong = await ask(accept, { dest: "iframe", headers: { cookie: `nonce=${await webPort.hmac("another-key", "nonce")}` } });
      report.add(
        "A2: a ticket with no nonce, a used nonce or another nonce is refused",
        [bare, again, wrong].every((a) => a.status == 400 && !a.set.some((l) => l.startsWith("member=") && !l.includes("Max-Age=0"))),
        `${bare.status} ${again.status} ${wrong.status}`
      );
      // A browser that keeps no cookie of the frame's: its ticket is good, and no nonce comes. Each time, the gate's page
      // for it, which goes nowhere; so does a browser that has the accept's mark (a signed value) and no member cookie.
      const second = await ask(accept, { dest: "iframe" });
      const mark = await mint("d", {}, now + 20);
      const dropped = await ask(doc(3), { dest: "iframe", headers: { cookie: `nonce=${mark}` } });
      // A document's script can set a cookie of the mark's name for the whole content domain: a word, or a mark whose
      // time passed. Neither is the gate's mark: the page goes to the vouch, as with no cookie.
      const planted = await pool(["done", await mint("d", {}, now - 5)], (v) =>
        ask(doc(3), { dest: "iframe", headers: { cookie: `nonce=${v}` } })
      );
      report.add(
        "A cookie of the accept's mark's name that a document's script set stops no hand-off: the page goes to the vouch",
        planted.every((a) => hopOf(a).startsWith(`${shell}/_edge/vouch?`)),
        planted.map((a) => `${a.status}${hopOf(a) ? " on to the vouch" : ""}`).join("; ")
      );
      const told = (a: Answer, status: number) =>
        a.status == status &&
        !a.stub &&
        !a.set.length &&
        a.text.includes("This browser can't open documents on this server") &&
        a.headers.get("content-security-policy") == "default-src 'none'; style-src 'unsafe-inline'" &&
        !/<script|http-equiv|src=|href=/i.test(a.text);
      report.add(
        "An unsupported browser (it keeps no cookie of the frame's) sees the gate's clear page at the accept, each time: fixed, with no script, and no way on",
        told(bare, 400) && told(second, 400) && told(dropped, 401) && wrong.text == "Open the document again.",
        `no nonce: ${bare.status}, then ${second.status}; the mark and no member cookie: ${dropped.status}; another nonce: ${wrong.status} "${wrong.text.slice(0, 30)}"`
      );
      // New hand-offs, stopped before the accept: a ticket whose time passed, and a way back that is not a document.
      const eve: Jar = new Map([[`=${run.shell}`, new Map([[COPY, memberCookie]])]]);
      const hop = await ask(doc(2), { jar: eve, dest: "iframe" });
      const n = new URL(hopOf(hop)).searchParams.get("n")!;
      const late = await ask(
        `https://${acceptHost(run)}/_edge/accept?ticket=${await mint("t", { n, m: now + 3600 }, now - 5)}&back=${encodeURIComponent(doc(2))}`,
        { jar: eve, dest: "iframe" }
      );
      const good = await mint("t", { n, m: now + 3600 }, now + 60);
      const away = await pool(
        ["https://example.com/", `https://${acceptHost(run)}/`, `https://${run.shell}/`, `http://${docHost(run, 2)}/`],
        (to) => ask(`https://${acceptHost(run)}/_edge/accept?ticket=${good}&back=${encodeURIComponent(to)}`, { jar: eve, dest: "iframe" })
      );
      report.add("An expired ticket is refused", late.status == 400, `${late.status}`);
      report.add(
        "The accept goes back only to a document's address",
        away.every((a) => a.status == 400),
        away.map((a) => a.status).join(" ")
      );
      const vouched = await pool(["https://example.com/", `https://${acceptHost(run)}/`, `https://${run.shell}/`], (to) =>
        ask(`${shell}/_edge/vouch?n=${n}&back=${encodeURIComponent(to)}`, { jar: ada, dest: "iframe" })
      );
      report.add(
        "The vouch gives a ticket only for a document's address",
        vouched.every((a) => a.status == 400),
        vouched.map((a) => a.status).join(" ")
      );
      const vouch = `${shell}/_edge/vouch?n=${n}&back=${encodeURIComponent(doc(2))}`;
      const noMember = await ask(vouch, { dest: "iframe" });
      const noMemberScript = await ask(vouch);
      const noValues = await ask(`${shell}/_edge/vouch`);
      const outAt = `https://${acceptHost(run)}/_edge/sign-out`;
      const outBare = await ask(outAt, { dest: "iframe" });
      report.add(
        access
          ? "The vouch with no member cookie gets a 401, with no ticket (behind Access the gate has no sign-in)"
          : "The vouch with no member cookie: a page goes to sign in, anything else gets a 401; no ticket, and nothing of its values",
        noMember.status == (access ? 401 : 302) &&
          noMemberScript.status == 401 &&
          noValues.status == 401 &&
          !/ticket/.test(noMember.text + noMember.headers.get("location")),
        `${noMember.status} ${noMemberScript.status} ${noValues.status}`
      );
      report.add(
        "Sign-out's frame on the accept host needs a member cookie: with none, a 401 and no cookie",
        outBare.status == 401 && !outBare.set.length,
        `${outBare.status}`
      );
    } else
      report.add(
        sso ? "Same site: the document opens with one request" : "OAuth: the document opens with one request (no hand-off)",
        first.length == 1 && page.stub,
        `${first.length} requests`
      );
    const second = await openDoc(doc(2), ada);
    report.add("A later document opens with one request", second.length == 1 && second[0].stub, `${second.length} requests`);
    const kind = second[0].stub ? JSON.parse((await ask(`https://${docHost(run, 2)}/t/pass/whoami`, { jar: ada })).text).caller.kind : "";
    report.add(
      sso ? "On a document's host the origin hears a member, no person" : "OAuth: on a document's host the origin hears nobody",
      kind == (sso ? "member" : "none"),
      kind
    );
  }

  // --- agents: MCP's authorization server
  const verifier = `${uid()}${uid()}`.replace(/-/g, "");
  const redirect = "http://127.0.0.1:8976/callback";
  const authorize = `${shell}${ORIGIN.authorize}?${new URLSearchParams({ response_type: "code", client_id: "verify-agent", redirect_uri: redirect, code_challenge: await webPort.sha256(verifier), code_challenge_method: "S256", state: "st-1" })}`;
  const meta = await pool(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"],
    (p) => ask(shell + p)
  );
  const as = meta[2].status == 200 ? JSON.parse(meta[2].text) : {};
  report.add(
    "Agents: the metadata answers with no proof, and names this server",
    meta.every((a) => a.status == 200 && !a.stub) &&
      JSON.parse(meta[0].text).resource == `${shell}/mcp` &&
      as.token_endpoint == `${shell}/oauth/token` &&
      as.authorization_endpoint == `${shell}/oauth/authorize`,
    meta.map((a) => a.status).join(" ")
  );
  const bareMcp = await ask(`${shell}/mcp`, { method: "POST", headers: { authorization: "Bearer nothing" } });
  report.add(
    "Agents: a bad token gets a 401 that names the metadata",
    bareMcp.status == 401 &&
      (bareMcp.headers.get("www-authenticate") ?? "").includes(`resource_metadata="${shell}/.well-known/oauth-protected-resource"`),
    `${bareMcp.status} ${bareMcp.headers.get("www-authenticate")}`
  );
  const cold = await ask(authorize);
  const coldPage = await ask(authorize, { dest: "document" });
  report.add(
    access
      ? "Agents: authorize is behind Access (with no proof: off to the team's sign-in)"
      : "Agents: authorize is behind the shell cookie (401; a page goes to sign in)",
    access
      ? toAccess(run, cold) && toAccess(run, coldPage)
      : cold.status == 401 &&
          coldPage.status == 302 &&
          (coldPage.headers.get("location") ?? "").startsWith(
            sso ? "/_edge/sign-in?next=%2Foauth%2Fauthorize" : "/auth/sign-in?next=%2Foauth%2Fauthorize"
          ),
    `${cold.status} ${coldPage.status} ${coldPage.headers.get("location")?.slice(0, 50)}`
  );
  const consent = await ask(authorize, { jar: ada, dest: "document" });
  const evil = await ask(authorize.replace(encodeURIComponent(redirect), encodeURIComponent("https://example.com/cb")), {
    jar: ada,
    dest: "document",
  });
  report.add(
    "Agents: authorize passes a whole request to the origin, and refuses another redirect",
    consent.stub && evil.status == 400 && !evil.stub,
    `${consent.status} ${evil.status}`
  );
  const denied = await ask(authorize, { jar: ada, body: "do=deny" });
  const approved = await ask(authorize, { jar: ada, body: "do=approve" });
  const code = new URL(approved.headers.get("location") ?? "http://x").searchParams;
  report.add(
    "Agents: the person's approval gives a code to the app's own address; a refusal gives none",
    approved.status == 302 &&
      approved.headers.get("location")!.startsWith(`${redirect}?code=c.`) &&
      code.get("state") == "st-1" &&
      !approved.headers.has("x-erga-gate") &&
      denied.headers.get("location") == `${redirect}?error=access_denied&state=st-1`,
    `${approved.status} ${denied.headers.get("location")}`
  );
  const trade = (o: Record<string, string>) => ask(`${shell}/oauth/token`, { body: new URLSearchParams(o).toString() });
  const grant = {
    grant_type: "authorization_code",
    code: code.get("code") ?? "",
    code_verifier: verifier,
    redirect_uri: redirect,
    client_id: "verify-agent",
  };
  const bad = await pool(
    [
      { ...grant, code_verifier: `${verifier}x` },
      { ...grant, client_id: "another" },
      { ...grant, redirect_uri: `${redirect}/x` },
      { ...grant, code: forged(grant.code) },
      {
        ...grant,
        code: await mint(
          "c",
          { p: "sso", sub: "sub-ada", g: "g", k: "verify-agent", r: redirect, ch: await webPort.sha256(verifier), u: now + 99 },
          now - 5
        ),
      },
    ],
    trade
  );
  const traded = await trade(grant);
  const tokens = traded.status == 200 ? JSON.parse(traded.text) : {};
  report.add(
    "Agents: a code with its PKCE verifier gives a token for 1 hour",
    traded.status == 200 && tokens.token_type == "Bearer" && tokens.expires_in == 3600,
    `${traded.status} ${traded.text.slice(0, 60)}`
  );
  report.add(
    "Agents: the token endpoint's answer is open to a page of any origin (CORS)",
    traded.headers.get("access-control-allow-origin") == "*",
    `access-control-allow-origin: ${traded.headers.get("access-control-allow-origin")}`
  );
  report.add(
    "Agents: a wrong verifier, client, redirect, a forged code and an expired code are refused",
    bad.every((a) => a.status == 400),
    bad.map((a) => a.status).join(" ")
  );
  const asAgent = async (token: string) => {
    const a = await ask(`${shell}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    return a.stub ? (JSON.parse(a.text) as Saw) : null;
  };
  const agent = await asAgent(tokens.access_token);
  // The gate keeps no state: a code's second exchange gives tokens too, with the mark of another exchange. Erga takes
  // one exchange's tokens only, and ends the grant when another's comes (the real Erga's run checks that: erga.ts).
  const replay = await trade(grant);
  const twice = replay.status == 200 ? await asAgent(JSON.parse(replay.text).access_token) : null;
  report.add(
    "Agents: a code works one time only: its second exchange's tokens carry another exchange's mark, for Erga to end the grant by",
    !!agent?.caller.x && !!twice?.caller.x && twice.caller.x != agent.caller.x && twice.caller.g == agent.caller.g,
    `the second exchange: ${replay.status}; the marks: ${agent?.caller.x} and ${twice?.caller.x}, of the grant ${twice?.caller.g == agent?.caller.g ? "the same" : "another"}`
  );
  report.add(
    "Agents: the token reaches the origin as the person's agent, with its grant, and no token",
    agent?.caller.kind == "agent" && agent.caller.sub == saw?.caller.sub && /^grant-/.test(agent.caller.g ?? "") && !agent.authorization,
    JSON.stringify(agent?.caller)
  );
  const fresh = await trade({ grant_type: "refresh_token", refresh_token: tokens.refresh_token ?? "", client_id: "verify-agent" });
  const wrongRefresh = await pool(
    [
      { refresh_token: tokens.access_token ?? "", client_id: "verify-agent" },
      { refresh_token: tokens.refresh_token ?? "", client_id: "another" },
    ],
    (o) => trade({ grant_type: "refresh_token", ...o })
  );
  const refreshed = fresh.status == 200 ? await asAgent(JSON.parse(fresh.text).access_token) : null;
  report.add(
    "Agents: a refresh gives a new token that works, of the same exchange; a token or another client's refresh does not",
    fresh.status == 200 && !!refreshed && refreshed.caller.x == agent?.caller.x && wrongRefresh.every((a) => a.status == 400),
    `${fresh.status}, the mark is ${refreshed?.caller.x == agent?.caller.x ? "the same" : "another"}; ${wrongRefresh.map((a) => a.status).join(" ")}`
  );
  const both = await ask(shell + ORIGIN.whoami, {
    jar: ada,
    headers: { authorization: `Bearer ${forged(tokens.access_token ?? "a.b.c")}` },
  });
  report.add("Agents: a bad token is refused, whatever cookie comes with it", both.status == 401, `${both.status}`);
  const made = await ask(shell + ORIGIN.newToken, { jar: ada, body: "" });
  const pasted = await ask(`${shell}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${made.headers.get("x-erga-token")}` },
    body: "{}",
  });
  const byAgent = await ask(shell + ORIGIN.newToken, { headers: { authorization: `Bearer ${tokens.access_token}` }, body: "" });
  report.add(
    "Agents: a person makes a token on the page; an agent makes none",
    pasted.stub &&
      JSON.parse(pasted.text).caller.g == "grant-page" &&
      !made.headers.has("x-erga-gate") &&
      // (Behind Access an agent's request comes only to the open paths: Access sends this one to its sign-in.)
      (access ? toAccess(run, byAgent) : byAgent.stub) &&
      !byAgent.headers.has("x-erga-token") &&
      !byAgent.headers.has("x-erga-gate"),
    `page: ${pasted.status}; agent: ${byAgent.status}, ${byAgent.headers.has("x-erga-token") ? "a token" : "no token"}`
  );
  report.add(
    "Agents: revoke the grant, then 401",
    null,
    "Erga keeps the grants, not this origin: the run with a real Erga checks it (setting 2)"
  );

  // --- every route, with no proof and with forged, expired and wrong values
  const bob = { p: "sso", sub: "sub-bob", email: "bob@example.com", name: "Bob", i: Date.now() };
  const spoof = { "x-erga-caller": b64({ kind: "person", ...bob, e: now + 3600 }) };
  const bearer = (v: string) => ({ authorization: `Bearer ${v}` });
  const shellProofs: Record<string, Record<string, string>> = {
    "no proof": {},
    "no proof, a page": { "sec-fetch-dest": "document" },
    "a caller header": spoof,
    ...(access
      ? {
          // Access's proof with one character changed, under the old signature: in its cookie, and in the header that
          // Access itself writes (which comes to the gate from outside only on an open path).
          "a forged Access cookie": { cookie: `${PROOF}=${forged(shellCookie)}` },
          "a forged Access proof in the header": { "cf-access-jwt-assertion": forged(shellCookie) },
          "a member cookie as Access's cookie": { cookie: `${PROOF}=${memberCookie}` },
        }
      : {
          "a forged shell cookie": { cookie: `${SHELL}=${forged(shellCookie)}` },
          "an expired shell cookie": { cookie: `${SHELL}=${await mint("s", bob, now - 5)}` },
          "a shell cookie of another key": {
            cookie: `${SHELL}=${await mint("s", bob, now + 3600, "another-edge-key-of-thirty-two-chars")}`,
          },
          "a member cookie as the shell cookie": { cookie: `${SHELL}=${memberCookie}` },
        }),
    "a forged token": bearer(forged(tokens.access_token ?? "a.b.c")),
    "an expired token": bearer(await mint("a", { p: "sso", sub: "sub-bob", g: "g" }, now - 5)),
    "a refresh grant as the token": bearer(tokens.refresh_token ?? "r.b.c"),
    "a shell cookie as the token": bearer(shellCookie),
  };
  const contentProofs: Record<string, Record<string, string>> = {
    "no proof": {},
    "no proof, a page": { "sec-fetch-dest": "iframe" },
    "a caller header": spoof,
    "a forged member cookie": { cookie: `member=${forged(memberCookie)}` },
    "an expired member cookie": { cookie: `member=${await mint("m", {}, now - 5)}` },
    "a shell cookie as the member cookie": { cookie: `member=${shellCookie}; ${SHELL}=${shellCookie}` },
    "the accept's mark": { cookie: `nonce=${await mint("d", {}, now + 600)}`, "sec-fetch-dest": "iframe" },
  };
  interface Probe {
    id: string;
    at: "shell" | "document" | "accept";
    method: string;
    path: string;
    proof: string;
    headers: Record<string, string>;
    status?: number;
    stub?: boolean;
    /** Who answered: the origin, the gate, Access (off to the team's sign-in), or something else. */
    by?: "origin" | "gate" | "access" | "other";
  }
  const all = routes();
  const probes: Probe[] = [];
  const hostOf = {
    shell: run.shell,
    document: docHost(run, 3),
    accept: other ? acceptHost(run) : "",
  };
  for (const r of all) {
    for (const [proof, headers] of Object.entries(shellProofs)) probes.push({ id: uid(), at: "shell", ...r, proof, headers });
    if (hostOf.document)
      for (const [proof, headers] of Object.entries(contentProofs)) probes.push({ id: uid(), at: "document", ...r, proof, headers });
    if (hostOf.accept) probes.push({ id: uid(), at: "accept", ...r, proof: "no proof", headers: {} });
  }
  // The same routes with a good proof: the origin sees each one (so the log shows what it must).
  const own = (r: { path: string }) => /^\/(_edge|oauth\/(token|register|authorize)|\.well-known\/oauth-)/.test(r.path);
  /** Behind Access: a path that Access lets through with no sign-in. It adds no proof there, so nobody is a person there. */
  const openAt = (path: string) => access && ACCESS_OPEN.some((o) => path == o || path.startsWith(`${o}/`));
  const controls: Probe[] = all
    .filter((r) => !own(r) && !openAt(r.path))
    .flatMap((r) => [
      { id: uid(), at: "shell" as const, ...r, proof: "good", headers: { cookie: `${PROOF}=${shellCookie}` } },
      ...(hostOf.document
        ? [
            {
              id: uid(),
              at: "document" as const,
              ...r,
              proof: "good",
              headers: { cookie: `member=${cookieOf(ada, `.${other ? run.content : run.shell}`, "member")}` },
            },
          ]
        : []),
    ]);
  const t0 = Date.now();
  await pool([...probes, ...controls], async (p) => {
    const url = `https://${hostOf[p.at]}${p.path}`;
    const headers = { ...p.headers, "x-verify-id": p.id };
    if (p.method == "WS") {
      const a = await socket(url, headers);
      [p.status, p.stub, p.by] = [a.status, a.stub, a.stub ? "origin" : a.gate ? "gate" : "other"];
    } else {
      const a = await ask(url, { method: p.method, headers, body: /POST|PUT|PATCH/.test(p.method) ? "" : undefined });
      const by = a.stub ? "origin" : gateSaid((name) => a.headers.get(name)) ? "gate" : access && toAccess(run, a) ? "access" : "other";
      [p.status, p.stub, p.by] = [a.status, a.stub, by];
    }
  });
  const sawAll = await ORIGIN.seen(
    run,
    ada,
    [...probes, ...controls].map((p) => p.id)
  );
  const tell = (p: Probe) => `${p.at} ${p.method} ${p.path} [${p.proof}] ${p.status}${access ? ` (${p.by})` : ""}`;
  const lost = controls.filter((p) => sawAll[p.id]?.caller.kind != (p.at == "shell" ? "person" : sso ? "member" : "none"));
  report.add(
    `With a good proof the origin sees every route (${controls.length} requests)`,
    !lost.length,
    lost.slice(0, 4).map(tell).join("; ")
  );
  if (sso) {
    const through = probes.filter((p) => p.stub || sawAll[p.id]);
    // Behind Access, Access itself refuses a request with no Access proof, but on the open paths, where the gate
    // answers: off to the team's sign-in, or (a preflight, a WebSocket's first request) an answer of its own that is no
    // success.
    const refused = (p: Probe) =>
      [401, 404].includes(p.status!) ||
      (access && p.at == "shell" && (p.by == "access" || (p.by == "other" && !(p.status! >= 200 && p.status! < 300))));
    const odd = probes.filter(
      (p) =>
        !/^(no proof|the accept's mark)/.test(p.proof) &&
        !refused(p) &&
        !OPEN(run).some((o) => o.startsWith(`${p.at == "document" ? "content" : p.at} ${p.method} ${p.path} `))
    );
    report.add(
      `Invariant 2: ${probes.length} requests (${all.length} routes, ${Object.keys(shellProofs).length} + ${Object.keys(contentProofs).length} kinds of bad proof): ${access ? "Access or the gate" : "the gate"} refuses each, and the origin sees none`,
      !through.length && !odd.length,
      [...through, ...odd].slice(0, 6).map(tell).join("; ") || `${Date.now() - t0} ms`
    );
    if (access) {
      // Which paths of the shell came to the gate with no Access proof: exactly those the open application names.
      const bare = probes.filter((p) => p.at == "shell" && p.proof == "no proof");
      const past = [...new Set(bare.filter((p) => p.by == "gate").map((p) => p.path))].sort();
      const want = [...new Set(bare.filter((p) => openAt(p.path)).map((p) => p.path))].sort();
      report.add(
        "Access lets through with no proof exactly the paths that carry none (the vouch, the agents' metadata and token endpoint, MCP)",
        past.join() == want.join(),
        past.join() == want.join()
          ? `${past.length} of ${new Set(bare.map((p) => p.path)).size} paths come to the gate: ${past.join(", ")}`
          : `to the gate: ${past.join(", ")}; expected: ${want.join(", ")}`
      );
    }
    // With no proof (not a page): what answers anything but 401 or 404.
    const open = probes.filter((p) => p.proof == "no proof" && !refused(p)).map((p) => `${p.at} ${p.method} ${p.path} ${p.status}`);
    const want = OPEN(run);
    report.add(
      "Invariant 3: the addresses that answer with no proof are exactly the open paths",
      open.sort().join() == [...want].sort().join(),
      open.sort().join() == [...want].sort().join()
        ? `${open.length} addresses: ${open.join(", ")}`
        : `more: ${open.filter((o) => !want.includes(o)).join(", ") || "none"}; fewer: ${want.filter((o) => !open.includes(o)).join(", ") || "none"}`
    );
    const pages = probes.filter((p) => p.proof == "no proof, a page" && p.method == "GET" && !own(p));
    // (Behind Access: Access's sign-in; on an open path, the gate's 401.)
    const wrongPage = pages.filter((p) =>
      p.at != "shell" ? p.status != (other ? 200 : 401) : access ? !(p.by == "access" || p.status == 401) : p.status != 302
    );
    report.add(
      `A page with no proof goes to sign in (shell) or ${other ? "the vouch" : "a 401"} (document), never to the origin`,
      !wrongPage.length,
      wrongPage.slice(0, 4).map(tell).join("; ")
    );
  } else {
    // OAuth: anyone comes in, as nobody. A bad token is still refused, and no bad value names a person.
    const named = probes.filter((p) => sawAll[p.id] && sawAll[p.id].caller.kind != "none");
    const tokenThrough = probes.filter((p) => /token$/.test(p.proof) && !own(p) && (p.stub || sawAll[p.id] || p.status != 401));
    report.add(
      `OAuth: ${probes.length} requests with no proof or a bad one: the origin hears nobody in each`,
      !named.length,
      named.slice(0, 4).map(tell).join("; ")
    );
    report.add("OAuth: a bad token is refused on every route", !tokenThrough.length, tokenThrough.slice(0, 4).map(tell).join("; "));
  }

  // --- the origin's own address
  if (sso && run.originAddress) {
    const direct = await fetch(run.originAddress + ORIGIN.whoami, { redirect: "manual" }).then(
      (r) => `${r.status}${r.headers.get("x-stub") ? " (the origin)" : ""}`,
      (e) => String(e).slice(0, 60)
    );
    const control = await fetch(`${run.idp.url}/.well-known/openid-configuration`).then(
      (r) => r.status,
      () => 0
    );
    report.add(
      "Invariant 3: the origin's own address does not answer (the issuer's, beside it, does)",
      !/the origin|^2/.test(direct) && control == 200,
      `${new URL(run.originAddress).host}: ${direct}; the issuer: ${control}`
    );
  }

  // --- sign-out, and how long a gated request takes
  const times: number[] = [];
  for (let i = 0; i < 15; i++) {
    const t = performance.now();
    await ask(shell + ORIGIN.whoami, { jar: ada });
    times.push(performance.now() - t);
  }
  report.add(
    "Speed: a request through the gate to the origin (median of 15, from this machine)",
    true,
    `${Math.round(times.sort((a, b) => a - b)[7])} ms`
  );
  const out = await ask(shell + ORIGIN.signOut, { jar: ada, dest: "document" });
  const after = await ask(shell + ORIGIN.whoami, { jar: ada });
  const ends = (name: string) => out.set.some((l) => l.startsWith(`${name}=;`) && l.includes("Max-Age=0"));
  if (access) {
    // The gate's sign-out ends the gate's cookies. The person's sign-in is Access's: it ends at Access's own sign-out.
    const still = after.stub && JSON.parse(after.text).caller.kind == "person";
    report.add(
      "Access: the gate's sign-out ends the member cookie on the shell",
      ends(COPY) && !out.headers.has("x-erga-gate"),
      `after it, the shell hears ${still ? "the person still: Access's proof stands until Access's own sign-out" : `${after.status}`}`
    );
    // Where a sign-out page goes last, as the gate says it for a person of Access (gate/core.ts, signOutAt).
    const on = await ask(`${shell}${ORIGIN.signOut}?on`, { jar: ada, dest: "document" });
    const to = /location\.replace\("([^"]+)"\)/.exec(on.text)?.[1] ?? "";
    report.add(
      "Access: the sign-out page goes on to Access's own sign-out (the gate names it for a person of Access)",
      on.stub && to == "/cdn-cgi/access/logout",
      `${on.status}; it goes on to ${to || "nowhere"}`
    );
    // (As bob. Trap, seen in 2 runs of 3: after ada's sign-out here, her sign-in in the first browser, some seconds
    // later, stopped at Access's own page /cdn-cgi/access/authorized. With bob's sign-out here: not seen, in 3 runs.)
    const bob: Jar = new Map();
    const signed = (await accessSignIn(run, "bob", bob)).at(-1)!;
    const left = await ask(`${shell}/cdn-cgi/access/logout`, { jar: bob, dest: "document" });
    const then = await ask(shell + ORIGIN.whoami, { jar: bob });
    report.add(
      "Access's own sign-out (/cdn-cgi/access/logout) ends the person's sign-in: the shell then goes to the team's sign-in",
      signed.stub && toAccess(run, then),
      `bob's sign-in: ${signed.status}; his sign-out: ${left.status}; a request after it: ${then.status} ${(then.headers.get("location") ?? "").slice(0, 50)}`
    );
    return;
  }
  report.add(
    "Sign-out ends the shell cookie and the member cookie on the shell",
    ends(SHELL) &&
      ends(COPY) &&
      !out.headers.has("x-erga-gate") &&
      (sso ? after.status == 401 : JSON.parse(after.text).caller.kind == "none"),
    `after it: ${after.status}`
  );
  const old = await ask(shell + ORIGIN.whoami, { headers: { cookie: `${SHELL}=${shellCookie}` } });
  report.add(
    "A copy of the shell cookie from before the sign-out is refused",
    null,
    `${old.stub ? "the gate takes it until its end: it keeps no state" : old.status}. Erga refuses it by the cookie's time, and has the gate end it: the run with a real Erga checks it`
  );
}
