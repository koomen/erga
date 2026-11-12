// The proxy mode (server/identity/proxy.ts, mode.ts): a proxy in front of the server signs each person in, and its
// signed header is the sign-in. A pretend AWS and a pretend Cloudflare Access sign the header here, each with a key it
// serves at the proxy's own address.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { base64, base64url } from "../shared/bytes";
import { Directory } from "../server/directory/index.ts";
import { usernameStep } from "../server/identity/accounts";
import { providersOf, signInOf } from "../server/identity/mode";
import { finishOAuth, startOAuth } from "../server/identity/oauth";
import { claimsOf, NoEmail, type Proxy, proxyOf, proxySignIn, readProxy, vouchedOf } from "../server/identity/proxy";
import { sessionOf } from "../server/identity/session";
import { authOps } from "../server/identity/settings";
import { chooseSignIn } from "../server/identity/sign-in";
import type { Platform } from "../server/platform";
import { respond } from "../server/http.ts";
import { memory } from "./helpers/memory-sql.ts";

const ORIGIN = "https://erga.example";
const AWS = {
  kind: "aws-alb",
  signer: "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/erga/50dc6c495c0c9188",
  issuer: "https://idp.example.com/pool",
  client: "client-1",
  email: { claim: "email", prefix: "" },
} satisfies Proxy;
const KID = "11111111-2222-3333-4444-555555555555";
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const pair = (await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"])) as CryptoKeyPair;
const other = (await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"])) as CryptoKeyPair;

/** Base64url with its padding, as the balancer writes each part. */
const part = (value: unknown) =>
  base64(new TextEncoder().encode(JSON.stringify(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

/** The header a balancer adds for `claims`: its own head (`head` changes it), signed with `key`. */
async function headerFor(claims: Record<string, unknown>, head: Record<string, unknown> = {}, key = pair.privateKey): Promise<string> {
  const h = part({
    alg: "ES256",
    kid: KID,
    signer: AWS.signer,
    iss: AWS.issuer,
    client: AWS.client,
    exp: Math.floor(Date.now() / 1000) + 120,
    ...head,
  });
  const p = part(claims);
  const s = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${base64(s).replace(/\+/g, "-").replace(/\//g, "_")}`;
}

const ADA = { sub: "sub-ada", email: "Ada@Example.com", email_verified: "true" };
const key = async () => pair.publicKey;

test("an AWS load balancer's header counts only from this balancer: its signature, its signer, its issuer and client, its time", async () => {
  expect(await readProxy(await headerFor(ADA), AWS, { key })).toEqual({
    provider: "proxy",
    subject: "sub-ada",
    handle: "ada@example.com",
    name: null,
    emails: [{ email: "ada@example.com", verified: true }],
    groups: [],
  });
  // Another balancer's header has AWS's signature too: its signer is not ours.
  expect(await readProxy(await headerFor(ADA, { signer: AWS.signer.replace("erga", "theirs") }), AWS, { key })).toBeNull();
  expect(await readProxy(await headerFor(ADA, { iss: "https://idp.example.com/other" }), AWS, { key })).toBeNull();
  expect(await readProxy(await headerFor(ADA, { client: "client-2" }), AWS, { key })).toBeNull();
  expect(await readProxy(await headerFor(ADA, { exp: Math.floor(Date.now() / 1000) - 1 }), AWS, { key })).toBeNull();
  expect(await readProxy(await headerFor(ADA, { alg: "none" }), AWS, { key })).toBeNull();
  // Signed with another key, or changed after it was signed, or no header.
  expect(await readProxy(await headerFor(ADA, {}, other.privateKey), AWS, { key })).toBeNull();
  const [h, , s] = (await headerFor(ADA)).split(".");
  expect(await readProxy(`${h}.${part({ ...ADA, sub: "sub-eve" })}.${s}`, AWS, { key })).toBeNull();
  expect(await readProxy("", AWS, { key })).toBeNull();
  // An email the sign-in doesn't call verified is kept as such.
  expect(await readProxy(await headerFor({ sub: "s", email: "bo@example.com" }), AWS, { key })).toMatchObject({
    emails: [{ email: "bo@example.com", verified: false }],
  });
});

// ------------------------------------------------------------ Cloudflare Access

const TEAM = "https://example-team.cloudflareaccess.com";
const ACCESS = {
  kind: "cloudflare-access",
  team: "example-team",
  aud: "aud-of-this-application",
  email: { claim: "email", prefix: "" },
} satisfies Proxy;
const ACCESS_KID = "access-key-1";
const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;
const accessPair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
const accessOther = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
const accessKey = async () => accessPair.publicKey;

/** The JWT Access adds for `claims` (RS256, no padding): its own claims (`claims` changes them), signed with `key`. */
async function accessHeader(claims: Record<string, unknown> = {}, key = accessPair.privateKey, head: Record<string, unknown> = {}) {
  const json = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const h = json({ alg: "RS256", kid: ACCESS_KID, typ: "JWT", ...head });
  const p = json({
    iss: TEAM,
    aud: [ACCESS.aud],
    exp: Math.floor(Date.now() / 1000) + 120,
    sub: "sub-cy",
    email: "Cy@Example.com",
    ...claims,
  });
  return `${h}.${p}.${base64url(await crypto.subtle.sign(RSA.name, key, new TextEncoder().encode(`${h}.${p}`)))}`;
}

test("Cloudflare Access's header counts only for this team's application: its signature, its team, its aud, its time", async () => {
  const o = { key: accessKey };
  expect(await claimsOf(await accessHeader(), ACCESS, o)).toMatchObject({ iss: TEAM, sub: "sub-cy", email: "Cy@Example.com" });
  // `aud` as one text, as some tokens have it.
  expect(await claimsOf(await accessHeader({ aud: "aud-of-this-application" }), ACCESS, o)).not.toBeNull();
  // Access lets a person through only by their address: it is verified, with no claim that says so.
  expect(await readProxy(await accessHeader({ name: "Cy" }), ACCESS, o)).toEqual({
    provider: "proxy",
    subject: "sub-cy",
    handle: "cy@example.com",
    name: "Cy",
    emails: [{ email: "cy@example.com", verified: true }],
    groups: [],
  });
  // Another application of the same team has the team's signature too: its aud is not ours.
  expect(await claimsOf(await accessHeader({ aud: ["aud-of-another-application"] }), ACCESS, o)).toBeNull();
  expect(await claimsOf(await accessHeader({ aud: [] }), ACCESS, o)).toBeNull();
  // Another team's, one that ended, one with no end.
  expect(await claimsOf(await accessHeader({ iss: "https://other-team.cloudflareaccess.com" }), ACCESS, o)).toBeNull();
  expect(await claimsOf(await accessHeader({ exp: Math.floor(Date.now() / 1000) - 1 }), ACCESS, o)).toBeNull();
  expect(await claimsOf(await accessHeader({ exp: undefined }), ACCESS, o)).toBeNull();
  // An application of ours that ends later than `now` says, but not at a later `now`.
  expect(await claimsOf(await accessHeader(), ACCESS, { ...o, now: Date.now() + 121_000 })).toBeNull();
  // Signed with another key, another way to sign, or changed after it was signed.
  expect(await claimsOf(await accessHeader({}, accessOther.privateKey), ACCESS, o)).toBeNull();
  expect(await claimsOf(await accessHeader({}, accessPair.privateKey, { alg: "none" }), ACCESS, o)).toBeNull();
  const [h, p, s] = (await accessHeader()).split(".");
  const changed = base64url(
    new TextEncoder().encode(JSON.stringify({ iss: TEAM, aud: ["aud-of-this-application"], exp: 9e9, sub: "sub-eve" }))
  );
  expect(await claimsOf(`${h}.${changed}.${s}`, ACCESS, o)).toBeNull();
  expect(await claimsOf(`${h}.${p}`, ACCESS, o)).toBeNull();
  // An AWS balancer's header is nothing to a server behind Access, and Access's nothing to one behind a balancer.
  expect(await claimsOf(await headerFor(ADA), ACCESS, { key })).toBeNull();
  expect(await claimsOf(await accessHeader(), AWS, o)).toBeNull();
});

// ------------------------------------------------------------ the mode, and the route

test("the deploy's PROXY_SIGN_IN: a proxy of a kind this reads; any other value is the proxy mode with no proxy, never OAuth", () => {
  expect(proxyOf(JSON.stringify(AWS))).toEqual(AWS);
  expect(proxyOf(JSON.stringify(ACCESS))).toEqual(ACCESS);
  const apps = { github: { clientId: "Ov23liGoodApp00000001", secret: "a".repeat(40) }, google: { clientId: "", secret: "" } };
  const origins = { github: null, google: null };
  expect(signInOf({ proxy: JSON.stringify(ACCESS), apps, origins })).toEqual({ mode: "proxy", proxy: ACCESS });
  for (const unreadable of [
    "yes",
    "{",
    '{"signer":"x"}',
    // The setting as it was before the kinds (no `kind`, an admin's email in it).
    JSON.stringify({
      signer: AWS.signer,
      issuer: "https://idp.example.com/pool",
      client: "client-1",
      admin: "ada@example.com",
      email: AWS.email,
    }),
    JSON.stringify({ ...AWS, kind: "another-proxy" }),
    JSON.stringify({ ...AWS, signer: "" }),
    JSON.stringify({ ...ACCESS, team: "https://example-team.cloudflareaccess.com" }),
    JSON.stringify({ ...ACCESS, email: { claim: "", prefix: "" } }),
  ]) {
    expect(proxyOf(unreadable)).toBeNull();
    // The deploy's OAuth apps beside it change nothing: nobody signs in with them.
    expect(signInOf({ proxy: unreadable, apps, origins })).toEqual({ mode: "proxy", proxy: null });
  }
  expect(providersOf(signInOf({ proxy: "yes", apps, origins }))).toEqual(["proxy"]);
  // Not set: the OAuth mode, with the deploy's apps.
  for (const none of ["", "  "]) expect(signInOf({ proxy: none, apps, origins })).toEqual({ mode: "oauth", apps, origins });
  expect(providersOf(signInOf({ proxy: "", apps, origins }))).toEqual(["github", "google"]);
});

const realFetch = globalThis.fetch;
let asked: string[] = [];
beforeEach(() => {
  asked = [];
  // Each proxy's public key, at its own address: AWS's as a PEM for the balancer's region, the Access team's as a JWKS.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (url == `${TEAM}/cdn-cgi/access/certs`)
      return Response.json({ keys: [{ ...(await crypto.subtle.exportKey("jwk", accessPair.publicKey)), kid: ACCESS_KID }] });
    if (url != `https://public-keys.auth.elb.us-west-2.amazonaws.com/${KID}`) return new Response("no", { status: 404 });
    const der = base64(await crypto.subtle.exportKey("spki", pair.publicKey));
    return new Response(`-----BEGIN PUBLIC KEY-----\n${der.replace(/(.{64})/g, "$1\n")}\n-----END PUBLIC KEY-----\n`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A server whose deploy says `proxy` (PROXY_SIGN_IN, as text; "": the OAuth mode), with nobody in its database. `admins`: the deploy's. */
function server(proxy: Proxy | string = AWS, admins: string[] = []) {
  const signIn = signInOf({
    proxy: typeof proxy == "string" ? proxy : JSON.stringify(proxy),
    apps: { github: { clientId: "Ov23liGoodApp00000001", secret: "a".repeat(40) }, google: { clientId: "", secret: "" } },
    origins: { github: null, google: null },
  });
  const sql = memory();
  const directory = new Directory(sql, { admins, providers: providersOf(signIn) });
  const platform = {
    secret: "session-secret",
    dev: () => false,
    own: { get: async () => undefined },
    directory,
    signIn: { ...signIn, devLogin: null, encryptionKey: null },
    deploy: { target: null, version: null, primary: null },
  } as unknown as Platform;
  /** The server's first admin, as its deploy adds one: a person who waits, by their email at the proxy's sign-in. */
  const firstAdmin = (email: string) =>
    sql.run("INSERT INTO people (provider, handle, subject, role, created) VALUES ('proxy', ?1, NULL, 'admin', 1)", email);
  return { platform, directory, firstAdmin };
}
const cookieOf = (r: Response) =>
  (r.headers.get("set-cookie") ?? "")
    .split(/,(?=\s*erga_)/)
    .map((c) => c.split(";")[0].trim())
    .join("; ");

/** /auth/proxy as the proxy passes it on (its `header`), then the username step: the last answer, and the cookies. */
async function signUp(platform: Platform, header: Record<string, string>, username: string) {
  const at = await respond(proxySignIn, new Request(`${ORIGIN}/auth/proxy?next=/docs`, { headers: header }), platform);
  if (at.headers.get("location") != "/auth/username") return { answer: at, cookie: cookieOf(at) };
  const made = await respond(
    usernameStep,
    new Request(`${ORIGIN}/auth/username`, {
      method: "POST",
      headers: { cookie: cookieOf(at), origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username }).toString(),
    }),
    platform
  );
  return { answer: made, cookie: cookieOf(made) };
}
const aws = async (claims: Record<string, unknown>) => ({ "x-amzn-oidc-data": await headerFor(claims) });

test("the proxy mode: sign-in goes straight to the proxy, a person added by their email as an admin is one at their first sign-in, OAuth's way is closed", async () => {
  const { platform, directory, firstAdmin } = server();
  const choose = await respond(chooseSignIn, new Request(`${ORIGIN}/auth/sign-in?next=/docs`), platform);
  expect([choose.status, choose.headers.get("location")]).toEqual([302, "/auth/proxy?next=%2Fdocs"]);
  // The deploy has a GitHub app too: no matter, its routes are not this server's way in.
  for (const closed of [
    await respond(startOAuth("github"), new Request(`${ORIGIN}/auth/github`), platform),
    await respond(finishOAuth("github"), new Request(`${ORIGIN}/auth/github/callback?code=1&state=2`), platform),
    await respond(startOAuth("google"), new Request(`${ORIGIN}/auth/google`), platform),
  ]) {
    expect([closed.status, closed.headers.get("location")]).toEqual([404, null]);
    expect(await closed.text()).toContain("<h1>Not this way</h1>");
  }
  // No header (a path that passed the balancer with no sign-in), or one that isn't the balancer's: nobody.
  expect((await respond(proxySignIn, new Request(`${ORIGIN}/auth/proxy`), platform)).status).toBe(400);
  const forged = await headerFor(ADA, {}, other.privateKey);
  expect(
    (await respond(proxySignIn, new Request(`${ORIGIN}/auth/proxy`, { headers: { "x-amzn-oidc-data": forged } }), platform)).status
  ).toBe(400);
  // Access's header is not this server's proxy's: nobody.
  expect(
    (
      await respond(
        proxySignIn,
        new Request(`${ORIGIN}/auth/proxy`, { headers: { "cf-access-jwt-assertion": await accessHeader() } }),
        platform
      )
    ).status
  ).toBe(400);

  // The first admin waits as their email (a people row, as the deploy adds one). Before them, nobody may come in: no
  // rule lets anyone in, and an address the sign-in doesn't call verified is not theirs.
  await firstAdmin("ada@example.com");
  const eve = await signUp(platform, await aws({ sub: "sub-eve", email: "ada@example.com", email_verified: "false" }), "eve");
  expect(eve.answer.status).toBe(403);
  expect(await directory.users.get("eve")).toBeNull();
  // The person the sign-in gives that verified email for: they choose a username, and are in, as an admin.
  const ada = await signUp(platform, await aws(ADA), "ada");
  expect([ada.answer.status, ada.answer.headers.get("location")]).toEqual([302, "/docs"]);
  expect(await directory.users.isAdmin("ada")).toBe(true);
  expect(await sessionOf(platform, new Request(`${ORIGIN}/docs`, { headers: { cookie: ada.cookie } }))).toMatchObject({ login: "ada" });
  expect((await directory.identities.of("ada"))[0]).toMatchObject({ provider: "proxy", subject: "sub-ada", handle: "ada@example.com" });
  // Their wait ended: the email makes no second admin.
  const admin = { login: "ada", admin: true };
  expect(await directory.people.list(admin)).toEqual([]);
  // The key came from AWS, for the balancer's region, one time.
  expect(asked).toEqual([`https://public-keys.auth.elb.us-west-2.amazonaws.com/${KID}`]);
  // The next time, the same subject is the same account, also with another email.
  const again = await signUp(platform, await aws({ ...ADA, email: "ada.l@example.com" }), "-");
  expect(again.answer.headers.get("location")).toBe("/docs");
  expect((await directory.identities.of("ada")).length).toBe(1);

  // Anyone else waits for a rule: none yet, so no account; with everybody's rule (the setup's company preset), an account that isn't an admin's.
  const bo = { sub: "sub-bo", email: "bo@example.com", email_verified: "true" };
  const refused = await signUp(platform, await aws(bo), "bo");
  expect(refused.answer.status).toBe(403);
  expect(await refused.answer.text()).toContain("<b>bo@example.com</b>");
  await directory.rules.change(admin, (await directory.rules.list(admin)).find((r) => r.kind == "everybody")!.id, "write");
  expect((await signUp(platform, await aws(bo), "bo")).answer.headers.get("location")).toBe("/docs");
  expect(await directory.users.isAdmin("bo")).toBe(false);
  // An admin adds a person here by their email at the proxy's sign-in only: no OAuth provider's account.
  await expect(directory.addUser(admin, { provider: "github", handle: "cy" }, "admin")).rejects.toThrow("isn't a provider here: proxy.");
  expect((await directory.addUser(admin, { provider: "proxy", handle: "Cy@Example.com" }, "admin")).person).toMatchObject({
    provider: "proxy",
    handle: "cy@example.com",
    role: "admin",
  });
  // The Authentication page's status is the proxy's, with no secret and no provider; what changes an OAuth app refuses.
  const status = await authOps(platform, ORIGIN).status(admin);
  expect(status).toMatchObject({ mode: "proxy", proxy: { kind: "aws-alb", label: "AWS load balancer", header: "x-amzn-oidc-data" } });
  await expect(authOps(platform, ORIGIN).setProvider(admin, "google", true)).rejects.toThrow("it has no OAuth providers");
});

test("behind Cloudflare Access: the team's key signs a person in, by the application's header", async () => {
  const { platform, directory, firstAdmin } = server(ACCESS);
  await firstAdmin("cy@example.com");
  const cy = await signUp(platform, { "cf-access-jwt-assertion": await accessHeader() }, "cy");
  expect([cy.answer.status, cy.answer.headers.get("location")]).toEqual([302, "/docs"]);
  expect(await directory.users.isAdmin("cy")).toBe(true);
  expect((await directory.identities.of("cy"))[0]).toMatchObject({ provider: "proxy", subject: "sub-cy", handle: "cy@example.com" });
  // The key came from the team's own address.
  expect(asked).toEqual([`${TEAM}/cdn-cgi/access/certs`]);
  // Another application's header, and a balancer's: nobody.
  for (const header of [{ "cf-access-jwt-assertion": await accessHeader({ aud: ["aud-of-another-application"] }) }, await aws(ADA)]) {
    const no = await respond(proxySignIn, new Request(`${ORIGIN}/auth/proxy`, { headers: header }), platform);
    expect([no.status, no.headers.get("set-cookie")]).toEqual([400, null]);
  }
});

test("a PROXY_SIGN_IN this server can't read: /auth/proxy says so, and nobody signs in, with a good header or by OAuth", async () => {
  const { platform, directory, firstAdmin } = server('{"signer":"x"}', ["root"]);
  expect(platform.signIn).toMatchObject({ mode: "proxy", proxy: null });
  await firstAdmin("ada@example.com");
  expect((await respond(chooseSignIn, new Request(`${ORIGIN}/auth/sign-in`), platform)).headers.get("location")).toBe(
    "/auth/proxy?next=%2F"
  );
  const headers: Record<string, string>[] = [await aws(ADA), { "cf-access-jwt-assertion": await accessHeader() }, {}];
  for (const header of headers) {
    const answer = await respond(proxySignIn, new Request(`${ORIGIN}/auth/proxy?next=/docs`, { headers: header }), platform);
    expect([answer.status, answer.headers.get("location"), answer.headers.get("set-cookie")]).toEqual([503, null, null]);
    expect(await answer.text()).toContain("<code>PROXY_SIGN_IN</code>");
  }
  expect((await respond(startOAuth("github"), new Request(`${ORIGIN}/auth/github`), platform)).status).toBe(404);
  // Nothing was asked of any proxy, and nobody has an account.
  expect(asked).toEqual([]);
  expect(await directory.identities.find("proxy", "sub-ada")).toBeNull();
  expect(await authOps(platform, ORIGIN).status({ login: "root", admin: true })).toEqual({
    mode: "proxy",
    proxy: { kind: null, label: "Not set up", header: null, values: [] },
  });
});

test("a sign-in that gives the email in another claim: the deploy says where, and none there makes no account", async () => {
  // As a Cognito pool that federates gives it: no email claim, the address in username after the provider's name.
  const claims = { sub: "0a1b2c3d-1111-2222-3333-444455556666", username: "SSO_Ada@Example.com" };
  const header = await aws(claims);
  // The deploy's answer is the standard claim: the page says what is wrong and which claims came, and nobody is in.
  const plain = server();
  const none = await respond(proxySignIn, new Request(`${ORIGIN}/auth/proxy`, { headers: header }), plain.platform);
  expect(none.status).toBe(400);
  expect(await none.text()).toContain("didn't give your email address in <code>email</code>. It gave: sub, username.");
  expect(none.headers.get("set-cookie")).toBeNull();

  // The deploy names the claim and the text before the address: the person is their email, and the first admin.
  const there: Proxy = { ...AWS, email: { claim: "username", prefix: "SSO_" } };
  const { platform, directory, firstAdmin } = server(there);
  await firstAdmin("ada@example.com");
  const at = await respond(proxySignIn, new Request(`${ORIGIN}/auth/proxy`, { headers: header }), platform);
  expect(at.headers.get("location")).toBe("/auth/username");
  const step = await (
    await respond(usernameStep, new Request(`${ORIGIN}/auth/username`, { headers: { cookie: cookieOf(at) } }), platform)
  ).text();
  expect(step).toContain("as <b>ada@example.com</b>");
  expect(step).toContain('name="username" value="ada"');
  expect((await signUp(platform, header, "ada")).answer.headers.get("location")).toBe("/docs");
  expect(await directory.users.isAdmin("ada")).toBe(true);
  // Text other than the prefix before the address, or no address after it: none.
  expect(vouchedOf({ sub: "s", username: "Other_ada@example.com" }, there)).toBeInstanceOf(NoEmail);
  expect(vouchedOf({ sub: "s", username: "SSO_ada" }, there)).toBeInstanceOf(NoEmail);
  expect(vouchedOf({ username: "SSO_ada@example.com" }, there)).toBeNull();
});

test("the OAuth mode (no PROXY_SIGN_IN): /auth/proxy is nothing and GitHub's way is open", async () => {
  const { platform } = server("");
  expect((await respond(proxySignIn, new Request(`${ORIGIN}/auth/proxy`, { headers: await aws(ADA) }), platform)).status).toBe(404);
  expect((await respond(chooseSignIn, new Request(`${ORIGIN}/auth/sign-in`), platform)).headers.get("location")).toBe(
    "/auth/github?next=%2F"
  );
});
