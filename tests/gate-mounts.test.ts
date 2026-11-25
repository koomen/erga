// The gate inside a Worker (gate/mounts/web.ts): the same core behind a Worker's requests, with the organization's
// sign-in (gate/sso.ts: an OIDC issuer, or Cloudflare Access in front), and where anyone may come in. Each runs a
// whole sign-in and hand-off, through a pretend browser that keeps cookies as a browser does. (The gate in front, on
// CloudFront: tests/gate-cloudfront.test.ts.)

import { beforeAll, describe, expect, test } from "bun:test";
import { accessOf } from "../gate/access.ts";
import { ACCESS_OPEN, ASK, CALLER, type Caller, type Config, FRONT, open, seal, TOKEN } from "../gate/core.ts";
import { fromFront, handle, type Mount, parseCookies, readCaller } from "../gate/mounts/web.ts";
import { oidcExchange } from "../gate/oidc.ts";
import { webPort as port } from "../gate/port.ts";
import { ssoOf } from "../gate/sso.ts";
import { browser, hopOf, insideMount } from "./helpers/gate.ts";
import { b64, CONTENT, IDP, idToken, ISSUER, issuer, KEY, PAGE, SHELL } from "./helpers/gate-mounts.ts";

/** A pretend Erga: it says who the gate named, and what reached it. */
function erga() {
  const seen: Request[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    seen.push(request);
    const url = new URL(request.url);
    const who = readCaller(request, port);
    const headers = new Headers({ "content-type": "application/json" });
    const ask = url.searchParams.get("ask");
    if (ask) headers.set(ASK, ask);
    if (url.pathname == "/oauth/authorize" && request.method == "POST") headers.set(ASK, "code grant1");
    return new Response(
      JSON.stringify({ who, cookie: request.headers.get("cookie"), authorization: request.headers.get("authorization") }),
      { headers }
    );
  };
  return { fetch, seen };
}

const OIDC = { oidc: { issuer: ISSUER, authorize: IDP.authorize, token: IDP.token, client: IDP.client } };
/** The gate inside a Worker, with the organization's sign-in: an issuer (the default), or Access. */
const inside = (upstream: { fetch: (request: Request) => Promise<Response> }, ask: typeof fetch, sso: object = OIDC) =>
  insideMount({ key: KEY, shell: SHELL, content: CONTENT, sso, secret: "idp-secret", ask, upstream: upstream.fetch });
const whoOf = async (answer: Response) => (await answer.json()) as { who: Caller; cookie: string | null; authorization: string | null };

describe("the gate inside a Worker, with the organization's sign-in: an OIDC issuer", () => {
  const setUp = () => {
    const upstream = erga();
    const traded: URLSearchParams[] = [];
    const mount = inside(upstream, issuer(traded));
    return { upstream, traded, mount, b: browser((r) => handle(r, mount)) };
  };

  /** Through the issuer's page (which this pretends): the callback, with the state the sign-in started with. */
  async function signIn(b: ReturnType<typeof browser>, code = "good") {
    const started = await b.go(`https://${SHELL}/documents`);
    // The issuer's own address: not the gate's to answer.
    expect(started.status).toBe(404);
    const at = new URL(`https://${b.trail.at(-1)}`);
    expect(at.host).toBe("idp.example.com");
    const state = b.cookie("__Host-signin", SHELL)!;
    const st = await open<{ s: string }>(port, KEY, "i", state.value, Date.now() / 1000);
    return b.go(`https://${SHELL}/_edge/callback?code=${code}&state=${st!.s}`);
  }

  test("nothing reaches Erga with no proof", async () => {
    const { upstream, mount } = setUp();
    expect((await handle(new Request(`https://${SHELL}/api/tools/x`, { method: "POST" }), mount)).status).toBe(401);
    expect((await handle(new Request(PAGE), mount)).status).toBe(401);
    expect((await handle(new Request("https://other.example.org/"), mount)).status).toBe(404);
    expect(upstream.seen.length).toBe(0);
  });

  test("sign-in, then the shell as the person: Erga hears the caller, and none of the gate's cookies", async () => {
    const { b, traded, upstream } = setUp();
    const answer = await signIn(b);
    expect(traded[0].get("redirect_uri")).toBe(`https://${SHELL}/_edge/callback`);
    expect(traded[0].get("code_verifier")).toMatch(/^[\w-]{43}$/);
    const said = await whoOf(answer);
    expect(said.who).toMatchObject({ kind: "person", p: "sso", sub: "sub-ada", email: "ada@example.com", name: "Ada" });
    expect(said.cookie).toBeNull();
    expect(new URL(upstream.seen.at(-1)!.url).pathname).toBe("/documents");
    expect(b.cookie("__Host-signin", SHELL)).toBeUndefined();
    expect(b.cookie("__Host-erga", SHELL)).toBeDefined();
    expect(b.cookie("__Host-member", SHELL)).toBeDefined();
  });

  test("Erga's own cookies pass; a caller's header from outside never does", async () => {
    const { b, mount, upstream } = setUp();
    await signIn(b);
    const shell = b.cookie("__Host-erga", SHELL)!.value;
    const forged = Buffer.from(
      JSON.stringify({ kind: "person", p: "sso", sub: "sub-admin", email: "root@example.com", name: "Root", i: 1 })
    ).toString("base64url");
    const answer = await handle(
      new Request(`https://${SHELL}/x`, {
        headers: { cookie: `erga_join=abc; __Host-erga=${shell}; theme=dark`, [CALLER]: forged, [ASK]: "out" },
      }),
      mount
    );
    const said = await whoOf(answer);
    expect(said.who).toMatchObject({ sub: "sub-ada" });
    expect(said.cookie).toBe("erga_join=abc; theme=dark");
    expect(upstream.seen.at(-1)!.headers.get(ASK)).toBeNull();
    // The key of a gate in front is no header of a request from outside: it never goes on.
    await handle(new Request(`https://${SHELL}/x`, { headers: { cookie: `__Host-erga=${shell}`, [FRONT]: "a guess" } }), mount);
    expect(upstream.seen.at(-1)!.headers.get(FRONT)).toBeNull();
    // With no proof at all, the forged header gets nowhere.
    expect((await handle(new Request(`https://${SHELL}/x`, { headers: { [CALLER]: forged } }), mount)).status).toBe(401);
  });

  test("a sign-in the issuer refuses signs nobody in", async () => {
    const { b, upstream } = setUp();
    const answer = await signIn(b, "bad");
    expect(answer.status).toBe(400);
    expect(b.cookie("__Host-erga", SHELL)).toBeUndefined();
    expect(upstream.seen.length).toBe(0);
  });

  test("the hand-off: a document's frame opens in 3 steps the first time, and at once after", async () => {
    const { b } = setUp();
    await signIn(b);
    b.trail.length = 0;
    const first = await b.go(PAGE, { frame: true });
    expect((await whoOf(first)).who).toEqual({ kind: "member" });
    expect(b.trail).toEqual([
      `abc12345-ada.${CONTENT}/t/pass/`,
      `${SHELL}/_edge/vouch`,
      `accept.${CONTENT}/_edge/accept`,
      `abc12345-ada.${CONTENT}/t/pass/`,
    ]);
    b.trail.length = 0;
    const second = await b.go(`https://zzz99999-bob.${CONTENT}/t/other/`, { frame: true });
    expect((await whoOf(second)).who).toEqual({ kind: "member" });
    expect(b.trail.length).toBe(1);
    // The frame's own requests after it: a file, a socket's first request.
    expect((await whoOf(await b.go(`${PAGE}file.js`, { frame: true, dest: "script" }))).who).toEqual({ kind: "member" });
    expect((await whoOf(await b.go(`${PAGE}api/room`, { frame: true, dest: "websocket" }))).who).toEqual({ kind: "member" });
  });

  test("a browser that never signed in gets no ticket: the frame ends at sign-in", async () => {
    const { b, upstream } = setUp();
    await b.go(PAGE, { frame: true });
    expect(b.trail.slice(0, 3)).toEqual([`abc12345-ada.${CONTENT}/t/pass/`, `${SHELL}/_edge/vouch`, `${SHELL}/_edge/sign-in`]);
    expect(b.cookie("member", `x.${CONTENT}`)).toBeUndefined();
    expect(upstream.seen.length).toBe(0);
  });

  test("a ticket from one browser opens nothing in another", async () => {
    const { b, mount } = setUp();
    await signIn(b);
    // Ada's browser, stopped at the accept: its address has the ticket.
    const first = await handle(new Request(PAGE, { headers: { "sec-fetch-dest": "iframe" } }), mount);
    const vouch = await handle(
      new Request(hopOf(await first.text()), {
        headers: { "sec-fetch-dest": "iframe", cookie: `__Host-member=${b.cookie("__Host-member", SHELL)!.value}` },
      }),
      mount
    );
    const accept = hopOf(await vouch.text());
    expect(new URL(accept).host).toBe(`accept.${CONTENT}`);
    // Another browser, with a nonce of its own.
    const other = await handle(new Request(PAGE, { headers: { "sec-fetch-dest": "iframe" } }), mount);
    const theirs = parseCookies(
      other.headers
        .getSetCookie()
        .map((c) => c.split("; ")[0])
        .join("; ")
    ).nonce[0];
    const stolen = await handle(new Request(accept, { headers: { cookie: `nonce=${theirs}` } }), mount);
    expect(stolen.status).toBe(400);
    expect(stolen.headers.getSetCookie()).toEqual([]);
  });

  test("an agent: authorize in the browser, the code for a token, the token on /mcp", async () => {
    const { b, mount, upstream } = setUp();
    await signIn(b);
    const verifier = "v".repeat(43);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: "claude-code",
      redirect_uri: "http://localhost:8123/callback",
      state: "st",
      code_challenge: await port.sha256(verifier),
      code_challenge_method: "S256",
    });
    const shell = `__Host-erga=${b.cookie("__Host-erga", SHELL)!.value}`;
    const approved = await handle(
      new Request(`https://${SHELL}/oauth/authorize?${query}`, { method: "POST", headers: { cookie: shell } }),
      mount
    );
    expect(approved.status).toBe(302);
    expect(approved.headers.get(ASK)).toBeNull();
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "claude-code",
      redirect_uri: "http://localhost:8123/callback",
      code_verifier: verifier,
      code,
    });
    const traded = await handle(
      new Request(`https://${SHELL}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
      mount
    );
    expect(traded.status).toBe(200);
    const tokens = (await traded.json()) as { access_token: string; refresh_token: string };
    const before = upstream.seen.length;
    const said = await whoOf(
      await handle(
        new Request(`https://${SHELL}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` } }),
        mount
      )
    );
    // (With the mark of the code's exchange: tests/gate-agents.test.ts.)
    expect(said.who).toEqual({ kind: "agent", p: "sso", sub: "sub-ada", g: "grant1", x: expect.stringMatching(/^[\w-]{16}$/) });
    // The token itself never reaches Erga; the token endpoint never does at all.
    expect(said.authorization).toBeNull();
    expect(upstream.seen.length).toBe(before + 1);
    // A body that is not a form, or too long, is no grant.
    const wrong = await handle(
      new Request(`https://${SHELL}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(body)),
      }),
      mount
    );
    expect(wrong.status).toBe(400);
  });

  test("a token made on the page comes back in a header, for a person only", async () => {
    const { b, mount } = setUp();
    await signIn(b);
    const shell = `__Host-erga=${b.cookie("__Host-erga", SHELL)!.value}`;
    const end = Math.floor(Date.now() / 1000) + 3600;
    const made = await handle(
      new Request(`https://${SHELL}/tokens/new?ask=${encodeURIComponent(`token grant7 ${end}`)}`, {
        method: "POST",
        headers: { cookie: shell },
      }),
      mount
    );
    const token = made.headers.get(TOKEN)!;
    expect(await open(port, KEY, "a", token, Date.now() / 1000)).toMatchObject({ sub: "sub-ada", g: "grant7", e: end });
    const byAgent = await handle(
      new Request(`https://${SHELL}/tokens/new?ask=${encodeURIComponent(`token grant8 ${end}`)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      mount
    );
    expect(byAgent.headers.get(TOKEN)).toBeNull();
  });

  test("sign-out ends the shell's cookies, and the accept host's frame ends the content's", async () => {
    const { b } = setUp();
    await signIn(b);
    await b.go(PAGE, { frame: true });
    await b.go(`https://${SHELL}/auth/logout?ask=out`, { method: "POST" });
    expect(b.cookie("__Host-erga", SHELL)).toBeUndefined();
    expect(b.cookie("__Host-member", SHELL)).toBeUndefined();
    expect(b.cookie("member", `x.${CONTENT}`)).toBeDefined();
    await b.go(`https://accept.${CONTENT}/_edge/sign-out`, { frame: true });
    // The content's member cookie ends, and the hand-off's mark with it.
    expect([b.cookie("member", `x.${CONTENT}`), b.cookie("nonce", `x.${CONTENT}`)]).toEqual([undefined, undefined]);
    // The frame's next page goes off to sign in.
    b.trail.length = 0;
    await b.go(PAGE, { frame: true });
    expect(b.trail.at(-1)).toBe("idp.example.com/authorize");
  });

  test("after sign-out and a new sign-in, a document's frame opens at once: the last hand-off's mark is no 401", async () => {
    const { b } = setUp();
    await signIn(b);
    await b.go(PAGE, { frame: true });
    expect(b.cookie("nonce", `x.${CONTENT}`)?.value).toMatch(/^d\./);
    await b.go(`https://${SHELL}/auth/logout?ask=out`, { method: "POST" });
    await b.go(`https://accept.${CONTENT}/_edge/sign-out`, { frame: true });
    await signIn(b);
    const again = await b.go(PAGE, { frame: true });
    expect(again.status).toBe(200);
    expect((await whoOf(again)).who).toEqual({ kind: "member" });
    // The mark still stops a loop: a browser that keeps the mark and drops the member cookie sees a page.
    b.jar.splice(
      b.jar.findIndex((c) => c.name == "member"),
      1
    );
    b.trail.length = 0;
    expect((await b.go(PAGE, { frame: true })).status).toBe(401);
    expect(b.trail.length).toBe(1);
  });

  test("the deploy's values are checked: values that name no sign-in throw", () => {
    const good = JSON.stringify(OIDC);
    expect(ssoOf(good, "idp-secret").idp).toEqual({ sso: { authorize: IDP.authorize, client: "client-1", scope: "openid email profile" } });
    // An issuer needs its client's secret, and each of its addresses over https.
    expect(() => ssoOf(good, "")).toThrow("SSO_CLIENT_SECRET");
    for (const part of ["issuer", "authorize", "token", "client"])
      expect(() => ssoOf(JSON.stringify({ oidc: { ...OIDC.oidc, [part]: "" } }), "s")).toThrow('"oidc"');
    expect(() => ssoOf(JSON.stringify({ oidc: { ...OIDC.oidc, token: "http://idp.example.com/token" } }), "s")).toThrow('"oidc"');
    // Access needs the team and the application's tag; one sign-in, never both, never none.
    const access = { team: "team1", aud: "a".repeat(64) };
    expect(ssoOf(JSON.stringify({ access }), "").idp).toBe("access");
    for (const bad of [{ team: "team1" }, { aud: access.aud }, { team: "Team 1", aud: access.aud }, { team: "team1", aud: "tag" }])
      expect(() => ssoOf(JSON.stringify({ access: bad }), "")).toThrow('"access"');
    for (const bad of ["", "{}", "null", "junk", JSON.stringify({ access, ...OIDC })]) expect(() => ssoOf(bad, "s")).toThrow("SSO must be");
  });

  test("a gate in front: only a request with its key passes, and the key ends there", () => {
    const key = "the-key-that-erga-has-too-".repeat(2);
    const ask = (sent?: string) =>
      fromFront(new Request(`https://${SHELL}/x`, { headers: sent == null ? {} : { [FRONT]: sent, other: "kept" } }), key);
    for (const sent of [undefined, "", key.slice(0, -1), `${key}x`, key.toUpperCase()]) expect(ask(sent)).toBeNull();
    const through = ask(key)!;
    expect([through.headers.get(FRONT), through.headers.get("other"), through.url]).toEqual([null, "kept", `https://${SHELL}/x`]);
    // A key too short to be a secret is no key.
    expect(fromFront(new Request(`https://${SHELL}/x`, { headers: { [FRONT]: "short" } }), "short")).toBeNull();
  });
});

describe("the code exchange with an OIDC issuer", () => {
  const X = { code: "good", verifier: "v".repeat(43), redirect: `https://${SHELL}/_edge/callback` };
  const withToken = (claims: Record<string, unknown> | null): typeof fetch =>
    (async () => (claims ? Response.json({ id_token: idToken(claims) }) : new Response("{}", { status: 400 }))) as unknown as typeof fetch;
  const oidc = { ...IDP, secret: "idp-secret" };

  test("the ID token's claims name the person", async () => {
    expect(await oidcExchange("sso", oidc, X, issuer())).toEqual({ p: "sso", sub: "sub-ada", email: "ada@example.com", name: "Ada" });
  });

  test("refused: the issuer's no, another issuer's token, another client's, an ended one, no subject", async () => {
    const ada = { sub: "sub-ada", email: "ada@example.com" };
    expect(await oidcExchange("sso", oidc, X, withToken(null))).toBeNull();
    expect(await oidcExchange("sso", oidc, X, withToken({ ...ada, iss: "https://evil.example.org" }))).toBeNull();
    expect(await oidcExchange("sso", oidc, X, withToken({ ...ada, aud: "another-client" }))).toBeNull();
    expect(await oidcExchange("sso", oidc, X, withToken({ ...ada, exp: Date.now() / 1000 - 1 }))).toBeNull();
    expect(await oidcExchange("sso", oidc, X, withToken({ email: "ada@example.com" }))).toBeNull();
    expect(
      await oidcExchange("sso", oidc, X, (async () => Response.json({ id_token: "not-a-jwt" })) as unknown as typeof fetch)
    ).toBeNull();
    expect(await oidcExchange("sso", oidc, X, (async () => Promise.reject(new Error("down"))) as unknown as typeof fetch)).toBeNull();
  });

  test("an address counts only when the issuer says it verified it; the person still signs in by their subject", async () => {
    const emailWith = async (claims: Record<string, unknown>) =>
      (await oidcExchange("sso", oidc, X, withToken({ sub: "s", email: "x@example.com", ...claims })))!.email;
    expect(await oidcExchange("sso", oidc, X, withToken({ sub: "s", email: "x@example.com", email_verified: false }))).toEqual({
      p: "sso",
      sub: "s",
      email: "",
      name: "",
    });
    // No claim at all says nothing: not verified. Only true, or the text "true" (some issuers send text).
    expect(await emailWith({})).toBe("");
    for (const said of ["false", "yes", 1, null, "TRUE"]) expect(await emailWith({ email_verified: said })).toBe("");
    expect(await emailWith({ email_verified: true })).toBe("x@example.com");
    expect(await emailWith({ email_verified: "true" })).toBe("x@example.com");
  });
});

describe("behind Cloudflare Access", () => {
  const ACCESS = { team: "team1", aud: "a1".repeat(32) };
  let keys: CryptoKeyPair, other: CryptoKeyPair, jwks: { keys: JsonWebKey[] };
  let asked = 0;
  const certs = (async (input: RequestInfo | URL) => {
    asked++;
    return String(input) == "https://team1.cloudflareaccess.com/cdn-cgi/access/certs"
      ? Response.json(jwks)
      : new Response("", { status: 404 });
  }) as typeof fetch;

  beforeAll(async () => {
    const make = () =>
      crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"]
      );
    [keys, other] = await Promise.all([make(), make()]);
    jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" } as JsonWebKey] };
  });

  async function proof(claims: Record<string, unknown> = {}, o: { key?: CryptoKey; alg?: string; kid?: string } = {}) {
    const head = b64({ alg: o.alg ?? "RS256", kid: o.kid ?? "k1" });
    const body = b64({
      iss: "https://team1.cloudflareaccess.com",
      aud: [ACCESS.aud],
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: "sub-ada",
      email: "ada@example.com",
      ...claims,
    });
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", o.key ?? keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
  }
  const withProof = (jwt: string | null, url = `https://${SHELL}/documents`, headers: Record<string, string> = {}) =>
    new Request(url, { headers: { "sec-fetch-dest": "document", ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), ...headers } });

  test("the proof counts when the team signed it, for this application, before its end", async () => {
    expect(await accessOf(withProof(await proof()), ACCESS, certs)).toMatchObject({
      p: "access",
      sub: "sub-ada",
      email: "ada@example.com",
    });
    expect(await accessOf(withProof(null), ACCESS, certs)).toBeNull();
    expect(await accessOf(withProof(await proof({ aud: ["another-app"] })), ACCESS, certs)).toBeNull();
    expect(await accessOf(withProof(await proof({ iss: "https://team2.cloudflareaccess.com" })), ACCESS, certs)).toBeNull();
    expect(await accessOf(withProof(await proof({ exp: Math.floor(Date.now() / 1000) - 1 })), ACCESS, certs)).toBeNull();
    expect(await accessOf(withProof(await proof({}, { key: other.privateKey })), ACCESS, certs)).toBeNull();
    expect(await accessOf(withProof(await proof({}, { alg: "none" })), ACCESS, certs)).toBeNull();
    expect(await accessOf(withProof(await proof({}, { kid: "unknown" })), ACCESS, certs)).toBeNull();
    expect(await accessOf(withProof(await proof({ sub: "" })), ACCESS, certs)).toBeNull();
    const [h, b] = (await proof()).split(".");
    expect(await accessOf(withProof(`${h}.${b}.`), ACCESS, certs)).toBeNull();
    expect(await accessOf(withProof("junk"), ACCESS, certs)).toBeNull();
  });

  test("the team's keys are asked for once, not for each request", async () => {
    await accessOf(withProof(await proof()), ACCESS, certs);
    const before = asked;
    await accessOf(withProof(await proof()), ACCESS, certs);
    expect(asked).toBe(before);
  });

  test("the gate behind Access: the person on each request, the hand-off as everywhere, and no sign-in of its own", async () => {
    const upstream = erga();
    const mount = inside(upstream, certs, { access: ACCESS });
    const jwt = await proof({ name: "Ada" });
    // Access adds its proof to what it lets through; the paths that it lets through with no sign-in carry none (the
    // gate's own list: the frame's vouch is one).
    const bypassed = (path: string) => ACCESS_OPEN.some((open) => path == open || path.startsWith(`${open}/`));
    const b = browser((r) =>
      handle(
        new URL(r.url).host == SHELL && !bypassed(new URL(r.url).pathname)
          ? new Request(r, { headers: { ...Object.fromEntries(r.headers), "cf-access-jwt-assertion": jwt } })
          : r,
        mount
      )
    );
    const said = await whoOf(await b.go(`https://${SHELL}/documents`));
    expect(said.who).toMatchObject({ kind: "person", p: "access", sub: "sub-ada", name: "Ada" });
    expect(upstream.seen.at(-1)!.headers.get("cf-access-jwt-assertion")).toBeNull();
    // Access's proof is in its cookies too: none of them goes on to Erga; another cookie does.
    const cookie = `CF_Authorization=${jwt}; CF_AppSession=abc; other=1; CF_Binding=x`;
    await handle(withProof(jwt, `https://${SHELL}/documents`, { cookie }), mount);
    expect(upstream.seen.at(-1)!.headers.get("cookie")).toBe("other=1");
    expect(b.cookie("__Host-erga", SHELL)).toBeUndefined();
    expect(b.cookie("__Host-member", SHELL)).toBeDefined();
    expect((await whoOf(await b.go(PAGE, { frame: true }))).who).toEqual({ kind: "member" });
    expect((await handle(new Request(`https://${SHELL}/_edge/sign-in`), mount)).status).toBe(404);
    expect((await handle(new Request(`https://${SHELL}/_edge/callback?code=good&state=x`), mount)).status).toBe(404);
    // No proof, or a forged one: nothing reaches Erga.
    const before = upstream.seen.length;
    expect((await handle(withProof(null), mount)).status).toBe(401);
    expect((await handle(withProof(await proof({}, { key: other.privateKey })), mount)).status).toBe(401);
    // Each path that Access lets through: the gate's own answer, by its own values, and nothing of Erga.
    const open = async (path: string, init: RequestInit = {}) => (await handle(new Request(`https://${SHELL}${path}`, init), mount)).status;
    expect(ACCESS_OPEN).toEqual([
      "/_edge/vouch",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/oauth/token",
      "/oauth/register",
      "/oauth/device_authorization",
      "/mcp",
    ]);
    const form = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=x",
    };
    expect([
      await open("/_edge/vouch"),
      await open("/.well-known/oauth-protected-resource"),
      await open("/.well-known/oauth-authorization-server"),
      await open("/oauth/token", form),
      await open("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      await open("/oauth/device_authorization"),
      await open("/mcp", { method: "POST" }),
      await open("/mcp", { method: "POST", headers: { authorization: "Bearer a.forged.token" } }),
    ]).toEqual([401, 200, 200, 400, 400, 401, 401, 401]);
    expect(upstream.seen.length).toBe(before);
    // POST /oauth/device_authorization passes through as nobody so remote agents can start device sign-in.
    expect((await whoOf(await handle(new Request(`https://${SHELL}/oauth/device_authorization`, { method: "POST" }), mount))).who).toEqual({
      kind: "none",
    });
  });
});

describe("in Erga's own Worker (anyone may come in)", () => {
  test("no proof goes on as nobody, on the shell and on a document's host; a person as themselves", async () => {
    const upstream = erga();
    const config: Config = {
      key: KEY,
      shell: SHELL,
      content: CONTENT,
      https: true,
      open: true,
      idp: {},
      chooser: "/auth/sign-in",
      oauth: true,
    };
    const mount: Mount = {
      config: () => config,
      port,
      exchange: async () => new Response("no", { status: 400 }),
      upstream: upstream.fetch,
    };
    expect((await whoOf(await handle(new Request(`https://${SHELL}/ada/notes`), mount))).who).toEqual({ kind: "none" });
    expect((await whoOf(await handle(new Request(PAGE), mount))).who).toEqual({ kind: "none" });
    const shell = await seal(port, KEY, "s", { p: "github", sub: "1", email: "", name: "Ada", i: 1 }, Date.now() / 1000 + 60);
    const said = await whoOf(
      await handle(new Request(`https://${SHELL}/ada/notes`, { headers: { cookie: `__Host-erga=${shell}` } }), mount)
    );
    expect(said.who).toMatchObject({ kind: "person", p: "github", sub: "1" });
  });
});
