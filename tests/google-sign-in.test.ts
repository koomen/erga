// Signing in with Google (server/identity/oauth.ts, providers.ts), against the pretend Google (dev/google-mock.ts): the live check
// of a client, the switch that turns Google on (and its lockout rules), a sign-in from start to session, by the sub, and
// the way back in: values set on the page that stop working give way to the deploy's.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mockGoogle, type MockGoogleUser } from "../dev/google-mock";
import { AuthApps } from "../server/identity/apps";
import type { OAuthSignIn } from "../server/identity/mode";
import { finishOAuth, startOAuth } from "../server/identity/oauth";
import { PROVIDERS } from "../server/identity/providers";
import { authOps, providersOn, signInApp } from "../server/identity/settings";
import { chooseSignIn } from "../server/identity/sign-in";
import { Directory } from "../server/directory/index.ts";
import type { Platform } from "../server/platform";
import { memory } from "./helpers/memory-sql.ts";
import { respond } from "../server/http.ts";

const startSignIn = startOAuth("github"),
  startGoogleSignIn = startOAuth("google"),
  finishGoogleSignIn = finishOAuth("google"),
  checkGoogleApp = PROVIDERS.google.check;
const GOOGLE = "https://google.test", GITHUB = "https://github.test";
const GITHUB_APP = { clientId: "Ov23liGoodApp00000001", secret: "a".repeat(40) };
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
  const directory = new Directory(memory(), { admins: ["koomen"], providers: ["github", "google"] });
  const platform = {
    secret: "session-secret", dev: () => false, own, directory,
    signIn: {
      mode: "oauth",
      apps: { github: GITHUB_APP, google: APP },
      origins: { github: GITHUB, google: GOOGLE },
      devLogin: null,
      encryptionKey: "factory-key",
    },
    deploy: { version: null, primary: null },
  } as unknown as Platform;
  return { platform, own, directory };
}

/** The deploy's apps of a server made here (the OAuth mode's). */
const appsOf = (platform: Platform) => (platform.signIn as OAuthSignIn).apps;

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

test("the sign-in page says what the person will open, or that they canceled; the same page whoever may join", async () => {
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
  // No empty paragraph before the address: it sits right under the heading.
  expect(doc).toContain('</h1><p class="asked">');
  // From anywhere else: Sign in to Erga, and no address.
  const list = main(await pageOf("next=%2Fdocs"));
  expect(list).toContain("<h1>Sign in to Erga</h1><p><style>");
  expect(list).not.toContain('class="asked"');
  // The same page where everybody may make an account: it says nothing of who may join.
  await directory.rules.change(koomen, (await directory.rules.list(koomen)).find((r) => r.kind == "everybody")!.id, "read");
  expect(main(await pageOf("next=%2Fdocs"))).toBe(list);
  // After Cancel on a provider's page: the same page, which says so, and keeps the way back.
  const canceled = main(await pageOf("next=%2Fkoomen%2Ftrip&canceled"));
  expect(canceled).toContain(
    '<h1>Sign in to Erga</h1><p class="said">You canceled the sign-in attempt. Try again or choose another way.</p>'
  );
  expect(canceled).toContain('href="/auth/google?next=%2Fkoomen%2Ftrip"');
  // With one way in too: the page shows it, and does not send them straight back to the provider.
  await authOps(platform, ORIGIN).setProvider(koomen, "google", false);
  expect((await respond(chooseSignIn, new Request(`${ORIGIN}/auth/sign-in?next=%2Fdocs`), platform)).headers.get("location")).toBe(
    "/auth/github?next=%2Fdocs"
  );
  const one = main(await pageOf("next=%2Fdocs&canceled"));
  expect(one).toContain("You canceled the sign-in attempt.");
  expect(one).toContain('href="/auth/github?next=%2Fdocs"');
  expect(one).not.toContain("/auth/google");
});

test("the switch's rules: on only with a working client; off only with the other on and the admin able to sign in with it", async () => {
  const { platform, directory } = server();
  const auth = authOps(platform, ORIGIN), koomen = { login: "koomen", admin: true };
  await expect(auth.setProvider({ login: "bo" }, "google", true)).rejects.toThrow("Only an admin");
  // Google can't go on without a working client.
  appsOf(platform).google = { clientId: "", secret: "" };
  await expect(auth.setProvider(koomen, "google", true)).rejects.toThrow("doesn't work on this server yet");
  appsOf(platform).google = APP;
  await auth.setProvider(koomen, "google", true);
  await expect(auth.setProvider(koomen, "google", false)).resolves.toEqual({ github: true, google: false });
  await auth.setProvider(koomen, "google", true);
  // Google can't go off while GitHub's app doesn't work: nobody could sign in.
  appsOf(platform).github = { clientId: "", secret: "" };
  await expect(auth.setProvider(koomen, "google", false)).rejects.toThrow("would stop sign-in");
  appsOf(platform).github = GITHUB_APP;
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
  // Nobody has this Google account yet, and no rule lets it in: the page says how she signed in and what to do, and
  // nothing of who may join (a rule's domain stays private).
  await directory.rules.add({ login: "koomen", admin: true }, { kind: "workspace", value: "secret-corp.example", access: "write" });
  const refused = await signInWithGoogle(platform);
  expect(refused.status).toBe(403);
  const said = await refused.text();
  expect(said).toContain("<h1>You need permission to join</h1>");
  expect(said).toContain(
    'You signed in with Google as <b>ada@example.com</b>. Ask an admin of this Erga server to add you, then sign in again. Or <a href="/auth/sign-in">sign in with another account</a>.'
  );
  expect(said).not.toContain("secret-corp");
  expect(said).not.toContain("Workspace");
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

test("Cancel on the provider's page goes back to Sign in; any other refusal is one page, with the reason in the log only", async () => {
  const { platform } = server();
  await authOps(platform, ORIGIN).setProvider({ login: "koomen", admin: true }, "google", true);
  /** The provider's answer to a sign-in that started here: the callback with `query`, and the start's state. */
  const back = async (query: string) => {
    const start = await respond(startGoogleSignIn, new Request(`${ORIGIN}/auth/google?next=/koomen/trip`), platform);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    return respond(
      finishGoogleSignIn,
      new Request(`${ORIGIN}/auth/google/callback?state=${state}&${query}`, { headers: { cookie: cookieOf(start) } }),
      platform
    );
  };
  const canceled = await back("error=access_denied");
  expect(canceled.status).toBe(302);
  expect(canceled.headers.get("location")).toBe("/auth/sign-in?next=%2Fkoomen%2Ftrip&canceled");
  // Refused for another reason, or a code the provider won't trade: the same page, and the provider's words stay in the log.
  const logged: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    for (const query of ["error=server_error&error_description=Their+own+words", "code=not-a-code"]) {
      const failed = await back(query);
      expect(failed.status).toBe(400);
      const html = await failed.text();
      expect(html).toContain("<h1>Sign-in didn't work</h1>");
      expect(html).toContain('<p><a href="/auth/sign-in">Try again</a>. If it keeps failing, tell your Erga admin.</p>');
      expect(html.slice(html.indexOf("<main"))).not.toMatch(/Google|Their own words|server_error|invalid_grant/);
    }
  } finally {
    console.log = log;
  }
  expect(logged.join("\n")).toContain("sign-in failed: Google: server_error: Their own words");
  expect(logged.length).toBe(2);
});

test("one way in: Erga names the account itself, from the address, when the one rule lets in her Workspace; else she chooses", async () => {
  const koomen = { login: "koomen", admin: true };
  const only = async (rules: (d: Directory) => Promise<unknown>) => {
    const s = server();
    await s.own.put("auth:providers", { github: false, google: true });
    await rules(s.directory);
    return s;
  };
  // Only Google, and one rule: her Workspace. ada@example.com is ada, at once, and she goes on to where she was going.
  google = mockGoogle({
    clientId: APP.clientId,
    clientSecret: APP.secret,
    redirects: [`${ORIGIN}/auth/google/callback`],
    user: { ...ADA, hd: "example.com" },
  });
  const one = await only((d) => d.rules.add(koomen, { kind: "workspace", value: "example.com", access: "write" }));
  const named = await signInWithGoogle(one.platform);
  expect(named.headers.get("location")).toBe("/docs");
  expect(named.headers.get("set-cookie")).toContain("erga_session=");
  expect((await one.directory.identities.find("google", "1001"))?.login).toBe("ada");
  // A name that is taken gets a number.
  google.state.user = { ...ADA, sub: "1002", email: "Ada@example.com", hd: "example.com" };
  expect((await signInWithGoogle(one.platform)).headers.get("location")).toBe("/docs");
  expect((await one.directory.identities.find("google", "1002"))?.login).toBe("ada2");
  // Open to two Workspaces: the part before the @ is not one person's, so she chooses.
  google.state.user = { ...ADA, hd: "example.com" };
  const two = await only(async (d) => {
    await d.rules.add(koomen, { kind: "workspace", value: "example.com", access: "write" });
    await d.rules.add(koomen, { kind: "workspace", value: "other.example", access: "write" });
  });
  expect((await signInWithGoogle(two.platform)).headers.get("location")).toBe("/auth/username");
  // Both providers on: she chooses.
  const both = await only((d) => d.rules.add(koomen, { kind: "workspace", value: "example.com", access: "write" }));
  await both.own.put("auth:providers", { github: true, google: true });
  expect((await signInWithGoogle(both.platform)).headers.get("location")).toBe("/auth/username");
  expect(await both.directory.identities.find("google", "1001")).toBeNull();
});

test("new values for the client wait for an admin's test sign-in with them, as GitHub's do", async () => {
  const { platform, own, directory } = server();
  await authOps(platform, ORIGIN).setProvider({ login: "koomen", admin: true }, "google", true);
  await directory.users.signedIn("koomen");
  await directory.identities.link("koomen", { provider: "google", subject: "1001", handle: "k@example.com", name: null, emails: [] });
  const apps = new AuthApps(own, "factory-key");
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
  const apps = new AuthApps(own, "factory-key");
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
  const apps = new AuthApps(own, "factory-key");
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
  await new AuthApps(own, "factory-key").keep("google", "active", gone, { login: "koomen" });
  expect(await signInApp(platform, "active", "google")).toEqual(APP);
  // With no deploy values that work, the page's stand: nothing else to fall back to.
  const noDeploy = {
    ...platform,
    signIn: { ...platform.signIn, apps: { ...appsOf(platform), google: { clientId: APP.clientId, secret: "GOCSPX-wrong-wrong-wrong" } } },
  } as Platform;
  expect((await signInApp(noDeploy, "active", "google"))?.clientId).toBe(gone.clientId);
});
