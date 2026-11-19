// How people sign in: the live check of a GitHub OAuth app, the
// values kept from /admin/auth (encrypted, never answered), the lockout rules
// (check first, wait for a test sign-in while the app in use works, no clear
// that stops sign-in), the status the page shows, and sign-in using them,
// with GitHub and the Durable Object
// stood in for. The routes are tested in the Worker
//.

import { expect, test } from "bun:test";
import {
  type AppContext,
  AuthApps,
  AuthError,
  cachedCheck,
  checkValues,
  clearApp,
  discardApp,
  inUse,
  saveApp,
  statusOf,
} from "../server/identity/apps";
import type { SignInChange } from "../server/directory/index.ts";
import { gated } from "../server/identity/mount";
import { startSignIn as start } from "../server/identity/sign-in";
import { type AppCheck, type AppValues, PROVIDERS } from "../server/identity/providers";
import { testedSignIn } from "../server/identity/settings";
import { testEnded, type PendingTest } from "../server/identity/app-test";
import type { Platform } from "../server/platform";
import type { Directory } from "../server/directory/index.ts";
import { server as app } from "./helpers/app";
import { quietConsole } from "./helpers/quiet.ts";
import { respond } from "../server/http.ts";

quietConsole();

const startSignIn = start("github");
const checkGithubApp = PROVIDERS.github.check;

const GOOD = { clientId: "Ov23liGoodApp00000001", secret: "a".repeat(40) };
const OTHER = { clientId: "Ov23liOtherApp0000002", secret: "b".repeat(40) };

/** GitHub's token endpoint, as it answers a code that can't be real: by the client ID and secret. */
function fakeGithub(apps: AppValues[], seen: string[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(String(url));
    const b = JSON.parse(String(init?.body ?? "{}")) as { client_id: string; client_secret: string; code: string };
    const app = apps.find((a) => a.clientId == b.client_id);
    if (!app) return Response.json({ error: "Not Found" }, { status: 404 });
    if (app.secret != b.client_secret) return Response.json({ error: "incorrect_client_credentials", error_description: "The client_id and/or client_secret passed are incorrect." });
    return Response.json({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
  }) as typeof fetch;
}

test("the live check tells a working app from a wrong client ID, a wrong or missing secret, none, and GitHub not answering", async () => {
  const seen: string[] = [];
  const f = fakeGithub([GOOD], seen);
  expect((await checkGithubApp(GOOD, { fetch: f, origin: "https://gh.test" })).state).toBe("working");
  expect(seen[0]).toBe("https://gh.test/login/oauth/access_token");
  const wrongId = await checkGithubApp(OTHER, { fetch: f });
  expect(wrongId.state).toBe("misconfigured");
  expect(wrongId.reasons.join()).toContain(OTHER.clientId);
  const wrongSecret = await checkGithubApp({ ...GOOD, secret: "c".repeat(40) }, { fetch: f });
  expect([wrongSecret.state, wrongSecret.summary]).toEqual(["misconfigured", "The client secret is wrong."]);
  expect((await checkGithubApp({ ...GOOD, secret: "" }, { fetch: f })).summary).toBe("The app has no client secret here.");
  expect((await checkGithubApp({ clientId: "", secret: "" }, { fetch: f })).state).toBe("not_set_up");
  expect((await checkGithubApp(GOOD, { fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch })).state).toBe("unknown");
  expect((await checkGithubApp(GOOD, { fetch: (async () => new Response("", { status: 502 })) as unknown as typeof fetch })).state).toBe("unknown");
  expect((await checkGithubApp(GOOD, { fetch: (() => new Promise(() => {})) as unknown as typeof fetch, timeoutMs: 20 })).summary).toContain("in time");
});

test("pasted values are tidied and checked: a client ID and a secret, one line each", () => {
  expect(checkValues({ clientId: ` ${GOOD.clientId} `, secret: `${GOOD.secret}\n` }, "github")).toEqual(GOOD);
  for (const bad of [{ clientId: "", secret: GOOD.secret }, { clientId: "has spaces in it", secret: GOOD.secret }, { clientId: GOOD.clientId, secret: "" }, { clientId: GOOD.clientId, secret: "short" }]) {
    expect(() => checkValues(bad, "github")).toThrow(AuthError);
  }
});

const store = () => {
  const m = new Map<string, unknown>();
  return { m, storage: { get: async (k: string) => structuredClone(m.get(k)), put: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); }, delete: async (k: string) => { m.delete(k); } } };
};

test("kept values: the secret encrypted, never in what an admin reads, and only for this app with this server's key", async () => {
  const { m, storage } = store();
  const apps = new AuthApps(storage, "factory-key");
  await apps.keep("github", "active", GOOD, { login: "Koomen", via: "their admin agent" });
  expect(await apps.values("github", "active")).toEqual(GOOD);
  const read = await apps.read("github");
  expect(read.active).toMatchObject({ clientId: GOOD.clientId, updatedBy: "koomen", updatedVia: "their admin agent" });
  expect(JSON.stringify(read)).not.toContain(GOOD.secret);
  expect(JSON.stringify([...m.values()])).not.toContain(GOOD.secret);
  // Another server's key opens nothing (each server has its own FACTORY_KEY).
  expect(await new AuthApps(storage, "another-key").values("github", "active")).toBeNull();
  // No FACTORY_KEY: nothing can be kept.
  const none = new AuthApps(store().storage, null);
  expect(none.canStore).toBe(false);
  await expect(none.keep("github", "active", GOOD, { login: "koomen" })).rejects.toThrow(AuthError);
});

/** A server: its kept values, the deploy's, GitHub's apps and the change log. */
function server(deploy: AppValues, github: AppValues[]) {
  const { m, storage } = store();
  const log: { by: string; change: SignInChange }[] = [];
  const c: AppContext = {
    apps: new AuthApps(storage, "factory-key"),
    provider: "github",
    deploy,
    check: (v) => checkGithubApp(v, { fetch: fakeGithub(github) }),
    log: async (by, change) => { log.push({ by: by.login, change }); },
  };
  return { c, m, log };
}

test("save: values GitHub refuses change nothing", async () => {
  const { c, m, log } = server({ clientId: "", secret: "" }, [GOOD]);
  await expect(saveApp(c, { clientId: GOOD.clientId, secret: "d".repeat(40) }, { login: "koomen" })).rejects.toThrow(
    "The client secret is wrong."
  );
  await expect(saveApp(c, OTHER, { login: "koomen" })).rejects.toThrow("Nothing changed.");
  expect(m.size).toBe(0);
  expect(log).toEqual([]);
});

test("save with no working app (staging today): used at once, as there's nothing to lose", async () => {
  const { c, log } = server({ clientId: "", secret: "" }, [GOOD]);
  const r = await saveApp(c, GOOD, { login: "koomen" });
  expect(r.kept).toBe("active");
  expect(await inUse(c)).toEqual({ ...GOOD, source: "page" });
  expect(log).toEqual([{ by: "koomen", change: { provider: "github", event: "set", clientId: GOOD.clientId } }]);
  expect(JSON.stringify(log)).not.toContain(GOOD.secret);
});

test("save while the app in use works: the new values wait for a test sign-in, and sign-in keeps the old ones", async () => {
  const { c, log } = server(GOOD, [GOOD, OTHER]);
  const r = await saveApp(c, OTHER, { login: "koomen" });
  expect(r.kept).toBe("pending");
  expect(r.message).toContain("Test sign-in");
  expect(await inUse(c)).toEqual({ ...GOOD, source: "deploy" });
  expect(await c.apps.values("github", "pending")).toEqual(OTHER);
  // A test sign-in that failed is noted beside them; one that worked puts them in use.
  await c.apps.noteTest("github", OTHER.clientId, { at: 1, ok: false, error: "redirect_uri mismatch" });
  expect((await c.apps.read("github")).pending?.test?.error).toBe("redirect_uri mismatch");
  expect(await c.apps.promote("github", "Ov23liSomethingElse0")).toBe(false);
  expect(await c.apps.promote("github", OTHER.clientId)).toBe(true);
  expect(await inUse(c)).toEqual({ ...OTHER, source: "page" });
  expect((await c.apps.read("github")).pending).toBeNull();
  expect(log.map((l) => l.change.event)).toEqual(["pending"]);
});

test("discard drops only the values that wait; clear goes back to the deploy's, but not into a lockout unless forced", async () => {
  const { c, log } = server({ clientId: GOOD.clientId, secret: "wrong-secret-0000000000" }, [GOOD, OTHER]);
  await saveApp(c, GOOD, { login: "koomen" });
  expect((await inUse(c)).source).toBe("page");
  await c.apps.keep("github", "pending", OTHER, { login: "koomen" });
  expect(await discardApp(c, { login: "koomen" })).toEqual({ discarded: true });
  expect(await discardApp(c, { login: "koomen" })).toEqual({ discarded: false });
  expect((await inUse(c)).clientId).toBe(GOOD.clientId);
  // The deploy's secret is wrong: clearing would stop everyone signing in.
  await expect(clearApp(c, { login: "koomen" })).rejects.toThrow("Clearing would stop sign-in for everyone");
  expect((await inUse(c)).source).toBe("page");
  expect((await clearApp(c, { login: "koomen" }, true)).cleared).toBe(true);
  expect((await inUse(c)).source).toBe("deploy");
  expect((await clearApp(c, { login: "koomen" })).cleared).toBe(false);
  expect(log.map((l) => l.change.event)).toEqual(["set", "discarded", "cleared"]);
});

test("the status: what's in use and where from, never a secret, the URLs GitHub needs, and the steps where there's no app", async () => {
  const { c } = server({ clientId: "", secret: "" }, [GOOD]);
  const none = await statusOf(c, {
    origin: "https://staging.erga.dev",
    dev: false,
    pagePlace: "on this server's page",
  });
  expect(none.check.state).toBe("not_set_up");
  expect(none.callbackUrl).toBe("https://staging.erga.dev/_edge/callback");
  expect(none.homepageUrl).toBe("https://staging.erga.dev");
  const steps = none.setup!.join("\n");
  for (const s of [
    "https://github.com/settings/applications/new",
    "https://staging.erga.dev/_edge/callback",
    "on this server's page",
    "GITHUB_CLIENT_ID as a text binding",
  ])
    expect(steps).toContain(s);
  await saveApp(c, GOOD, { login: "koomen" });
  const set = await statusOf(c, { origin: "https://staging.erga.dev", dev: false, pagePlace: "here" });
  expect(set.check.state).toBe("working");
  expect(set.inUse).toEqual({ clientId: GOOD.clientId, secretSet: true, secretLast4: GOOD.secret.slice(-4), source: "page" });
  expect(set.setup).toBeNull();
  expect(JSON.stringify(set)).not.toContain(GOOD.secret);
});

test("checks are remembered for a minute by the values, but not when GitHub couldn't answer", async () => {
  let asked = 0;
  const answers: AppCheck["state"][] = ["unknown", "working"];
  const check = cachedCheck(async () => ({ state: answers[Math.min(asked++, 1)], summary: "", reasons: [], at: 0 }));
  expect((await check(GOOD)).state).toBe("unknown");
  expect((await check(GOOD)).state).toBe("working");
  expect((await check(GOOD)).state).toBe("working");
  expect(asked).toBe(2);
  await check(OTHER);
  expect(asked).toBe(3);
});

/** A production server's platform, its own storage in a Map. */
function serverOn(own: Platform["own"]): Platform {
  return {
    secret: "s", dev: () => false,
    signIn: {
      mode: "oauth",
      apps: { github: GOOD, google: { clientId: "", secret: "" } },
      origins: { github: null, google: null },
      devLogin: null,
      encryptionKey: "factory-key",
    },
    deploy: { version: null, domains: [], app: null },
    pagesDomain: () => "pages.example",
    own,
    directory: { config: { record: async () => {} } } as unknown as Directory,
  } as unknown as Platform;
}

test("sign-in uses the page's values over the deploy's, and ?app=pending tests the values that wait", async () => {
  const { storage } = store();
  const env = serverOn(storage);
  const apps = new AuthApps(storage, "factory-key");
  /** Where /auth/github goes, behind the gate: Erga's checks, then the gate's sign-in, which goes off to GitHub. */
  const visit = (on: Platform, at: string) => gated(on, new Request(`https://erga.dev${at}`), (r) => respond(startSignIn, r, on));
  const goOn = async (on: Platform, q = "") => {
    const first = await visit(on, `/auth/github${q}`);
    const next = first.headers.get("location") ?? "";
    return new URL((next.startsWith("/_edge/sign-in") ? (await visit(on, next)).headers.get("location") : null) ?? "about:blank");
  };
  const go = (q = "") => goOn(env, q);
  expect((await go()).searchParams.get("client_id")).toBe(GOOD.clientId);
  // Nothing waits: a test sign-in says so.
  expect((await respond(startSignIn, new Request("https://erga.dev/auth/github?app=pending"), env)).status).toBe(404);
  await apps.keep("github", "pending", OTHER, { login: "koomen" });
  expect((await go()).searchParams.get("client_id")).toBe(GOOD.clientId);
  const test = await go("?app=pending&next=/admin/auth");
  expect(test.searchParams.get("client_id")).toBe(OTHER.clientId);
  expect(test.searchParams.get("redirect_uri")).toBe("https://erga.dev/_edge/callback");
  // The gate's sign-in itself, asked for the values that wait when none do: nothing.
  expect((await visit(serverOn(store().storage), "/_edge/sign-in?idp=github&x=pending")).status).toBe(404);
  // A test that worked for someone who isn't an admin changes nothing, and says why; an admin's puts them in use.
  expect(await testedSignIn(env, OTHER.clientId, { kind: "in", login: "bo", admin: false }, "github")).toBe(false);
  expect((await apps.read("github")).pending?.test?.error).toContain("only an admin's sign-in");
  // The end of a test of other values (they changed meanwhile) notes nothing.
  expect(await testedSignIn(env, GOOD.clientId, { kind: "in", login: "koomen", admin: true }, "github")).toBe(false);
  expect((await apps.read("github")).pending?.clientId).toBe(OTHER.clientId);
  expect(await testedSignIn(env, OTHER.clientId, { kind: "in", login: "koomen", admin: true }, "github")).toBe(true);
  expect((await go()).searchParams.get("client_id")).toBe(OTHER.clientId);
  // A server whose own storage can't be read signs in with the deploy's values.
  const broken = serverOn({
    get: async () => {
      throw new Error("down");
    },
    put: async () => {},
    delete: async () => {},
  });
  expect((await goOn(broken)).searchParams.get("client_id")).toBe(GOOD.clientId);
});

test("a test sign-in's end: an admin's puts the values in use; every other end notes why; a test of other values notes nothing", () => {
  const waiting: PendingTest = { state: "waiting", clientId: OTHER.clientId };
  const end = (e: Parameters<typeof testEnded>[1]["end"], clientId = OTHER.clientId) => testEnded(waiting, { clientId, end: e, at: 7 });
  expect(end({ kind: "in", login: "koomen", admin: true })).toEqual({
    next: { state: "none" },
    effect: { do: "promote", login: "koomen" },
  });
  const notes = [
    end({ kind: "in", login: "bo", admin: false }),
    end({ kind: "new", handle: "cy@example.com" }),
    end({ kind: "refused", who: "dee" }),
    end({ kind: "provider", error: "GitHub refused the sign-in: bad." }),
  ].map((r) => (r.effect.do == "note" && r.next.state == "waiting" && r.next.test == r.effect.result ? r.effect.result : null));
  expect(notes.map((r) => [r?.by, r?.error])).toEqual([
    ["bo", "bo signed in, but only an admin's sign-in puts new values in use."],
    ["cy@example.com", "cy@example.com has no account here: only an admin's sign-in puts new values in use."],
    ["dee", "dee may not sign in here: only an admin's sign-in puts new values in use."],
    [undefined, "GitHub refused the sign-in: bad."],
  ]);
  expect(end({ kind: "in", login: "koomen", admin: true }, GOOD.clientId)).toEqual({ next: waiting, effect: { do: "stale" } });
  expect(testEnded({ state: "none" }, { clientId: OTHER.clientId, end: { kind: "new", handle: "x" }, at: 7 }).effect).toEqual({
    do: "stale",
  });
});

test("sign-in's next= stays on the site, however the address is dressed up", async () => {
  const s = app();
  for (const next of ["//elsewhere.example", "/\\elsewhere.example", "/\t/elsewhere.example", "https://elsewhere.example"]) {
    const res = await s.fetch(`/auth/github?as=someone&next=${encodeURIComponent(next)}`);
    expect(res.headers.get("location"), JSON.stringify(next)).toBe("/");
  }
  // (An address of the site's own is where sign-in goes: the answers above are no accident of the route.)
  expect((await s.fetch(`/auth/github?as=someone&next=${encodeURIComponent("/documents?x=1")}`)).headers.get("location")).toBe(
    "/documents?x=1"
  );
});

test("a GitHub sign-in from start to the gate's cookie, against the pretend GitHub: PKCE, the gate's callback, and the account by GitHub's id", async () => {
  const { mockGithub } = await import("../dev/github-mock");
  const { Directory } = await import("../server/directory/index.ts");
  const { memory } = await import("./helpers/memory-sql.ts");
  const GH = "https://gh.test/__github";
  const ORIGIN = "https://erga.example";
  const gh = mockGithub({
    app: { slug: "erga", clientId: GOOD.clientId, clientSecret: GOOD.secret },
    origin: "https://gh.test",
    callback: `${ORIGIN}/_edge/callback`,
    user: "ada",
  });
  const directory = new Directory(memory(), { admins: ["koomen"], providers: ["github", "google"] });
  const koomen = { login: "koomen", admin: true };
  await directory.rules.change(koomen, (await directory.rules.list(koomen)).find((r) => r.kind == "everybody")!.id, "write");
  const env = {
    ...serverOn(store().storage),
    directory,
    secret: "s".repeat(40),
    signIn: {
      mode: "oauth",
      apps: { github: GOOD, google: { clientId: "", secret: "" } },
      origins: { github: GH, google: null },
      devLogin: null,
      encryptionKey: "factory-key",
    },
  } as unknown as Platform;
  const real = globalThis.fetch;
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!request.url.startsWith("https://gh.test/")) return real(input, init);
    if (request.url.endsWith("/login/oauth/access_token")) sent.push(JSON.parse(String(init?.body)));
    return (await gh.fetch(request)) ?? new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    const visit = (at: string, cookie = "") =>
      gated(env, new Request(at.startsWith("/") ? ORIGIN + at : at, { headers: cookie ? { cookie } : {} }), (r) =>
        respond(startSignIn, r, env)
      );
    const first = await visit("/auth/github?next=/documents");
    const start = await visit(first.headers.get("location")!);
    const atGithub = new URL(start.headers.get("location")!);
    expect(atGithub.origin + atGithub.pathname).toBe(`${GH}/login/oauth/authorize`);
    expect(Object.fromEntries(atGithub.searchParams)).toMatchObject({
      client_id: GOOD.clientId,
      redirect_uri: `${ORIGIN}/_edge/callback`,
      scope: "read:user",
      allow_signup: "false",
      code_challenge_method: "S256",
    });
    // GitHub's page: Authorize goes back to the gate's callback, with the code and the state.
    const back = /id="authorize" href="([^"]+)"/.exec(await (await gh.fetch(new Request(atGithub)))!.text())![1].replace(/&amp;/g, "&");
    const cookie = start.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const done = await visit(back, cookie);
    expect([done.status, done.headers.get("location")]).toEqual([302, "/documents"]);
    expect(done.headers.getSetCookie().join("\n")).toContain("__Host-erga=s.");
    // The sign-in lasts the admins' setting (sign_in_days): 30 days until one sets it, and the member cookie with it.
    const lives = (r: Response) =>
      r.headers
        .getSetCookie()
        .filter((c) => /^(__Host-erga|__Host-member|member)=[^;]/.test(c))
        .map((c) => Number(/Max-Age=(\d+)/.exec(c)![1]));
    expect(lives(done)).toEqual([30 * 86400, 30 * 86400]);
    // A change is for the sign-ins after it.
    await directory.config.set(koomen, "sign_in_days", 7);
    const again = await visit((await visit("/auth/github?next=/documents")).headers.get("location")!);
    const next = /id="authorize" href="([^"]+)"/
      .exec(await (await gh.fetch(new Request(again.headers.get("location")!)))!.text())![1]
      .replace(/&amp;/g, "&");
    const state = again.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(lives(await visit(next, state))).toEqual([7 * 86400, 7 * 86400]);
    // The code went to GitHub with the sign-in's PKCE verifier, whose challenge GitHub had.
    expect(sent[0]).toMatchObject({ client_id: GOOD.clientId, redirect_uri: `${ORIGIN}/_edge/callback` });
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(sent[0].code_verifier)))).toString(
      "base64url"
    );
    expect(challenge).toBe(atGithub.searchParams.get("code_challenge")!);
    // One way in, and GitHub's logins are one person's each: the account has her login, by GitHub's id for her.
    expect((await directory.identities.find("github", "101"))?.login).toBe("ada");
  } finally {
    globalThis.fetch = real;
  }
});
