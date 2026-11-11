// The company's own sign-in in front of the server (server/identity/front.ts): the load balancer's signed header is the
// sign-in. A pretend AWS signs the header here, with a key it serves at AWS's address.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { base64 } from "../shared/bytes";
import { Directory } from "../server/directory/index.ts";
import { usernameStep } from "../server/identity/accounts";
import { type FrontSignIn, frontOf, frontSignIn, readFront, unlessFront } from "../server/identity/front";
import { sessionOf } from "../server/identity/session";
import { chooseSignIn, startSignIn } from "../server/identity/sign-in";
import type { Platform } from "../server/platform";
import { respond } from "../server/http.ts";
import { memory } from "./helpers/memory-sql.ts";

const ORIGIN = "https://erga.example";
const FRONT: FrontSignIn = {
  signer: "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/erga/50dc6c495c0c9188",
  issuer: "https://idp.example.com/pool",
  client: "client-1",
  admin: "ada@example.com",
};
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
    signer: FRONT.signer,
    iss: FRONT.issuer,
    client: FRONT.client,
    exp: Math.floor(Date.now() / 1000) + 120,
    ...head,
  });
  const p = part(claims);
  const s = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${base64(s).replace(/\+/g, "-").replace(/\//g, "_")}`;
}

const ADA = { sub: "sub-ada", email: "Ada@Example.com", email_verified: "true" };
const key = async () => pair.publicKey;

test("the header counts only from this balancer: its signature, its signer, its issuer and client, its time", async () => {
  expect(await readFront(await headerFor(ADA), FRONT, { key })).toEqual({
    provider: "front",
    subject: "sub-ada",
    handle: "ada@example.com",
    name: null,
    emails: [{ email: "ada@example.com", verified: true }],
  });
  // Another balancer's header has AWS's signature too: its signer is not ours.
  expect(await readFront(await headerFor(ADA, { signer: FRONT.signer.replace("erga", "theirs") }), FRONT, { key })).toBeNull();
  expect(await readFront(await headerFor(ADA, { iss: "https://idp.example.com/other" }), FRONT, { key })).toBeNull();
  expect(await readFront(await headerFor(ADA, { client: "client-2" }), FRONT, { key })).toBeNull();
  expect(await readFront(await headerFor(ADA, { exp: Math.floor(Date.now() / 1000) - 1 }), FRONT, { key })).toBeNull();
  expect(await readFront(await headerFor(ADA, { alg: "none" }), FRONT, { key })).toBeNull();
  // Signed with another key, or changed after it was signed, or no header.
  expect(await readFront(await headerFor(ADA, {}, other.privateKey), FRONT, { key })).toBeNull();
  const [h, , s] = (await headerFor(ADA)).split(".");
  expect(await readFront(`${h}.${part({ ...ADA, sub: "sub-eve" })}.${s}`, FRONT, { key })).toBeNull();
  expect(await readFront("", FRONT, { key })).toBeNull();
  // An email the sign-in doesn't call verified is kept as such.
  expect((await readFront(await headerFor({ sub: "s", email: "bo@example.com" }), FRONT, { key }))?.emails).toEqual([
    { email: "bo@example.com", verified: false },
  ]);
  expect(frontOf(JSON.stringify(FRONT))).toEqual(FRONT);
  expect(frontOf("")).toBeNull();
  expect(frontOf('{"signer":"x"}')).toBeNull();
});

const realFetch = globalThis.fetch;
let asked: string[] = [];
beforeEach(() => {
  asked = [];
  // AWS's public key, as a PEM at the address of the balancer's region.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (url != `https://public-keys.auth.elb.us-west-2.amazonaws.com/${KID}`) return new Response("no", { status: 404 });
    const der = base64(await crypto.subtle.exportKey("spki", pair.publicKey));
    return new Response(`-----BEGIN PUBLIC KEY-----\n${der.replace(/(.{64})/g, "$1\n")}\n-----END PUBLIC KEY-----\n`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function server(front: FrontSignIn | null = FRONT) {
  const directory = new Directory(memory(), {});
  const platform = {
    secret: "session-secret",
    dev: () => false,
    own: { get: async () => undefined },
    directory,
    signIn: { app: { clientId: "", secret: "" }, github: "https://github.test", front, devLogin: null, encryptionKey: null },
    deploy: { target: null, version: null, primary: null },
  } as unknown as Platform;
  return { platform, directory };
}
const cookieOf = (r: Response) =>
  (r.headers.get("set-cookie") ?? "")
    .split(/,(?=\s*erga_)/)
    .map((c) => c.split(";")[0].trim())
    .join("; ");

/** /auth/front as the balancer passes it on, then the username step: the last answer, and the cookies. */
async function signUp(platform: Platform, claims: Record<string, unknown>, username: string) {
  const at = await respond(
    frontSignIn,
    new Request(`${ORIGIN}/auth/front?next=/docs`, { headers: { "x-amzn-oidc-data": await headerFor(claims) } }),
    platform
  );
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

test("with a sign-in in front: sign-in goes straight to it, the admin's email makes the first admin, GitHub's way is closed", async () => {
  const { platform, directory } = server();
  const choose = await respond(chooseSignIn, new Request(`${ORIGIN}/auth/sign-in?next=/docs`), platform);
  expect([choose.status, choose.headers.get("location")]).toEqual([302, "/auth/front?next=%2Fdocs"]);
  expect((await respond(unlessFront(startSignIn), new Request(`${ORIGIN}/auth/github`), platform)).status).toBe(404);
  // No header (a path that passed the balancer with no sign-in), or one that isn't the balancer's: nobody.
  expect((await respond(frontSignIn, new Request(`${ORIGIN}/auth/front`), platform)).status).toBe(400);
  const forged = await headerFor(ADA, {}, other.privateKey);
  expect(
    (await respond(frontSignIn, new Request(`${ORIGIN}/auth/front`, { headers: { "x-amzn-oidc-data": forged } }), platform)).status
  ).toBe(400);

  // The first admin: the person the sign-in gives the deploy's admin email for. They choose a username, and are in.
  const ada = await signUp(platform, ADA, "ada");
  expect([ada.answer.status, ada.answer.headers.get("location")]).toEqual([302, "/docs"]);
  expect(await directory.users.isAdmin("ada")).toBe(true);
  expect(await sessionOf(platform, new Request(`${ORIGIN}/docs`, { headers: { cookie: ada.cookie } }))).toMatchObject({ login: "ada" });
  expect((await directory.identities.of("ada"))[0]).toMatchObject({ provider: "front", subject: "sub-ada", handle: "ada@example.com" });
  // The key came from AWS, for the balancer's region, one time.
  expect(asked).toEqual([`https://public-keys.auth.elb.us-west-2.amazonaws.com/${KID}`]);
  // The next time, the same subject is the same account, also with another email.
  const again = await signUp(platform, { ...ADA, email: "ada.l@example.com" }, "-");
  expect(again.answer.headers.get("location")).toBe("/docs");
  expect((await directory.identities.of("ada")).length).toBe(1);

  // Anyone else waits for a rule: none yet, so no account; with everybody's rule (the setup's company preset), an account that isn't an admin's.
  const bo = { sub: "sub-bo", email: "bo@example.com", email_verified: "true" };
  const refused = await signUp(platform, bo, "bo");
  expect(refused.answer.status).toBe(403);
  expect(await refused.answer.text()).toContain("<b>bo@example.com</b>");
  const admin = { login: "ada", admin: true };
  await directory.rules.change(admin, (await directory.rules.list(admin)).find((r) => r.kind == "everybody")!.id, "write");
  expect((await signUp(platform, bo, "bo")).answer.headers.get("location")).toBe("/docs");
  expect(await directory.users.isAdmin("bo")).toBe(false);
  // The admin's email, not verified by the sign-in, makes no admin.
  await signUp(platform, { sub: "sub-eve", email: "ada@example.com", email_verified: "false" }, "eve");
  expect(await directory.users.isAdmin("eve")).toBe(false);
});

test("without a sign-in in front, /auth/front is nothing and GitHub's way is open", async () => {
  const { platform } = server(null);
  expect(
    (await respond(frontSignIn, new Request(`${ORIGIN}/auth/front`, { headers: { "x-amzn-oidc-data": await headerFor(ADA) } }), platform))
      .status
  ).toBe(404);
  expect((await respond(chooseSignIn, new Request(`${ORIGIN}/auth/sign-in`), platform)).headers.get("location")).toBe(
    "/auth/github?next=%2F"
  );
});
