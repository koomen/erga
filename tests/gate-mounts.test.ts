// The gate's mounts (gate/mounts/): the same core behind a Worker's requests (web.ts, worker.ts: an OIDC issuer, or
// Cloudflare Access) and behind CloudFront's events (the four functions as gate/build.ts builds them, and the
// Lambda). Each runs a whole sign-in and hand-off, through a pretend browser that keeps cookies as a browser does.

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { buildFunction, buildLambda, FUNCTION_MAX, type Part, PARTS } from "../gate/build.ts";
import { ASK, CALLER, type Caller, type Config, open, seal, TOKEN } from "../gate/core.ts";
import { refused } from "../gate/lower.ts";
import { accessOf } from "../gate/mounts/access.ts";
import { oidcExchange } from "../gate/mounts/oidc.ts";
import { FRONT, handle, type Mount, parseCookies, readCaller } from "../gate/mounts/web.ts";
import { type Env, mountOf } from "../gate/mounts/worker.ts";
import { webPort as port } from "../gate/port.ts";
import { browser, hopOf } from "./helpers/gate.ts";

const KEY = "an-edge-key-of-thirty-two-characters!";
const SHELL = "erga.example.com";
const CONTENT = "pages.example.net";
const PAGE = `https://abc12345-ada.${CONTENT}/t/pass/`;
const ISSUER = "https://idp.example.com";
const IDP = { name: "sso", issuer: ISSUER, authorize: `${ISSUER}/authorize`, token: `${ISSUER}/token`, client: "client-1" };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** An ID token as an issuer's token endpoint gives it (its signature is never read). */
const idToken = (claims: Record<string, unknown>) =>
  `${b64({ alg: "RS256" })}.${b64({ iss: ISSUER, aud: "client-1", exp: Date.now() / 1000 + 300, ...claims })}.sig`;

/** A pretend issuer's token endpoint: it trades the code "good" with the client's secret and a verifier. */
const issuer = (seen: URLSearchParams[] = []): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url != IDP.token) return new Response("nope", { status: 404 });
    const form = new URLSearchParams(String(init?.body));
    seen.push(form);
    if (form.get("code") != "good" || form.get("client_secret") != "idp-secret" || !form.get("code_verifier"))
      return new Response("{}", { status: 400 });
    return Response.json({ id_token: idToken({ sub: "sub-ada", email: "ada@example.com", email_verified: true, name: "Ada" }) });
  }) as typeof fetch;

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

const FRONT_KEY = "the-key-that-erga-has-too-".repeat(2);
const env = (o: Partial<Env> & Pick<Env, "ERGA">): Env => ({
  EDGE_KEY: KEY,
  GATE_KEY: FRONT_KEY,
  SHELL,
  CONTENT,
  IDP: JSON.stringify(IDP),
  IDP_SECRET: "idp-secret",
  ...o,
});
const whoOf = async (answer: Response) => (await answer.json()) as { who: Caller; cookie: string | null; authorization: string | null };

describe("the gate's Worker in front of Erga: an OIDC issuer", () => {
  const setUp = () => {
    const upstream = erga();
    const traded: URLSearchParams[] = [];
    const mount = mountOf(env({ ERGA: upstream }), issuer(traded));
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
    // Each request that goes on carries the key that Erga has too, whatever came in under its name.
    expect(upstream.seen.at(-1)!.headers.get(FRONT)).toBe(FRONT_KEY);
    await handle(new Request(`https://${SHELL}/x`, { headers: { cookie: `__Host-erga=${shell}`, [FRONT]: "a guess" } }), mount);
    expect(upstream.seen.at(-1)!.headers.get(FRONT)).toBe(FRONT_KEY);
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

  test("the deploy's values are checked", () => {
    const ERGA = erga();
    expect(() => mountOf(env({ ERGA, EDGE_KEY: "short" }))).toThrow();
    expect(() => mountOf(env({ ERGA, GATE_KEY: "short" }))).toThrow();
    expect(() => mountOf(env({ ERGA, GATE_KEY: KEY }))).toThrow();
    expect(() => mountOf(env({ ERGA, IDP_SECRET: undefined }))).toThrow();
    expect(() => mountOf(env({ ERGA, IDP: undefined }))).toThrow();
    // An issuer can't have Access's name: sign-out would go on to Access's own (core.ts, signOutAt).
    expect(() => mountOf(env({ ERGA, IDP: JSON.stringify({ ...IDP, name: "access" }) }))).toThrow("Cloudflare Access");
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
  const ACCESS = { team: "team1", aud: "aud-1" };
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
      aud: ["aud-1"],
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
    const mount = mountOf(env({ ERGA: upstream, IDP: undefined, IDP_SECRET: undefined, ACCESS: JSON.stringify(ACCESS) }), certs);
    const jwt = await proof({ name: "Ada" });
    // Access adds its proof to what it lets through; the frame's vouch passes Access with none (a bypass path).
    const b = browser((r) =>
      handle(
        new URL(r.url).host == SHELL && !new URL(r.url).pathname.startsWith("/_edge/")
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
    expect(upstream.seen.length).toBe(before);
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

describe("on CloudFront: the four functions as built, and the Lambda", () => {
  const settings: Omit<Config, "key"> = {
    shell: SHELL,
    content: CONTENT,
    https: true,
    open: false,
    idp: { sso: { authorize: IDP.authorize, client: IDP.client, scope: "openid email profile" } },
    oauth: true,
    redirects: [],
  };
  type Handler = (event: unknown) => Promise<Record<string, any>>;
  const fn = {} as Record<Part, Handler>;
  let lambda: (
    event: unknown,
    context?: unknown,
    o?: unknown
  ) => Promise<{ status: string; headers: Record<string, { value: string }[]>; body?: string }>;
  const denied = new Set<string>();
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "erga-gate-"));
  /** A function as built for a deploy's settings, loaded. */
  const load = async (part: Part, config: Omit<Config, "key">, name: string = part): Promise<Handler> => {
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, await buildFunction(part, config, true));
    return (await import(file)).handler;
  };

  beforeAll(async () => {
    // The runtime's two modules: `crypto` is Node's here; `cloudfront` gives the KeyValueStore.
    mock.module("cloudfront", () => ({
      default: { kvs: () => ({ get: async (k: string) => (k == "key" ? KEY : null), exists: async (k: string) => denied.has(k) }) },
    }));
    for (const part of PARTS) fn[part] = await load(part, settings);
    const file = join(dir, "lambda.mjs");
    writeFileSync(file, await buildLambda({ shell: SHELL, region: "us-east-1", idp: { sso: { ...IDP, secret: "/erga/idp-secret" } } }));
    lambda = (await import(file)).handler;
  });

  test("each function is under CloudFront's 10 KB, in syntax that its runtime takes, with a handler by that name and no export", async () => {
    for (const part of PARTS) {
      const code = await buildFunction(part, settings);
      expect(new TextEncoder().encode(code).length).toBeLessThan(FUNCTION_MAX);
      // (tests/gate-lower.test.ts: what the runtime refuses, and that the lowering keeps what the code does.)
      expect(refused(code)).toEqual([]);
      expect(code).toMatch(/function handler\(e\)\{return [\w$]+\(e\)\}$/);
      expect(code).not.toMatch(/\bexport\b/);
    }
  });

  let n = 0;
  /** A request's event, as CloudFront gives it to a function. */
  const event = (
    url: string,
    o: { method?: string; cookies?: Record<string, string>; headers?: Record<string, string>; dest?: string } = {}
  ) => {
    const u = new URL(url);
    const headers: Record<string, { value: string }> = { host: { value: u.host }, "sec-fetch-dest": { value: o.dest ?? "document" } };
    for (const [k, v] of Object.entries(o.headers ?? {})) headers[k] = { value: v };
    const querystring: Record<string, { value: string }> = {};
    for (const [k, v] of new URLSearchParams(u.search)) querystring[k] = { value: encodeURIComponent(v) };
    const cookies: Record<string, { value: string }> = {};
    for (const [k, v] of Object.entries(o.cookies ?? {})) cookies[k] = { value: v };
    return { context: { requestId: `cf-${n++}` }, request: { method: o.method ?? "GET", uri: u.pathname, querystring, headers, cookies } };
  };
  /** A viewer request's function, as the distribution's behaviors choose it: by the path. */
  const viewer = (e: ReturnType<typeof event>) => {
    const path = e.request.uri;
    const agents = path.startsWith("/.well-known/oauth-") || path == "/oauth/token";
    return fn[path.startsWith("/_edge/") ? "edge" : agents ? "agents" : "request"](e);
  };
  const callerIn = (request: Record<string, any>): Caller => JSON.parse(Buffer.from(request.headers[CALLER].value, "base64url").toString());

  /** A whole sign-in: the request function, the Lambda, the response function. The cookies it set. */
  async function signIn() {
    const start = await viewer(event(`https://${SHELL}/_edge/sign-in?next=/documents`));
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location.value).searchParams.get("state")!;
    const cookies = { "__Host-signin": start.cookies["__Host-signin"].value };
    const cb = event(`https://${SHELL}/_edge/callback?code=good&state=${state}`, {
      cookies,
      headers: { "x-erga-exchange": "forged", "x-erga-identity": "forged" },
    });
    const onward = await viewer(cb);
    // On to the Lambda, with what to trade: written by the function, whatever came in.
    expect(onward.headers["x-erga-identity"]).toBeUndefined();
    const fromLambda = await lambda(
      {
        Records: [
          {
            cf: {
              request: {
                method: "GET",
                uri: onward.uri,
                headers: { "x-erga-exchange": [{ value: onward.headers["x-erga-exchange"].value }] },
              },
            },
          },
        ],
      },
      null,
      {
        fetch: issuer(),
        secret: async (name: string) => (name == "/erga/idp-secret" ? "idp-secret" : "wrong"),
      }
    );
    expect(fromLambda.status).toBe("200");
    const response = {
      statusCode: 200,
      headers: { "x-erga-identity": { value: fromLambda.headers["x-erga-identity"][0].value } },
      cookies: {},
    };
    const done = await fn.response({ ...event(`https://${SHELL}/_edge/callback?code=good&state=${state}`, { cookies }), response });
    return { done, state, cookies };
  }

  test("sign-in: the function starts it, the Lambda trades the code, the function signs", async () => {
    const { done } = await signIn();
    expect(done.statusCode).toBe(302);
    expect(done.headers.location.value).toBe("/documents");
    expect(done.headers["x-erga-identity"]).toBeUndefined();
    expect(done.cookies["__Host-erga"].attributes).toBe(`Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`);
    expect(await open(port, KEY, "s", done.cookies["__Host-erga"].value, Date.now() / 1000)).toMatchObject({
      p: "sso",
      sub: "sub-ada",
      email: "ada@example.com",
    });
    expect(done.cookies["__Host-member"].attributes).toContain("SameSite=None");
    expect(done.cookies["__Host-signin"].attributes).toContain("Max-Age=0");
  });

  test("an identity header signs nothing without the sign-in's state in the browser", async () => {
    const identity = Buffer.from(JSON.stringify({ p: "sso", sub: "sub-root", email: "root@example.com", name: "Root" })).toString(
      "base64url"
    );
    const response = () => ({ statusCode: 200, headers: { "x-erga-identity": { value: identity } }, cookies: {} });
    const no = await fn.response({ ...event(`https://${SHELL}/_edge/callback?code=x&state=y`), response: response() });
    expect(no.statusCode).toBe(400);
    expect(no.cookies).toEqual({});
    expect(no.headers["x-erga-identity"]).toBeUndefined();
    const elsewhere = await fn.response({ ...event(`https://${SHELL}/documents`), response: response() });
    expect(elsewhere.cookies).toEqual({});
  });

  test("the Lambda holds no key and names nobody for a code the issuer refuses, or for another path", async () => {
    const x = Buffer.from(
      JSON.stringify({
        do: "exchange",
        idp: "sso",
        code: "bad",
        verifier: "v".repeat(43),
        redirect: `https://${SHELL}/_edge/callback`,
        next: "/",
      })
    ).toString("base64url");
    const o = { fetch: issuer(), secret: async () => "idp-secret" };
    const refused = await lambda(
      { Records: [{ cf: { request: { method: "GET", uri: "/_edge/callback", headers: { "x-erga-exchange": [{ value: x }] } } } }] },
      null,
      o
    );
    expect(refused.headers["x-erga-identity"]).toBeUndefined();
    const other = await lambda(
      { Records: [{ cf: { request: { method: "GET", uri: "/documents", headers: { "x-erga-exchange": [{ value: x }] } } } }] },
      null,
      o
    );
    expect(other.headers["x-erga-identity"]).toBeUndefined();
    expect(await buildLambda({ shell: SHELL, region: "us-east-1", idp: {} })).not.toContain(KEY);
  });

  test("a signed-in request goes on with the caller's header and without the gate's cookies; no proof gets a 401", async () => {
    const { done } = await signIn();
    const cookies = {
      "__Host-erga": done.cookies["__Host-erga"].value,
      "__Host-member": done.cookies["__Host-member"].value,
      theme: "dark",
    };
    const forged = Buffer.from(JSON.stringify({ kind: "person", sub: "sub-root" })).toString("base64url");
    const onward = await viewer(event(`https://${SHELL}/documents`, { cookies, headers: { [CALLER]: forged } }));
    expect(callerIn(onward)).toMatchObject({ kind: "person", sub: "sub-ada" });
    expect(Object.keys(onward.cookies)).toEqual(["theme"]);
    const none = await viewer(event(`https://${SHELL}/api/tools/x`, { method: "POST", dest: "empty", headers: { [CALLER]: forged } }));
    expect(none.statusCode).toBe(401);
    denied.add("deny:sub-ada");
    expect((await viewer(event(`https://${SHELL}/documents`, { cookies }))).statusCode).toBe(401);
    denied.clear();
  });

  test("a request that goes on says the host the viewer asked for, whatever forwarded header came in", async () => {
    const { done } = await signIn();
    const cookies = { "__Host-erga": done.cookies["__Host-erga"].value };
    // Erga's server behind CloudFront (celld) takes this header for its own host: the function writes it.
    const plain = await viewer(event(`https://${SHELL}/documents`, { cookies }));
    expect(plain.headers["x-forwarded-host"]).toEqual({ value: SHELL });
    const forged = await viewer(event(`https://${SHELL}/documents`, { cookies, headers: { "x-forwarded-host": "evil.example" } }));
    expect(forged.headers["x-forwarded-host"]).toEqual({ value: SHELL });
    // A document's host, as a member: its own host.
    const member = await seal(port, KEY, "m", {}, Date.now() / 1000 + 60);
    const page = await viewer(event(PAGE, { cookies: { member }, headers: { "x-forwarded-host": SHELL } }));
    expect(page.headers["x-forwarded-host"]).toEqual({ value: new URL(PAGE).host });
  });

  test("no function writes a header that CloudFront refuses from a function (a 502 for the request)", async () => {
    // AWS's list of the headers that an edge function may not add or change ("Restrictions on edge functions").
    const refused =
      /^(connection|expect|keep-alive|proxy-authenticate|proxy-authorization|proxy-connection|trailer|upgrade|x-accel-.*|x-amz-cf-.*|x-amzn-.*|x-cache|x-edge-.*|x-forwarded-proto|x-real-ip|content-length|host|transfer-encoding|via)$/;
    const { done } = await signIn();
    const cookies = { "__Host-erga": done.cookies["__Host-erga"].value };
    const sent = event(`https://${SHELL}/documents`, { cookies });
    const before = JSON.stringify(sent.request.headers);
    const had = JSON.parse(before) as Record<string, unknown>;
    const on = await viewer(sent);
    const wrote = Object.keys(on.headers).filter((h) => JSON.stringify(on.headers[h]) != JSON.stringify(had[h]));
    expect(wrote.sort()).toEqual([CALLER, "x-erga-wire", "x-forwarded-host"]);
    expect(wrote.filter((h) => refused.test(h))).toEqual([]);
    // And each answer of the gate's own: its headers.
    for (const url of [
      `https://${SHELL}/documents`,
      `https://${SHELL}/_edge/sign-in`,
      `https://${SHELL}/.well-known/oauth-authorization-server`,
    ])
      expect(Object.keys((await viewer(event(url))).headers).filter((h) => refused.test(h))).toEqual([]);
  });

  test("each function answers its own addresses only: any other is a 404, also with a proof", async () => {
    const { done } = await signIn();
    const cookies = { "__Host-erga": done.cookies["__Host-erga"].value, "__Host-member": done.cookies["__Host-member"].value };
    const at = (path: string) => event(`https://${SHELL}${path}`, { cookies });
    expect((await fn.request(at("/_edge/sign-in"))).statusCode).toBe(404);
    expect((await fn.request(event(`https://accept.${CONTENT}/t/pass/`, { cookies }))).statusCode).toBe(404);
    expect((await fn.edge(at("/documents"))).statusCode).toBe(404);
    expect((await fn.edge(at("/oauth/token"))).statusCode).toBe(404);
    expect((await fn.agents(at("/documents"))).statusCode).toBe(404);
    expect((await fn.agents(at("/_edge/sign-in"))).statusCode).toBe(404);
  });

  test("the hand-off: the request function starts it, and the edge function runs its two steps", async () => {
    const { done } = await signIn();
    const first = await viewer(event(PAGE, { dest: "iframe" }));
    expect(first.statusCode).toBe(200);
    expect(first.cookies.nonce.attributes).toBe(`Path=/; Max-Age=120; HttpOnly; Domain=${CONTENT}; Secure; SameSite=None; Partitioned`);
    const vouch = await viewer(
      event(hopOf(first.body.data), { dest: "iframe", cookies: { "__Host-member": done.cookies["__Host-member"].value } })
    );
    expect(hopOf(vouch.body.data).startsWith(`https://accept.${CONTENT}/_edge/accept?ticket=`)).toBe(true);
    const accept = await viewer(event(hopOf(vouch.body.data), { dest: "iframe", cookies: { nonce: first.cookies.nonce.value } }));
    expect(hopOf(accept.body.data)).toBe(PAGE);
    const page = await viewer(event(PAGE, { dest: "iframe", cookies: { member: accept.cookies.member.value } }));
    expect(callerIn(page)).toEqual({ kind: "member" });
    expect(page.cookies).toEqual({});
  });

  test("an agent: the code from the response function, the token from the agents' function through the Lambda", async () => {
    const { done } = await signIn();
    const verifier = "v".repeat(43);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: "claude-code",
      redirect_uri: "http://localhost:8123/callback",
      state: "st",
      code_challenge: await port.sha256(verifier),
      code_challenge_method: "S256",
    });
    const cookies = { "__Host-erga": done.cookies["__Host-erga"].value };
    const post = event(`https://${SHELL}/oauth/authorize?${query}`, { method: "POST", cookies, dest: "empty" });
    const onward = await viewer(structuredClone(post));
    expect(callerIn(onward).kind).toBe("person");
    // Erga approved. The response function sees the request as the request function left it (no gate cookies: a real
    // distribution shows it so), and takes the caller from its sealed header.
    expect(onward.cookies["__Host-erga"]).toBeUndefined();
    const signed = await fn.response({
      context: post.context,
      request: onward,
      response: { statusCode: 200, headers: { [ASK]: { value: "code grant1" } }, cookies: {} },
    });
    expect(signed.statusCode).toBe(302);
    expect(signed.headers[ASK]).toBeUndefined();
    const code = new URL(signed.headers.location.value).searchParams.get("code")!;
    expect(code).toMatch(/^c\./);
    // The token endpoint: no body at the function, so on to the Lambda, which sends the body here again in a header.
    const tokenPost = event(`https://${SHELL}/oauth/token`, { method: "POST", dest: "empty" });
    expect(await fn.agents(tokenPost)).toBe(tokenPost.request);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "claude-code",
      redirect_uri: "http://localhost:8123/callback",
      code_verifier: verifier,
      code,
    }).toString();
    const again = (async (url: string, init: RequestInit) => {
      const answer = await fn.agents(event(url, { method: "POST", dest: "empty", headers: Object.fromEntries(new Headers(init.headers)) }));
      // (The function's answer comes back through the distribution, with CloudFront's own headers beside it.)
      const headers = Object.fromEntries(Object.entries(answer.headers as Record<string, { value: string }>).map(([k, v]) => [k, v.value]));
      return new Response(answer.body.data, { status: answer.statusCode, headers: { ...headers, "x-cache": "Miss from cloudfront" } });
    }) as unknown as typeof fetch;
    const answer = await lambda(
      {
        Records: [
          {
            cf: {
              request: {
                method: "POST",
                uri: "/oauth/token",
                headers: {},
                body: { data: Buffer.from(form).toString("base64"), encoding: "base64" },
              },
            },
          },
        ],
      },
      null,
      { fetch: again }
    );
    expect(answer.status).toBe("200");
    // The function's answer goes back as it is: a page of any origin may read it (CORS), and no cache keeps it.
    expect(answer.headers).toEqual({
      "cache-control": [{ value: "no-store" }],
      "content-type": [{ value: "application/json" }],
      "referrer-policy": [{ value: "no-referrer" }],
      "x-content-type-options": [{ value: "nosniff" }],
      "access-control-allow-origin": [{ value: "*" }],
    });
    const tokens = JSON.parse(answer.body!);
    const mcp = await viewer(
      event(`https://${SHELL}/mcp`, { method: "POST", dest: "empty", headers: { authorization: `Bearer ${tokens.access_token}` } })
    );
    expect(callerIn(mcp)).toEqual({ kind: "agent", p: "sso", sub: "sub-ada", g: "grant1", x: expect.stringMatching(/^[\w-]{16}$/) });
    expect(mcp.headers.authorization).toBeUndefined();
    // The metadata is the agents' function's; any other address there is nothing.
    expect((await fn.agents(event(`https://${SHELL}/.well-known/oauth-authorization-server`))).statusCode).toBe(200);
    expect((await fn.agents(event(`https://${SHELL}/documents`))).statusCode).toBe(404);
  });

  test("the response function signs for the caller of the request's own proof, never for a caller's header from the viewer", async () => {
    const end = Math.floor(Date.now() / 1000) + 3600;
    const victim = { kind: "person", p: "sso", sub: "sub-root", email: "root@example.com", name: "Root", i: 1, e: end };
    const forged = {
      [CALLER]: Buffer.from(JSON.stringify(victim)).toString("base64url"),
      // A sealed caller with another key, and one with no seal: neither counts.
      "x-erga-wire": await seal(port, "another key, of 32 characters or more", "w", { c: victim }, end),
    };
    const asks = (request: unknown, ask: string) =>
      fn.response({
        context: { requestId: "cf-forged" },
        request,
        response: { statusCode: 200, headers: { [ASK]: { value: ask } }, cookies: {} },
      });
    // With no proof: no token, and no code.
    const nobody = event(`https://${SHELL}/tokens/new`, { method: "POST", dest: "empty", headers: forged });
    expect((await asks(nobody.request, `token grant9 ${end}`)).headers[TOKEN]).toBeUndefined();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: "claude-code",
      redirect_uri: "http://localhost:8123/callback",
      code_challenge: await port.sha256("v".repeat(43)),
      code_challenge_method: "S256",
    });
    const authorize = event(`https://${SHELL}/oauth/authorize?${query}`, { method: "POST", dest: "empty", headers: forged });
    const refused = await asks(authorize.request, "code grant9");
    expect([refused.statusCode, refused.headers.location]).toEqual([200, undefined]);
    // With their own sign-in: a token for themselves, whatever the header says.
    const { done } = await signIn();
    const cookies = { "__Host-erga": done.cookies["__Host-erga"].value };
    const ada = event(`https://${SHELL}/tokens/new`, { method: "POST", dest: "empty", cookies, headers: forged });
    const token = (await asks(ada.request, `token grant9 ${end}`)).headers[TOKEN].value;
    expect(await open(port, KEY, "a", token, Date.now() / 1000)).toMatchObject({ sub: "sub-ada", g: "grant9" });
  });

  test("the token endpoint's POST with no body ends at the function: the Lambda's header is never empty", async () => {
    let asked = 0;
    // A header with no value may be lost on the way: this pretends that it is. Then the function hears no body yet.
    const again = (async (url: string, init: RequestInit) => {
      asked++;
      const headers = Object.fromEntries([...new Headers(init.headers)].filter(([, value]) => value.trim()));
      const e = event(url, { method: "POST", dest: "empty", headers });
      const answer = await fn.agents(e);
      if (answer == e.request) throw new Error("The function sent the request on to the Lambda again: a loop.");
      return new Response(answer.body.data, { status: answer.statusCode });
    }) as unknown as typeof fetch;
    for (const body of [undefined, { data: "", encoding: "text" }, { data: Buffer.from(" ").toString("base64"), encoding: "base64" }]) {
      const request = { method: "POST", uri: "/oauth/token", headers: {}, ...(body ? { body } : {}) };
      const answer = await lambda({ Records: [{ cf: { request } }] }, null, { fetch: again });
      expect([answer.status, JSON.parse(answer.body!)]).toEqual(["400", { error: "unsupported_grant_type" }]);
    }
    expect(asked).toBe(3);
  });

  test("a person's page with no member cookie gets one again: the response function sets the cookie that the core asks for", async () => {
    const { done } = await signIn();
    const shell = { "__Host-erga": done.cookies["__Host-erga"].value };
    const answered = (e: ReturnType<typeof event>, ask?: string, f = fn.response) =>
      f({ ...e, response: { statusCode: 200, headers: ask ? { [ASK]: { value: ask } } : {}, cookies: {} } });
    // The browser lost its member cookie only (or never had one): its next page of the shell brings it back.
    const page = await answered(event(`https://${SHELL}/documents`, { cookies: shell }));
    expect(Object.keys(page.cookies)).toEqual(["__Host-member"]);
    expect(page.cookies["__Host-member"].attributes).toMatch(/^Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=None$/);
    expect(await open(port, KEY, "m", page.cookies["__Host-member"].value, Date.now() / 1000)).not.toBeNull();
    // Content under the shell's host: the one member cookie, for the shell's domain. Without it no document opens there.
    const near = await load("response", { ...settings, content: `pages.${SHELL}` }, "response-near");
    const one = await answered(event(`https://${SHELL}/documents`, { cookies: shell }), undefined, near);
    expect(one.cookies.member.attributes).toMatch(new RegExp(`^Path=/; Max-Age=\\d+; HttpOnly; Domain=${SHELL}; Secure; SameSite=Lax$`));
    // None: with the cookie; for a script's request; for nobody, whatever header names a caller; on a document's host.
    const forged = {
      [CALLER]: Buffer.from(JSON.stringify({ kind: "person", sub: "sub-ada", e: Date.now() / 1000 + 60 })).toString("base64url"),
    };
    for (const e of [
      event(`https://${SHELL}/documents`, { cookies: { ...shell, "__Host-member": page.cookies["__Host-member"].value } }),
      event(`https://${SHELL}/api/news`, { cookies: shell, dest: "empty" }),
      event(`https://${SHELL}/documents`, { headers: forged }),
      event(PAGE, { cookies: shell, dest: "iframe", headers: forged }),
    ])
      expect((await answered(e)).cookies).toEqual({});
    // An answer that signs out only ends the cookies.
    const out = await answered(event(`https://${SHELL}/documents`, { cookies: shell }), "out");
    expect(out.cookies["__Host-member"].attributes).toContain("Max-Age=0");
  });

  test("a document's answer asks the gate nothing", async () => {
    const out = await fn.response({
      ...event(PAGE, { dest: "iframe" }),
      response: { statusCode: 200, headers: { [ASK]: { value: "out" } }, cookies: {} },
    });
    expect(out.cookies).toEqual({});
    expect(out.headers[ASK]).toBeUndefined();
  });
});
