// The two halves together: the gate's own Worker (gate/mounts/worker.ts: an OIDC issuer signs people in, and nobody
// comes in without a proof) in front of the whole app in memory (tests/helpers/app.ts), whose deploy says a gate is in
// front (GATE_KEY). One browser, one person's journey: sign in one time, then documents open, on the app's site and on
// the documents' site (another site: the hand-off); an agent connects (authorize, approve, token, refresh); a revoke,
// after which the agent gets a 401; a token to paste; a code that is traded two times; sign-out, which ends her
// other browser's sign-in too.

import { expect, test } from "bun:test";
import type { Config } from "../gate/core.ts";
import { handle } from "../gate/mounts/web.ts";
import { type Env, mountOf } from "../gate/mounts/worker.ts";
import { server as app } from "./helpers/app";
import { browser } from "./helpers/gate.ts";

const SHELL = "erga.example";
// (The test server's documents are under localhost: <id>-<owner>.localhost, another site than the app's.)
const CONTENT = "localhost";
const ISSUER = "https://idp.example.com";
const IDP = { name: "corp", issuer: ISSUER, authorize: `${ISSUER}/authorize`, token: `${ISSUER}/token`, client: "client-1" };
const GATE_KEY = "the-key-of-the-gate-and-of-erga-".repeat(2);
/** Where the agent's app listens, on the person's computer. */
const APP = "http://localhost:53682/callback";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const ORIGIN = `https://${SHELL}`;
const JSON_POST = { "content-type": "application/json", origin: ORIGIN };
const FORM_POST = { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN };

/** The gate in front of a new server, an issuer that signs Ada in, and her browser. */
async function setUp() {
  const s = app();
  (s.platform as { signIn: unknown }).signIn = { mode: "gate", key: GATE_KEY, devLogin: null, encryptionKey: "local:secret" };
  const admin = { login: "tester", admin: true };
  // Everybody whom the organization's sign-in lets through may make an account, named from their address.
  await s.dir.rules.change(admin, (await s.dir.rules.list(admin)).find((r) => r.kind == "everybody")!.id, "write");
  await s.dir.config.set(admin, "auto_usernames", true);
  const env: Env = {
    ERGA: { fetch: (request) => s.fetch(request.url, request) },
    EDGE_KEY: "an-edge-key-that-erga-never-holds-".repeat(2),
    GATE_KEY,
    SHELL,
    CONTENT,
    IDP: JSON.stringify(IDP),
    IDP_SECRET: "idp-secret",
  };
  /** The issuer's token endpoint: Ada's ID token for the code "ada". */
  const issuer = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new URLSearchParams(String(init?.body));
    if (String(input) != IDP.token || sent.get("code") != "ada") return new Response("{}", { status: 400 });
    const claims = {
      iss: ISSUER,
      aud: "client-1",
      exp: Date.now() / 1000 + 300,
      sub: "sub-ada",
      email: "ada@example.com",
      email_verified: true,
    };
    return Response.json({ id_token: `${b64({ alg: "RS256" })}.${b64({ ...claims, name: "Ada Lovelace" })}.sig` });
  }) as typeof fetch;
  const mount = mountOf(env, issuer);
  const gate = (request: Request) => handle(request, mount);
  /** The addresses the browser reached that are not the gate's: the issuer's sign-in page, and the agent's app. */
  const outside: URL[] = [];
  const net = async (request: Request) => {
    const url = new URL(request.url);
    if (url.host != "idp.example.com" && url.origin != new URL(APP).origin) return gate(request);
    outside.push(url);
    return new Response("outside");
  };
  return { s, gate, b: browser(net), phone: browser(net), outside };
}

test("the gate's Worker: a sign-in lasts the deploy's SIGN_IN_DAYS, from 1 to 90, or 30 days when it says none", () => {
  const env = { ERGA: { fetch: async () => new Response() }, EDGE_KEY: "e".repeat(40), GATE_KEY, SHELL, CONTENT, ACCESS: "{}" };
  const hours = (o: Partial<Env>) => (mountOf({ ...env, ...o }).config(new Request(ORIGIN)) as Config).hours;
  expect([hours({}), hours({ SIGN_IN_DAYS: "7" }), hours({ SIGN_IN_DAYS: 1 })]).toEqual([30 * 24, 7 * 24, 24]);
  for (const days of ["0", "91", "1.5", "", "soon", -1]) expect(() => hours({ SIGN_IN_DAYS: days })).toThrow("SIGN_IN_DAYS");
});

test("behind the gate: one sign-in, then documents open on both sites; an agent connects, is revoked, and gets a 401; a token to paste; sign-out", async () => {
  const { s, gate, b, phone, outside } = await setUp();
  // Nothing of the server answers without a proof: anything but a page gets a 401, and the server's own address
  // answers nobody (it has none, on Cloudflare; and no request counts without the gate's key).
  expect((await gate(new Request(`${ORIGIN}/api/tools/whoami`, { method: "POST" }))).status).toBe(401);
  expect((await gate(new Request(`https://x-ada.${CONTENT}/t/x/`))).status).toBe(401);
  expect((await s.fetch(`${ORIGIN}/documents`)).status).toBe(403);

  // --- Sign in, one time. A page with no proof goes to the organization's sign-in; back, the server makes her account
  // from her address at once, and her list shows.
  await b.go(`${ORIGIN}/documents`);
  expect(outside.at(-1)!.origin + outside.at(-1)!.pathname).toBe(IDP.authorize);
  const list = await b.go(`${ORIGIN}/_edge/callback?code=ada&state=${outside.at(-1)!.searchParams.get("state")}`);
  expect([list.status, b.trail.slice(-5)]).toEqual([
    200,
    [`${SHELL}/_edge/callback`, `${SHELL}/documents`, `${SHELL}/auth/sign-in`, `${SHELL}/auth/sso`, `${SHELL}/documents`],
  ]);
  expect((await s.dir.identities.find("sso", "sub-ada"))?.login).toBe("ada");
  // (Her phone signs in too: sign-out, at the end, ends its sign-in.)
  const signIn = async (browser: typeof b) => {
    await browser.go(`${ORIGIN}/documents`);
    return browser.go(`${ORIGIN}/_edge/callback?code=ada&state=${outside.at(-1)!.searchParams.get("state")}`);
  };
  expect((await signIn(phone)).status).toBe(200);
  // Her list frames a page of the documents' site, hidden: the gate's hand-off runs there, before her first document.
  const warm = /<iframe hidden src="([^"]+)"/.exec(await list.text())![1];
  expect(warm).toBe(`https://warm.${CONTENT}/erga-warm`);
  b.trail.length = 0;
  expect((await b.go(warm, { frame: true })).status).toBe(200);
  expect(b.trail).toEqual([
    `warm.${CONTENT}/erga-warm`,
    `${SHELL}/_edge/vouch`,
    `accept.${CONTENT}/_edge/accept`,
    `warm.${CONTENT}/erga-warm`,
  ]);

  // --- Documents open, with no more sign-in: the editor on the app's site, and the page in its frame on the
  // documents' site, which has its cookie already (one request, no hand-off).
  const editor = await b.go(`${ORIGIN}/new`);
  expect(editor.status).toBe(200);
  const html = await editor.text();
  expect(html).toContain('<meta name="erga-doc"');
  const frame = new RegExp(`https://[a-z0-9]+-ada\\.${CONTENT}/t/[\\w.-]+/`).exec(html)![0];
  b.trail.length = 0;
  const page = await b.go(frame, { frame: true });
  expect([page.status, b.trail.length]).toEqual([200, 1]);
  const framed = await page.text();
  expect(framed).toContain("<!doctype html>");
  // The page asks for no service worker of Erga's here: a browser sends the member cookie (another site's, in the
  // frame) with none of a worker's requests, and the gate lets nothing through without it, the worker's script too.
  expect(framed).toContain('"worker":false');
  const script = new Request(`${new URL(frame).origin}/erga-sw.js`, {
    headers: { "sec-fetch-dest": "serviceworker", "service-worker": "script" },
  });
  expect((await gate(script)).status).toBe(401);
  // A script's request on that site passes by the frame's cookie; another browser's does not.
  expect((await b.go(`${frame}style.css`, { frame: true, dest: "style" })).status).not.toBe(401);
  expect((await gate(new Request(frame, { headers: { "sec-fetch-dest": "empty" } }))).status).toBe(401);

  // --- An agent connects: the gate's metadata and token endpoint, the server's approval page.
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)).join(""));
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const ask = `${ORIGIN}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: "claude-code", redirect_uri: APP, code_challenge: challenge, code_challenge_method: "S256", state: "s-1" })}`;
  expect(await (await b.go(ask)).text()).toContain("<b>claude-code</b> wants to act for you");
  await b.go(ask, { method: "POST", headers: FORM_POST, body: "answer=approve" });
  const back = outside.at(-1)!;
  expect([back.origin + back.pathname, back.searchParams.get("state")]).toEqual([APP, "s-1"]);
  const token = (fields: Record<string, string>) =>
    gate(
      new Request(`${ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "content-type": FORM_POST["content-type"] },
        body: new URLSearchParams(fields),
      })
    );
  const got = (await (
    await token({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: APP,
      client_id: "claude-code",
    })
  ).json()) as { access_token: string; refresh_token: string };
  const mcp = (bearer: string) =>
    gate(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "documents", arguments: { op: "whoami" } } }),
      })
    );
  const me = JSON.parse(
    ((await (await mcp(got.access_token)).json()) as { result: { content: { text: string }[] } }).result.content[0].text
  );
  expect(me).toMatchObject({ login: "ada", token: { label: "claude-code", scope: "documents" } });
  // The refresh grant gives the next token, for the same grant.
  const next = (await (
    await token({ grant_type: "refresh_token", refresh_token: got.refresh_token, client_id: "claude-code" })
  ).json()) as typeof got;
  expect((await mcp(next.access_token)).status).toBe(200);

  // --- Revoke: the agent's next request gets a 401, with either token.
  const revoked = await b.go(`${ORIGIN}/api/tools/revoke`, {
    method: "POST",
    dest: "empty",
    headers: JSON_POST,
    body: JSON.stringify({ token: me.token.id }),
  });
  expect(revoked.status).toBe(200);
  for (const t of [got.access_token, next.access_token]) {
    const refused = await mcp(t);
    expect([refused.status, refused.headers.get("www-authenticate")]).toEqual([401, expect.stringContaining('error="invalid_token"')]);
  }

  // --- A token to paste: the server makes the grant, the gate signs the token, and what the server asked of the gate
  // never leaves it.
  const made = await b.go(`${ORIGIN}/tokens/new`, {
    method: "POST",
    dest: "empty",
    headers: JSON_POST,
    body: JSON.stringify({ label: "Script", scope: "documents" }),
  });
  const pasted = made.headers.get("x-erga-token")!;
  expect([made.status, made.headers.get("x-erga-gate")]).toEqual([200, null]);
  expect((await mcp(pasted)).status).toBe(200);

  // --- A code traded two times (the gate keeps no state: the code is good for its 60 seconds, with its verifier).
  // The grant is the exchange's whose token comes first; a token of the other ends the grant, for both.
  await b.go(ask, { method: "POST", headers: FORM_POST, body: "answer=approve" });
  const again = { code: outside.at(-1)!.searchParams.get("code")!, code_verifier: verifier, redirect_uri: APP, client_id: "claude-code" };
  const trade = async () => (await (await token({ grant_type: "authorization_code", ...again })).json()) as typeof got;
  const [one, two] = [await trade(), await trade()];
  expect([(await mcp(one.access_token)).status, (await mcp(two.access_token)).status]).toEqual([200, 401]);
  expect((await mcp(one.access_token)).status).toBe(401);

  // --- Sign-out: the gate ends its cookies on the app's site, and the page loads its sign-out on the documents' site.
  const copied = `__Host-erga=${b.cookie("__Host-erga", SHELL)!.value}`;
  const out = await b.go(`${ORIGIN}/auth/logout`, { method: "POST", headers: { origin: ORIGIN } });
  expect([out.status, out.headers.get("x-erga-gate")]).toEqual([200, null]);
  expect([b.cookie("__Host-erga", SHELL), b.cookie("__Host-member", SHELL)]).toEqual([undefined, undefined]);
  const gateOut = /"gate":"([^"]+)"/.exec(await out.text())![1];
  expect(gateOut).toBe(`https://accept.${CONTENT}/_edge/sign-out`);
  expect(b.cookie("member", CONTENT)).toBeDefined();
  await b.go(gateOut, { frame: true });
  expect(b.cookie("member", CONTENT)).toBeUndefined();
  // Signed out: her list goes to the organization's sign-in again, and a document's page opens for nobody.
  const before = outside.length;
  await b.go(`${ORIGIN}/documents`);
  expect([outside.length, outside.at(-1)!.host]).toEqual([before + 1, "idp.example.com"]);
  expect((await gate(new Request(frame, { headers: { "sec-fetch-dest": "empty" } }))).status).toBe(401);
  // The agent's pasted token is not the browser's sign-in: it works until it ends or she revokes it.
  expect((await mcp(pasted)).status).toBe(200);

  // --- Sign-out ended every sign-in of hers. A copy of the cookie from before it is nobody's: the server refuses it.
  // A page has the gate end the cookies (a redirect to itself that asks); any other request gets its refusal only,
  // since CloudFront's response function never sees an answer of 400 or more (admit.ts, signedOut).
  const ends = (r: Response) => r.headers.getSetCookie().map((c) => c.split("; ").slice(0, 3).join("; "));
  const ENDED = ["__Host-erga=; Path=/; Max-Age=0", "__Host-member=; Path=/; Max-Age=0"];
  const stale = await gate(
    new Request(`${ORIGIN}/api/tools/whoami`, { method: "POST", headers: { ...JSON_POST, cookie: copied }, body: "{}" })
  );
  expect([stale.status, ends(stale), stale.headers.get("x-erga-gate")]).toEqual([401, [], null]);
  const stalePage = await gate(new Request(`${ORIGIN}/documents`, { headers: { cookie: copied, "sec-fetch-dest": "document" } }));
  expect([stalePage.status, ends(stalePage)]).toEqual([302, ENDED]);
  // Her phone still has the gate's cookies from before the sign-out: its next page goes to the organization's
  // sign-in (not around in a loop), and she signs in again there.
  const asked = outside.length;
  await phone.go(`${ORIGIN}/documents`);
  expect([outside.length, outside.at(-1)!.host, phone.cookie("__Host-erga", SHELL)]).toEqual([asked + 1, "idp.example.com", undefined]);
  const back2 = await phone.go(`${ORIGIN}/_edge/callback?code=ada&state=${outside.at(-1)!.searchParams.get("state")}`);
  expect([back2.status, phone.trail.at(-1)]).toEqual([200, `${SHELL}/documents`]);
});
