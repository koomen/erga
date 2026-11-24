// The two halves together, as on Cloudflare with single sign-on: the whole app in memory (tests/helpers/app.ts), whose
// deploy says that the gate is inside its Worker with the organization's sign-in (the setting SSO: gate/sso.ts). Every
// request passes the gate first (server/identity/mount.ts), and nobody comes in without a proof.
//
// With an OIDC issuer, one browser, one person's journey: sign in one time, then documents open, on the app's site and
// on the documents' site (another site: the hand-off); an agent connects (authorize, approve, token, refresh); a
// revoke, after which the agent gets a 401; a token to paste; a code that is traded two times; sign-out, which ends
// her other browser's sign-in too. Then the same server behind Cloudflare Access: Access's proof is the sign-in. Last,
// a new server with no admin: the setup page (server/identity/setup.ts) behind the gate, with an issuer and behind
// Access: its link, the deployer's token, and the button that makes the admin.

import { expect, test } from "bun:test";
import { ACCESS_OPEN } from "../gate/core.ts";
import { ssoOf } from "../gate/sso.ts";
import { setupUrl } from "../server/identity/setup-link.ts";
import { server as app } from "./helpers/app";
import { browser } from "./helpers/gate.ts";
import { asNewServer, rowsOf, TOKEN } from "./helpers/new-server.ts";

const SHELL = "erga.example";
// (The test server's documents are under localhost: <id>-<owner>.localhost, another site than the app's.)
const CONTENT = "localhost";
const ISSUER = "https://idp.example.com";
const IDP = { issuer: ISSUER, authorize: `${ISSUER}/authorize`, token: `${ISSUER}/token`, client: "client-1" };
/** Where the agent's app listens, on the person's computer. */
const APP = "http://localhost:53682/callback";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const ORIGIN = `https://${SHELL}`;
const JSON_POST = { "content-type": "application/json", origin: ORIGIN };
const FORM_POST = { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN };

/** A new server whose people come in by `sso` only, each with an account named from their address. */
async function serverWith(sso: ReturnType<typeof ssoOf>) {
  const s = app();
  (s.platform as { signIn: unknown }).signIn = { mode: "gate", at: "inside", sso, devLogin: null, encryptionKey: "local:secret" };
  // The app's host, as the deploy's facts name it: the gate's shell, on a document's host too.
  (s.platform.deploy as { app: string | null }).app = SHELL;
  const admin = { login: "tester", admin: true };
  // Everybody whom the organization's sign-in lets through may make an account, named from their address.
  await s.dir.setAnyone(admin, "write");
  await s.dir.config.set(admin, "usernames", "email");
  return s;
}

/** A new server with the gate inside it, an issuer that signs Ada in, and her browser. */
async function setUp() {
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
  const s = await serverWith(ssoOf(JSON.stringify({ oidc: IDP }), "idp-secret", issuer));
  const gate = (request: Request) => s.fetch(request.url, request);
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

test("the gate inside, with an issuer: one sign-in, then documents open on both sites; an agent connects, is revoked, and gets a 401; a token to paste; sign-out", async () => {
  const { s, gate, b, phone, outside } = await setUp();
  // Nothing of the server answers without a proof: anything but a page gets a 401, on both sites, and a caller's
  // header from outside names nobody.
  expect((await gate(new Request(`${ORIGIN}/api/tools/whoami`, { method: "POST" }))).status).toBe(401);
  expect((await gate(new Request(`https://x-ada.${CONTENT}/t/x/`))).status).toBe(401);
  // One address goes on with no proof, as nobody: the server's health report, which the account's deployer asks after
  // each deploy (gate/core.ts, Config.health). Its route is the Worker's own (cloudflare/deploy-routes.ts): here the
  // server itself answers that it has none, where the gate answers a 401 for any other address.
  const status = async (path: string, init?: RequestInit) => (await gate(new Request(`${ORIGIN}${path}`, init))).status;
  expect([await status("/api/health"), await status("/api/nothing"), await status("/api/health", { method: "POST" })]).toEqual([
    404, 401, 401,
  ]);
  const forged = Buffer.from(JSON.stringify({ kind: "person", p: "sso", sub: "sub-ada", email: "ada@example.com", name: "Ada", i: 1 }));
  expect(
    (await gate(new Request(`${ORIGIN}/api/tools/whoami`, { method: "POST", headers: { "x-erga-caller": forged.toString("base64url") } })))
      .status
  ).toBe(401);

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
  expect(await (await b.go(ask)).text()).toContain("<b>claude code</b> wants to act for you");
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
  expect(me).toMatchObject({ login: "ada", token: { label: "claude code", scope: "documents" } });
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

let teams = 0;
/** A new server behind Cloudflare Access, whose team signs Ada's proof: `behind(jwt)` is Access in front, with that proof. */
async function behindAccess() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" }] };
  // (A team of its own for each server: the gate keeps a team's keys for an hour.)
  const access = { team: `team-of-erga-${++teams}`, aud: "a1".repeat(32) };
  const certs = (async () => Response.json(jwks)) as unknown as typeof fetch;
  const s = await serverWith(ssoOf(JSON.stringify({ access }), "", certs));
  const proof = async (claims: object) => {
    const signed = `${b64({ alg: "RS256", kid: "k1" })}.${b64({ iss: `https://${access.team}.cloudflareaccess.com`, aud: [access.aud], exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(signed));
    return `${signed}.${Buffer.from(sig).toString("base64url")}`;
  };
  const ada = await proof({ sub: "sub-ada", email: "ada@example.com", name: "Ada Lovelace" });
  // Access in front of the app's host: each request it lets through carries its proof; the paths that it lets through
  // with no sign-in (the gate's own list) carry none, and neither does the documents' site.
  const bypassed = (path: string) => ACCESS_OPEN.some((open) => path == open || path.startsWith(`${open}/`));
  const behind = (jwt: string | null) => (request: Request) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete("cf-access-jwt-assertion");
    if (jwt && url.host == SHELL && !bypassed(url.pathname)) headers.set("cf-access-jwt-assertion", jwt);
    return s.fetch(request.url, new Request(request, { headers }));
  };
  return { s, behind, proof, ada, access, pair };
}

test("the gate inside, behind Cloudflare Access: Access's proof is the sign-in; the paths that Access lets through take the gate's own values", async () => {
  const { s, behind, proof, ada, access } = await behindAccess();
  const b = browser(behind(ada));
  // Her first page: no sign-in of the gate's own, and her account at once, from the address that Access gave.
  const list = await b.go(`${ORIGIN}/documents`);
  expect([list.status, b.trail]).toEqual([200, [`${SHELL}/documents`, `${SHELL}/auth/sign-in`, `${SHELL}/auth/sso`, `${SHELL}/documents`]]);
  expect((await s.dir.identities.find("sso", "sub-ada"))?.login).toBe("ada");
  expect([b.cookie("__Host-erga", SHELL), !!b.cookie("__Host-member", SHELL)]).toEqual([undefined, true]);
  // A document opens in its frame on the documents' site, through the gate's hand-off (the vouch has no Access proof).
  const html = await (await b.go(`${ORIGIN}/new`)).text();
  const frame = new RegExp(`https://[a-z0-9]+-ada\\.${CONTENT}/t/[\\w.-]+/`).exec(html)![0];
  expect((await b.go(frame, { frame: true })).status).toBe(200);
  // With no proof, with a proof that the team did not sign, or for another application: nobody, and nothing of Erga.
  const other = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const [head, body] = ada.split(".");
  const badSig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", other.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  const whoami = (jwt: string | null) =>
    behind(jwt)(new Request(`${ORIGIN}/api/tools/whoami`, { method: "POST", headers: JSON_POST, body: "{}" }));
  expect((await whoami(ada)).status).toBe(200);
  for (const jwt of [null, `${head}.${body}.${badSig.toString("base64url")}`, await proof({ sub: "sub-ada", aud: ["b2".repeat(32)] })])
    expect((await whoami(jwt)).status).toBe(401);
  expect((await behind(null)(new Request(frame, { headers: { "sec-fetch-dest": "empty" } }))).status).toBe(401);
  // The deployer asks the server's health through its binding to the Worker, past Access and with no proof: the gate
  // lets that one address through, as nobody (the server in memory has no such route: its own 404).
  expect((await behind(null)(new Request(`${ORIGIN}/api/health`))).status).toBe(404);
  // An agent has no Access sign-in: its token, which the gate signed for her, opens /mcp, a path that Access lets through.
  const made = await b.go(`${ORIGIN}/tokens/new`, {
    method: "POST",
    dest: "empty",
    headers: JSON_POST,
    body: JSON.stringify({ label: "Script", scope: "documents" }),
  });
  const mcp = (bearer: string | null) =>
    behind(null)(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "documents", arguments: { op: "whoami" } } }),
      })
    );
  expect([(await mcp(made.headers.get("x-erga-token"))).status, (await mcp(null)).status, (await mcp("a.forged.token")).status]).toEqual([
    200, 401, 401,
  ]);
  // Sign-out: the gate's cookies end, and the page goes on to Access's own sign-out, which ends Access's sign-in.
  const out = await b.go(`${ORIGIN}/auth/logout`, { method: "POST", headers: { origin: ORIGIN } });
  expect([out.status, b.cookie("__Host-member", SHELL), /"to":"([^"]+)"/.exec(await out.text())![1]]).toEqual([
    200,
    undefined,
    "/cdn-cgi/access/logout",
  ]);
});

test("behind Cloudflare Access, a custom domain's published site answers anyone, and no other host does", async () => {
  const { s, behind, ada } = await behindAccess();
  // The deploy's custom domain (`bun erga deploy <host> --domain <domain>`): Access is in front of the app's host only.
  s.platform.deploy.domains.push("site.example.com");
  // Ada, an admin, publishes a document there.
  await browser(behind(ada)).go(`${ORIGIN}/documents`);
  await s.dir.users.setRole({ login: "tester", admin: true }, "ada", "admin");
  const tool = async (name: string, args: object) =>
    (
      await behind(ada)(new Request(`${ORIGIN}/api/tools/${name}`, { method: "POST", headers: JSON_POST, body: JSON.stringify(args) }))
    ).json();
  const page = "<!doctype html><html><head><title>Alpha</title></head><body><h1>Alpha</h1></body></html>";
  const document = (await tool("create_document", { title: "Alpha", files: { "index.html": page, "about.html": page } })).result.id;
  await tool("set_publishing", { document, domain: "site.example.com" });
  expect((await tool("publish_document", { document })).result.publishing).toMatchObject({ state: "published", serving: true });
  // Nobody's request, with no proof: the site's pages as they are.
  const anyone = behind(null);
  for (const path of ["/", "/about"]) {
    const r = await anyone(new Request(`https://site.example.com${path}`));
    expect([r.status, await r.text()]).toEqual([200, expect.stringContaining("<h1>Alpha</h1>")]);
  }
  // Nothing at a host that the deploy did not name; the app's own host asks for a proof.
  expect((await anyone(new Request("https://other.example.com/"))).status).toBe(404);
  expect((await anyone(new Request(`${ORIGIN}/api/tools/whoami`, { method: "POST" }))).status).toBe(401);
});

test("the gate inside, on a new server: the setup page's link passes the organization's sign-in; the deployer's token goes to the deployer; one button makes the person the admin", async () => {
  const { s, b, gate, outside } = await setUp();
  const { directory, deployer } = await asNewServer(s, SHELL);
  const link = await setupUrl(SHELL, s.platform.secret);
  // The link, with no proof: the organization's sign-in first, and back to the link.
  await b.go(link);
  expect(outside.at(-1)!.origin + outside.at(-1)!.pathname).toBe(IDP.authorize);
  b.trail.length = 0;
  const page = await b.go(`${ORIGIN}/_edge/callback?code=ada&state=${outside.at(-1)!.searchParams.get("state")}`);
  expect([page.status, b.trail]).toEqual([200, [`${SHELL}/_edge/callback`, `${SHELL}/setup`, `${SHELL}/setup`]]);
  // The page has no provider's row: the gate signs people in. Its steps are the deployer's token and the admin's.
  let html = await page.text();
  expect(rowsOf(html)).toEqual(["deployer next open", "admin next"]);
  // The last step names her as the gate did, with one button: no sign-in is left to do.
  expect(html).toContain("You are signed in with your organization's sign-in, as <b>ada@example.com</b>.");
  expect(html).not.toContain('class="provider');
  // The deployer's token, behind the gate: a request with no proof gets nothing, and reaches no deployer.
  const post = (token: string) => `token=${token}`;
  expect((await gate(new Request(`${ORIGIN}/setup/deployer`, { method: "POST", headers: FORM_POST, body: post(TOKEN) }))).status).toBe(401);
  expect(deployer.asked).toEqual([]);
  // Hers goes straight to the deployer: its refusal is at the field, and its yes is the row's answer.
  const refused = await b.go(`${ORIGIN}/setup/deployer`, { method: "POST", headers: FORM_POST, body: post("w".repeat(40)) });
  html = await refused.text();
  expect([refused.status, rowsOf(html)]).toEqual([400, ["deployer next open", "admin next"]]);
  expect(html).toContain('<p class="problem" role="alert">The token can read another Worker (other).</p>');
  html = await (await b.go(`${ORIGIN}/setup/deployer`, { method: "POST", headers: FORM_POST, body: post(TOKEN) })).text();
  expect(rowsOf(html)).toEqual(["deployer done", "admin next open"]);
  expect(html).toContain("Ready (at <code>aaaaaaaaaaaa</code>)");
  expect(deployer.asked).toEqual(["w".repeat(40), TOKEN]);
  // The button: her account is new, so she names it, and comes back as the admin. The page is closed then.
  b.trail.length = 0;
  await b.go(`${ORIGIN}/setup/admin`, { method: "POST", headers: FORM_POST, body: "" });
  expect(b.trail).toEqual([`${SHELL}/setup/admin`, `${SHELL}/auth/sign-in`, `${SHELL}/auth/sso`, `${SHELL}/auth/username`]);
  b.trail.length = 0;
  await b.go(`${ORIGIN}/auth/username`, { method: "POST", headers: FORM_POST, body: "username=ada" });
  expect(b.trail.slice(0, 3)).toEqual([`${SHELL}/auth/username`, `${SHELL}/setup/admin`, `${SHELL}/`]);
  expect(await directory.users.isAdmin("ada")).toBe(true);
  expect((await b.go(`${ORIGIN}/setup`)).status).toBe(410);
});

test("behind Cloudflare Access, on a new server: Access's proof opens the setup page's link, and the same steps make the admin", async () => {
  const { s, behind, ada } = await behindAccess();
  const { directory, deployer } = await asNewServer(s, SHELL);
  const link = await setupUrl(SHELL, s.platform.secret);
  // With no proof (Access let nobody through): no page, whatever the link.
  expect((await behind(null)(new Request(link, { headers: { "sec-fetch-dest": "document" } }))).status).toBe(401);
  // With Access's proof: the page at once, with no sign-in of the gate's own, and her address as Access gave it.
  const b = browser(behind(ada));
  const page = await b.go(link);
  expect([page.status, b.trail]).toEqual([200, [`${SHELL}/setup`, `${SHELL}/setup`]]);
  let html = await page.text();
  expect(rowsOf(html)).toEqual(["deployer next open", "admin next"]);
  expect(html).toContain("You are signed in with your organization's sign-in, as <b>ada@example.com</b>.");
  // The token and the button, as with an issuer: her account is new, so she names it, and comes back as the admin.
  html = await (await b.go(`${ORIGIN}/setup/deployer`, { method: "POST", headers: FORM_POST, body: `token=${TOKEN}` })).text();
  expect([rowsOf(html), deployer.asked]).toEqual([["deployer done", "admin next open"], [TOKEN]]);
  b.trail.length = 0;
  await b.go(`${ORIGIN}/setup/admin`, { method: "POST", headers: FORM_POST, body: "" });
  expect(b.trail).toEqual([`${SHELL}/setup/admin`, `${SHELL}/auth/sign-in`, `${SHELL}/auth/sso`, `${SHELL}/auth/username`]);
  b.trail.length = 0;
  await b.go(`${ORIGIN}/auth/username`, { method: "POST", headers: FORM_POST, body: "username=ada" });
  expect(b.trail.slice(0, 3)).toEqual([`${SHELL}/auth/username`, `${SHELL}/setup/admin`, `${SHELL}/`]);
  expect(await directory.users.isAdmin("ada")).toBe(true);
  expect((await b.go(`${ORIGIN}/setup`)).status).toBe(410);
});
