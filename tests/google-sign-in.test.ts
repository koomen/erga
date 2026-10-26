// Signing in with Google (server/identity/sign-in.ts), against the pretend Google (dev/google-mock.ts): the live check
// of a client, the switch that turns Google on (and its lockout rules), and a sign-in from start to session, by the sub.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mockGoogle, type MockGoogleUser } from "../dev/google-mock";
import { AuthApps, checkGoogleApp } from "../server/identity/apps";
import { authOps, providersOn } from "../server/identity/settings";
import { chooseSignIn, finishGoogleSignIn, startGoogleSignIn, startSignIn } from "../server/identity/sign-in";
import { Directory } from "../server/directory/index.ts";
import type { Platform } from "../server/platform";
import { memory } from "./memory-sql.ts";

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
    deploy: { target: null, version: null, hookSecret: "", originOf: () => "" },
  } as unknown as Platform;
  return { platform, own, directory };
}

const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(/,(?=\s*erga_)/).map((c) => c.split(";")[0].trim()).join("; ");

/** A whole sign-in: /auth/google, Google's page, the callback. The callback's answer. */
async function signInWithGoogle(platform: Platform, q = ""): Promise<Response> {
  const start = await startGoogleSignIn(platform, new Request(`${ORIGIN}/auth/google?next=/docs${q}`));
  expect(start.status).toBe(302);
  const atGoogle = await google.fetch(new Request(start.headers.get("location")!));
  expect(atGoogle.status).toBe(302);
  return finishGoogleSignIn(platform, new Request(atGoogle.headers.get("location")!, { headers: { cookie: cookieOf(start) } }));
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
  const off = await startGoogleSignIn(platform, new Request(`${ORIGIN}/auth/google?next=/docs`));
  expect(off.status).toBe(403);
  expect(await off.text()).toContain('href="/auth/sign-in?next=%2Fdocs"');
  expect((await chooseSignIn(platform, new Request(`${ORIGIN}/auth/sign-in?next=/docs`))).headers.get("location")).toBe("/auth/github?next=%2Fdocs");
  await authOps(platform, ORIGIN).setProvider({ login: "koomen", admin: true }, "google", true);
  const choose = await (await chooseSignIn(platform, new Request(`${ORIGIN}/auth/sign-in?next=/docs`))).text();
  expect(choose).toContain('href="/auth/github?next=%2Fdocs"');
  expect(choose).toContain('href="/auth/google?next=%2Fdocs"');
  expect(choose).toContain("Continue with GitHub");
  expect(choose).toContain("Continue with Google");
  expect(choose).not.toContain("same account");
  const start = new URL((await startGoogleSignIn(platform, new Request(`${ORIGIN}/auth/google?next=/docs`))).headers.get("location")!);
  expect(start.origin + start.pathname).toBe(`${GOOGLE}/o/oauth2/v2/auth`);
  expect(Object.fromEntries(start.searchParams)).toMatchObject({ client_id: APP.clientId, redirect_uri: `${ORIGIN}/auth/google/callback`, response_type: "code", scope: "openid email profile" });
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
  expect((await startGoogleSignIn(platform, new Request(`${ORIGIN}/auth/google`))).status).toBe(403);
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
  expect(new URL((await startSignIn(platform, new Request(`${ORIGIN}/auth/github`))).headers.get("location")!).origin).toBe(GITHUB);
});

test("an install signs in with Erga's Google client through erga.dev's callback, which trades the code and relays the token sealed", async () => {
  const INSTALL = "https://erga.install.test", OPS = "https://ops.erga.test";
  google = mockGoogle({ clientId: APP.clientId, clientSecret: APP.secret, redirects: [`${OPS}/auth/google/callback`], user: ADA });
  const { platform, directory } = server();
  (platform.signIn as { relay: string; googleApp: unknown }).relay = OPS;
  // The install has the client's id only (no secret): the relay has the rest.
  (platform.signIn as { googleApp: unknown }).googleApp = { clientId: APP.clientId, secret: "" };
  await platform.own.put("auth:providers", { github: true, google: true });
  await directory.identities.createAccount("ada", { provider: "google", subject: "1001", handle: "ada@example.com", name: "Ada", emails: [] }, writes("ada"));
  const start = await startGoogleSignIn(platform, new Request(`${INSTALL}/auth/google?next=/docs`));
  const to = new URL(start.headers.get("location")!);
  expect(to.searchParams.get("redirect_uri")).toBe(`${OPS}/auth/google/callback`);
  const atGoogle = await google.fetch(new Request(to));
  const { controlRoutes } = await import("../control/routes");
  const control = { platform: {}, deploys: { isInstall: async (o: string) => o == INSTALL }, forks: {}, google: { ...APP, origin: GOOGLE }, net: globalThis.fetch } as never;
  const relayed = await controlRoutes(new Request(atGoogle.headers.get("location")!), control);
  expect(relayed.status).toBe(302);
  const back = new URL(relayed.headers.get("location")!);
  expect(back.origin).toBe(INSTALL);
  expect(back.searchParams.get("code")).toBeNull();
  const done = await finishGoogleSignIn(platform, new Request(back, { headers: { cookie: cookieOf(start) } }));
  expect(done.status).toBe(302);
  expect(done.headers.get("location")).toBe("/docs");
  // A state that names a server that isn't an install relays nothing.
  const stranger = await controlRoutes(new Request(atGoogle.headers.get("location")!), { ...(control as object), deploys: { isInstall: async () => false } } as never);
  expect(stranger.status).toBe(400);
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
