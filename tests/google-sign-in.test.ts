// Signing in with Google (server/identity/sign-in.ts), against the pretend Google (dev/google-mock.ts): the live check
// of a client, the switch that turns Google on (and its lockout rules), a sign-in from start to session, by the sub, and
// the way back in: values set on the page that stop working give way to the deploy's.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mockGoogle, type MockGoogleUser } from "../dev/google-mock";
import { AuthApps, checkGoogleApp } from "../server/identity/apps";
import { authOps, providersOn, signInApp } from "../server/identity/settings";
import { chooseSignIn, finishGoogleSignIn, startGoogleSignIn, startSignIn } from "../server/identity/sign-in";
import { Directory } from "../server/directory/index.ts";
import type { Platform } from "../server/platform";
import { memory } from "./helpers/memory-sql.ts";
import { respond } from "../server/http.ts";

const GOOGLE = "https://google.test", GITHUB = "https://github.test";
const APP = { clientId: "123456789012-abcdefghijklmnop.apps.googleusercontent.com", secret: "GOCSPX-abcdefghijklmnopqrstuv" };
const ORIGIN = "https://erga.example";
const ADA: MockGoogleUser = { sub: "1001", email: "ada@example.com", email_verified: true, name: "Ada Lovelace" };

let google: ReturnType<typeof mockGoogle>;
const realFetch = globalThis.fetch;
beforeEach(() => {
  google = mockGoogle({ clientId: APP.clientId, clientSecret: APP.secret, redirects: [`${ORIGIN}/auth/google/callback`], user: ADA });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    // GitHub's token endpoint, as it answers the live check of a working app.
    if (request.url.startsWith(GITHUB)) return Response.json({ error: "bad_verification_code" });
    return request.url.startsWith(GOOGLE) ? google.fetch(request) : realFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

/** A server with Google's client from the deploy, its own storage in a Map, its users in memory (koomen an admin). */
function server() {
  const m = new Map<string, unknown>();
  const own = { get: async (k: string) => structuredClone(m.get(k)), put: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); }, delete: async (k: string) => { m.delete(k); } };
  const directory = new Directory(memory(), { admins: ["koomen"] });
  const platform = {
    secret: "session-secret", dev: () => false, own, directory,
    signIn: { app: { clientId: "Ov23liGoodApp00000001", secret: "a".repeat(40) }, github: GITHUB, googleApp: APP, google: GOOGLE, relay: null, devLogin: null, encryptionKey: "factory-key" },
    deploy: { target: null, version: null, primary: null },
  } as unknown as Platform;
  return { platform, own, directory };
}

const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(/,(?=\s*erga_)/).map((c) => c.split(";")[0].trim()).join("; ");

/** A whole sign-in: /auth/google, Google's page, the callback. The callback's answer. */
async function signInWithGoogle(platform: Platform, q = ""): Promise<Response> {
  const start = await respond(startGoogleSignIn, new Request(`${ORIGIN}/auth/google?next=/docs${q}`), platform);
  expect(start.status).toBe(302);
  const atGoogle = await google.fetch(new Request(start.headers.get("location")!));
  expect(atGoogle.status).toBe(302);
  return respond(finishGoogleSignIn, new Request(atGoogle.headers.get("location")!, { headers: { cookie: cookieOf(start) } }), platform);
}

/** A rule for one account, with write, made with it (as an admin's rule, or local development's, would be). */
/** An account that may write: its own role. */
const writes = (_login: string) => ({ role: "write" as const });

test("the live check tells a working client from an unknown client ID, a wrong secret and none", async () => {
  const f = google.fetch as unknown as typeof fetch;
  expect((await checkGoogleApp(APP, { fetch: f, origin: GOOGLE })).state).toBe("working");
  expect((await checkGoogleApp({ ...APP, clientId: "999-x.apps.googleusercontent.com" }, { fetch: f, origin: GOOGLE })).summary).toBe("Google has no OAuth client with this client ID.");
  expect((await checkGoogleApp({ ...APP, secret: "GOCSPX-wrong-wrong-wrong" }, { fetch: f, origin: GOOGLE })).summary).toBe("The client secret is wrong.");
  expect((await checkGoogleApp({ clientId: "", secret: "" }, { fetch: f, origin: GOOGLE })).state).toBe("not_set_up");
});

test("Google is off until an admin turns it on: its sign-in says so in place and offers Sign in; the choice page offers both once on", async () => {
  const { platform } = server();
  expect(await providersOn(platform)).toEqual({ github: true, google: false });
  const off = await respond(startGoogleSignIn, new Request(`${ORIGIN}/auth/google?next=/docs`), platform);
  expect(off.status).toBe(403);
  expect(await off.text()).toContain('href="/auth/sign-in?next=%2Fdocs"');
  expect((await respond(chooseSignIn, new Request(`${ORIGIN}/auth/sign-in?next=/docs`), platform)).headers.get("location")).toBe(
    "/auth/github?next=%2Fdocs"
  );
  await authOps(platform, ORIGIN).setProvider({ login: "koomen", admin: true }, "google", true);
  const choose = await (await respond(chooseSignIn, new Request(`${ORIGIN}/auth/sign-in?next=/docs`), platform)).text();
  expect(choose).toContain('href="/auth/github?next=%2Fdocs"');
  expect(choose).toContain('href="/auth/google?next=%2Fdocs"');
  expect(choose).toContain("Continue with GitHub");
  expect(choose).toContain("Continue with Google");
  expect(choose).not.toContain("same account");
  const start = new URL(
    (await respond(startGoogleSignIn, new Request(`${ORIGIN}/auth/google?next=/docs`), platform)).headers.get("location")!
  );
  expect(start.origin + start.pathname).toBe(`${GOOGLE}/o/oauth2/v2/auth`);
  expect(Object.fromEntries(start.searchParams)).toMatchObject({ client_id: APP.clientId, redirect_uri: `${ORIGIN}/auth/google/callback`, response_type: "code", scope: "openid email profile" });
});

test("the sign-in page says what the person will open: the address asked for, and how a new person starts", async () => {
  const { platform, directory } = server(),
    koomen = { login: "koomen", admin: true };
  await authOps(platform, ORIGIN).setProvider(koomen, "google", true);
  const pageOf = async (query: string) => (await respond(chooseSignIn, new Request(`${ORIGIN}/auth/sign-in?${query}`), platform)).text();
  const main = (html: string) => html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  // From a document's address: the heading and the address, without its query; the buttons keep the whole way back.
  const doc = main(await pageOf(`next=${encodeURIComponent("/koomen/trip/day-2?edit")}&open=document`));
  expect(doc).toContain("<h1>Sign in to open this document</h1>");
  expect(doc).toContain('<p class="asked">erga.example/koomen/trip/day-2</p>');
  expect(doc).toContain(`href="/auth/github?next=${encodeURIComponent("/koomen/trip/day-2?edit")}"`);
  // An address is text, never markup.
  expect(main(await pageOf(`next=${encodeURIComponent("/a/<b>x")}&open=document`))).toContain(
    '<p class="asked">erga.example/a/&lt;b&gt;x</p>'
  );
  // From anywhere else: Sign in, and no address.
  const list = main(await pageOf("next=%2Fdocs"));
  expect(list).toContain("<h1>Sign in</h1>");
  expect(list).not.toContain('class="asked"');
  // Only where everybody may make an account does the page say that the buttons make one.
  const NEW = "New here? The same buttons make your account.";
  expect(doc).not.toContain(NEW);
  expect(list).not.toContain(NEW);
  await directory.rules.change(koomen, (await directory.rules.list(koomen)).find((r) => r.kind == "everybody")!.id, "read");
  expect(main(await pageOf("next=%2Fdocs"))).toContain(NEW);
  expect(main(await pageOf("next=%2Fkoomen%2Ftrip&open=document"))).toContain(NEW);
});

test("the switch's rules: on only with a working client; off only with the other on and the admin able to sign in with it", async () => {
  const { platform, directory } = server();
  const auth = authOps(platform, ORIGIN), koomen = { login: "koomen", admin: true };
  await expect(auth.setProvider({ login: "bo" }, "google", true)).rejects.toThrow("Only an admin");
  // Google can't go on without a working client.
  (platform.signIn as { googleApp: unknown }).googleApp = { clientId: "", secret: "" };
  await expect(auth.setProvider(koomen, "google", true)).rejects.toThrow("doesn't work on this server yet");
  (platform.signIn as { googleApp: unknown }).googleApp = APP;
  await auth.setProvider(koomen, "google", true);
  await expect(auth.setProvider(koomen, "google", false)).resolves.toEqual({ github: true, google: false });
  await auth.setProvider(koomen, "google", true);
  // Google can't go off while GitHub's app doesn't work: nobody could sign in.
  (platform.signIn as { app: unknown }).app = { clientId: "", secret: "" };
  await expect(auth.setProvider(koomen, "google", false)).rejects.toThrow("would stop sign-in");
  (platform.signIn as { app: unknown }).app = { clientId: "Ov23liGoodApp00000001", secret: "a".repeat(40) };
  // koomen's account signs in with GitHub (no identity yet: by his login): turning GitHub off would lock him out.
  await expect(auth.setProvider(koomen, "github", false)).rejects.toThrow("would lock you out");
  // An admin whose account signs in with Google may.
  await directory.users.signedIn("koomen");
  await directory.identities.link("koomen", { provider: "google", subject: "k-1", handle: "koomen@example.com", name: null, emails: [] });
  await expect(auth.setProvider(koomen, "github", false)).resolves.toEqual({ github: false, google: true });
  await expect(auth.setProvider(koomen, "google", false)).rejects.toThrow("the only one on");
});

test("a sign-in from start to session, by the sub; someone unknown is refused; Google off lets only an admin through", async () => {
  const { platform, directory } = server();
  await authOps(platform, ORIGIN).setProvider({ login: "koomen", admin: true }, "google", true);
  // Nobody has this Google account yet, and this server is invite-only.
  const refused = await signInWithGoogle(platform);
  expect(refused.status).toBe(403);
  expect(await refused.text()).toContain("Not on this server");
  await directory.identities.createAccount("ada", { provider: "google", subject: "1001", handle: "ada@example.com", name: "Ada", emails: [] }, writes("ada"));
  const ok = await signInWithGoogle(platform);
  expect(ok.status).toBe(302);
  expect(ok.headers.get("location")).toBe("/docs");
  expect(ok.headers.get("set-cookie")).toContain("erga_session=");
  // Her email changes at Google: the sub still signs her in.
  google.state.user = { ...ADA, email: "ada@new.example.com" };
  expect((await signInWithGoogle(platform)).status).toBe(302);
  expect((await directory.identities.find("google", "1001"))?.handle).toBe("ada@new.example.com");
  // Google turned off: only an admin's test sign-in goes through (?app=test).
  await authOps(platform, ORIGIN).setProvider({ login: "koomen", admin: true }, "google", false);
  expect((await respond(startGoogleSignIn, new Request(`${ORIGIN}/auth/google`), platform)).status).toBe(403);
  const test = await signInWithGoogle(platform, "&app=test");
  expect(test.status).toBe(403);
  expect(await test.text()).toContain("sign-in is off");
});

test("new values for the client wait for an admin's test sign-in with them, as GitHub's do", async () => {
  const { platform, own, directory } = server();
  await authOps(platform, ORIGIN).setProvider({ login: "koomen", admin: true }, "google", true);
  await directory.users.signedIn("koomen");
  await directory.identities.link("koomen", { provider: "google", subject: "1001", handle: "k@example.com", name: null, emails: [] });
  const apps = new AuthApps(own, "factory-key", "");
  const NEW = { clientId: "123456789012-newnewnewnewnew.apps.googleusercontent.com", secret: "GOCSPX-newnewnewnewnewnew" };
  await apps.keep("google", "pending", NEW, { login: "koomen" });
  google = mockGoogle({ clientId: NEW.clientId, clientSecret: NEW.secret, redirects: [`${ORIGIN}/auth/google/callback`], user: ADA });
  const tested = await signInWithGoogle(platform, "&app=pending");
  expect(tested.status).toBe(302);
  expect(await apps.values("google", "active")).toEqual(NEW);
  // GitHub's sign-in is unchanged by Google's switch.
  expect(new URL((await respond(startSignIn, new Request(`${ORIGIN}/auth/github`), platform)).headers.get("location")!).origin).toBe(
    GITHUB
  );
});

test("a test sign-in by someone refused, or with no account yet, notes why beside the values that wait", async () => {
  const { platform, own, directory } = server();
  await authOps(platform, ORIGIN).setProvider({ login: "koomen", admin: true }, "google", true);
  const apps = new AuthApps(own, "factory-key", "");
  const NEW = { clientId: "123456789012-newnewnewnewnew.apps.googleusercontent.com", secret: "GOCSPX-newnewnewnewnewnew" };
  await apps.keep("google", "pending", NEW, { login: "koomen" });
  google = mockGoogle({ clientId: NEW.clientId, clientSecret: NEW.secret, redirects: [`${ORIGIN}/auth/google/callback`], user: ADA });
  // Ada may not sign in here (invite-only): the test has a result all the same.
  expect((await signInWithGoogle(platform, "&app=pending")).status).toBe(403);
  expect((await apps.read("google")).pending?.test).toMatchObject({
    ok: false,
    by: "ada@example.com",
    error: expect.stringContaining("may not sign in here"),
  });
  // An admin added her: she has no account yet, and goes on to choose a username; the test notes that.
  await directory.addUser({ login: "koomen", admin: true }, { provider: "google", handle: "ada@example.com" }, "write");
  expect((await signInWithGoogle(platform, "&app=pending")).headers.get("location")).toBe("/auth/username");
  expect((await apps.read("google")).pending?.test?.error).toContain("has no account here");
  expect(await apps.values("google", "active")).toBeNull();
});

test("values that change during a test sign-in: its end tests nothing, and the new values have no result", async () => {
  const { platform, own, directory } = server();
  await authOps(platform, ORIGIN).setProvider({ login: "koomen", admin: true }, "google", true);
  await directory.users.signedIn("koomen");
  await directory.identities.link("koomen", { provider: "google", subject: "1001", handle: "k@example.com", name: null, emails: [] });
  const apps = new AuthApps(own, "factory-key", "");
  const NEW = { clientId: "123456789012-newnewnewnewnew.apps.googleusercontent.com", secret: "GOCSPX-newnewnewnewnewnew" };
  const NEWER = { clientId: "123456789012-newernewernewer.apps.googleusercontent.com", secret: "GOCSPX-newernewernewernew" };
  await apps.keep("google", "pending", NEW, { login: "koomen" });
  google = mockGoogle({ clientId: NEW.clientId, clientSecret: NEW.secret, redirects: [`${ORIGIN}/auth/google/callback`], user: ADA });
  const start = await respond(startGoogleSignIn, new Request(`${ORIGIN}/auth/google?next=/docs&app=pending`), platform);
  const atGoogle = await google.fetch(new Request(start.headers.get("location")!));
  // Another admin saves other values while this test is at Google.
  await apps.keep("google", "pending", NEWER, { login: "koomen" });
  const back = await respond(
    finishGoogleSignIn,
    new Request(atGoogle.headers.get("location")!, { headers: { cookie: cookieOf(start) } }),
    platform
  );
  expect(back.status).toBe(409);
  expect(await back.text()).toContain("changed during this test sign-in");
  expect((await apps.read("google")).pending).toMatchObject({ clientId: NEWER.clientId });
  expect((await apps.read("google")).pending?.test).toBeUndefined();
});

test("a Google account's picture is Google's, kept at each sign-in; with none, no picture (never GitHub's)", async () => {
  const { platform, directory } = server();
  await authOps(platform, ORIGIN).setProvider({ login: "koomen", admin: true }, "google", true);
  await directory.identities.createAccount(
    "ada",
    { provider: "google", subject: "1001", handle: "ada@example.com", name: "Ada", emails: [] },
    writes("ada")
  );
  // No picture: none, so her initial shows.
  expect((await signInWithGoogle(platform)).status).toBe(302);
  expect((await directory.users.get("ada"))?.avatar).toBeNull();
  expect(await directory.users.avatars(["ada"])).toEqual({});
  google.state.user = { ...ADA, picture: "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c" };
  expect((await signInWithGoogle(platform)).status).toBe(302);
  expect((await directory.users.get("ada"))?.avatar).toBe("https://lh3.googleusercontent.com/a/ACg8ocK=s64-c");
  expect(await directory.users.avatars(["ada", "*", "nobody"])).toEqual({ ada: "https://lh3.googleusercontent.com/a/ACg8ocK=s64-c" });
  // A picture that isn't Google's is never kept.
  google.state.user = { ...ADA, picture: "https://evil.example/a.png" };
  expect((await signInWithGoogle(platform)).status).toBe(302);
  expect((await directory.users.get("ada"))?.avatar).toBeNull();
});

test("values set on the page that the provider refuses give way to the deploy's, while those work: an admin can still sign in", async () => {
  const { platform, own } = server();
  // Values kept as the page keeps them, for a client Google doesn't know (deleted since, say).
  const gone = { clientId: "999999999999-deletedclient0000.apps.googleusercontent.com", secret: "GOCSPX-deleted-deleted-del" };
  await new AuthApps(own, "factory-key", "").keep("google", "active", gone, { login: "koomen" });
  expect(await signInApp(platform, "active", "google")).toEqual(APP);
  // With no deploy values that work, the page's stand: nothing else to fall back to.
  const noDeploy = {
    ...platform,
    signIn: { ...platform.signIn, googleApp: { clientId: APP.clientId, secret: "GOCSPX-wrong-wrong-wrong" } },
  } as Platform;
  expect((await signInApp(noDeploy, "active", "google"))?.clientId).toBe(gone.clientId);
});
