// How people sign in: the live check of a GitHub OAuth app, the
// values kept from /admin/auth (encrypted, never answered), the lockout rules
// (check first, wait for a test sign-in while the app in use works, no clear
// that stops sign-in), the status the page shows, and sign-in using them,
// with GitHub and the Durable Object
// stood in for. The routes and staging's guard are tested in the Worker
//.

import { expect, test } from "bun:test";
import { type AppCheck, type AppContext, type AppValues, AuthApps, AuthError, cachedCheck, checkGithubApp, checkValues, clearApp, discardApp, inUse, saveApp, type SignInChange, statusOf } from "../server/identity/apps";
import { startSignIn } from "../server/identity/sign-in";
import { testedSignIn } from "../server/identity/settings";
import type { Platform } from "../server/platform";
import type { Directory } from "../server/directory/index.ts";
import { quietConsole } from "./quiet.ts";

quietConsole();

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
  expect(checkValues({ clientId: ` ${GOOD.clientId} `, secret: `${GOOD.secret}\n` })).toEqual(GOOD);
  for (const bad of [{ clientId: "", secret: GOOD.secret }, { clientId: "has spaces in it", secret: GOOD.secret }, { clientId: GOOD.clientId, secret: "" }, { clientId: GOOD.clientId, secret: "short" }]) {
    expect(() => checkValues(bad)).toThrow(AuthError);
  }
});

const store = () => {
  const m = new Map<string, unknown>();
  return { m, storage: { get: async (k: string) => structuredClone(m.get(k)), put: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); }, delete: async (k: string) => { m.delete(k); } } };
};

test("kept values: the secret encrypted, never in what an admin reads, and only for this app on this server", async () => {
  const { m, storage } = store();
  const apps = new AuthApps(storage, "factory-key", "staging");
  await apps.keep("github", "active", GOOD, { login: "Koomen", via: "their admin agent" });
  expect(await apps.values("github", "active")).toEqual(GOOD);
  const read = await apps.read("github");
  expect(read.active).toMatchObject({ clientId: GOOD.clientId, updatedBy: "koomen", updatedVia: "their admin agent" });
  expect(JSON.stringify(read)).not.toContain(GOOD.secret);
  expect(JSON.stringify([...m.values()])).not.toContain(GOOD.secret);
  // Another server's key, or the same key on another target (production's values copied to staging), opens nothing.
  expect(await new AuthApps(storage, "another-key", "staging").values("github", "active")).toBeNull();
  expect(await new AuthApps(storage, "factory-key", "production").values("github", "active")).toBeNull();
  // No FACTORY_KEY: nothing can be kept.
  const none = new AuthApps(store().storage, null, "staging");
  expect(none.canStore).toBe(false);
  await expect(none.keep("github", "active", GOOD, { login: "koomen" })).rejects.toThrow(AuthError);
});

/** A server: its kept values, the deploy's, GitHub's apps and the change log. */
function server(deploy: AppValues, github: AppValues[]) {
  const { m, storage } = store();
  const log: { by: string; change: SignInChange }[] = [];
  const c: AppContext = {
    apps: new AuthApps(storage, "factory-key", "staging"),
    provider: "github",
    deploy,
    check: (v) => checkGithubApp(v, { fetch: fakeGithub(github) }),
    log: async (by, change) => { log.push({ by: by.login, change }); },
  };
  return { c, m, log };
}

test("save: values GitHub refuses change nothing", async () => {
  const { c, m, log } = server({ clientId: "", secret: "" }, [GOOD]);
  await expect(saveApp(c, "staging", { clientId: GOOD.clientId, secret: "d".repeat(40) }, { login: "koomen" })).rejects.toThrow("The client secret is wrong.");
  await expect(saveApp(c, "staging", OTHER, { login: "koomen" })).rejects.toThrow("Nothing changed.");
  expect(m.size).toBe(0);
  expect(log).toEqual([]);
});

test("save with no working app (staging today): used at once, as there's nothing to lose", async () => {
  const { c, log } = server({ clientId: "", secret: "" }, [GOOD]);
  const r = await saveApp(c, "staging", GOOD, { login: "koomen" });
  expect(r.kept).toBe("active");
  expect(await inUse(c)).toEqual({ ...GOOD, source: "page" });
  expect(log).toEqual([{ by: "koomen", change: { provider: "github", target: "staging", event: "set", clientId: GOOD.clientId } }]);
  expect(JSON.stringify(log)).not.toContain(GOOD.secret);
});

test("save while the app in use works: the new values wait for a test sign-in, and sign-in keeps the old ones", async () => {
  const { c, log } = server(GOOD, [GOOD, OTHER]);
  const r = await saveApp(c, "production", OTHER, { login: "koomen" });
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
  await saveApp(c, "production", GOOD, { login: "koomen" });
  expect((await inUse(c)).source).toBe("page");
  await c.apps.keep("github", "pending", OTHER, { login: "koomen" });
  expect(await discardApp(c, "production", { login: "koomen" })).toEqual({ discarded: true });
  expect(await discardApp(c, "production", { login: "koomen" })).toEqual({ discarded: false });
  expect((await inUse(c)).clientId).toBe(GOOD.clientId);
  // The deploy's secret is wrong: clearing would stop everyone signing in.
  await expect(clearApp(c, "production", { login: "koomen" })).rejects.toThrow("Clearing would stop sign-in for everyone");
  expect((await inUse(c)).source).toBe("page");
  expect((await clearApp(c, "production", { login: "koomen" }, true)).cleared).toBe(true);
  expect((await inUse(c)).source).toBe("deploy");
  expect((await clearApp(c, "production", { login: "koomen" })).cleared).toBe(false);
  expect(log.map((l) => l.change.event)).toEqual(["set", "discarded", "cleared"]);
});

test("the status: what's in use and where from, never a secret, the URLs GitHub needs, and the steps where there's no app", async () => {
  const { c } = server({ clientId: "", secret: "" }, [GOOD]);
  const none = await statusOf(c, {
    origin: "https://staging.erga.dev",
    target: "staging",
    dev: false,
    worker: "erga-staging",
    pagePlace: "on this server's page",
  });
  expect(none.check.state).toBe("not_set_up");
  expect(none.callbackUrl).toBe("https://staging.erga.dev/auth/github/callback");
  expect(none.homepageUrl).toBe("https://staging.erga.dev");
  const steps = none.setup!.join("\n");
  for (const s of [
    "https://github.com/settings/applications/new",
    "https://staging.erga.dev/auth/github/callback",
    "on this server's page",
    "targets.staging.vars.GITHUB_CLIENT_ID",
    "--name erga-staging",
  ])
    expect(steps).toContain(s);
  await saveApp(c, "staging", GOOD, { login: "koomen" });
  const set = await statusOf(c, { origin: "https://staging.erga.dev", target: "staging", dev: false, pagePlace: "here" });
  expect(set.check.state).toBe("working");
  expect(set.inUse).toEqual({ clientId: GOOD.clientId, secretSet: true, source: "page" });
  expect(set.setup).toBeNull();
  expect(JSON.stringify(set)).not.toContain(GOOD.secret);
});

test("checks are remembered for a minute by the values, but not when GitHub couldn't answer", async () => {
  let asked = 0;
  const answers: AppCheck["state"][] = ["unknown", "working"];
  const check = cachedCheck(async () => ({ state: answers[Math.min(asked++, 1)], summary: "", reasons: [], at: 0 }));
  expect((await check(GOOD)).state).toBe("unknown");
  await Bun.sleep(1);
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
    signIn: { app: GOOD, github: "https://github.com", devLogin: null, encryptionKey: "factory-key" },
    deploy: { target: "production", version: null, hookSecret: "", originOf: (t) => `https://${t}.example` },
    own,
    directory: { config: { record: async () => {} } } as unknown as Directory,
  } as Platform;
}

test("sign-in uses the page's values over the deploy's, and ?app=pending tests the values that wait", async () => {
  const { storage } = store();
  const env = serverOn(storage);
  const apps = new AuthApps(storage, "factory-key", "production");
  const go = async (q = "") => new URL((await startSignIn(env, new Request(`https://erga.dev/auth/github${q}`))).headers.get("location") ?? "about:blank");
  expect((await go()).searchParams.get("client_id")).toBe(GOOD.clientId);
  // Nothing waits: a test sign-in says so.
  expect((await startSignIn(env, new Request("https://erga.dev/auth/github?app=pending"))).status).toBe(404);
  await apps.keep("github", "pending", OTHER, { login: "koomen" });
  expect((await go()).searchParams.get("client_id")).toBe(GOOD.clientId);
  const test = await go("?app=pending&next=/admin/auth");
  expect(test.searchParams.get("client_id")).toBe(OTHER.clientId);
  expect(test.searchParams.get("state")).toStartWith("p.");
  expect(test.searchParams.get("redirect_uri")).toBe("https://erga.dev/auth/github/callback");
  // A test that worked for someone who isn't an admin changes nothing, and says why; an admin's puts them in use.
  expect(await testedSignIn(env, OTHER.clientId, { ok: true, login: "bo", admin: false })).toBe(false);
  expect((await apps.read("github")).pending?.test?.error).toContain("only an admin's sign-in");
  expect(await testedSignIn(env, OTHER.clientId, { ok: true, login: "koomen", admin: true })).toBe(true);
  expect((await go()).searchParams.get("client_id")).toBe(OTHER.clientId);
  // A server whose own storage can't be read signs in with the deploy's values.
  const broken = serverOn({ get: async () => { throw new Error("down"); }, put: async () => {}, delete: async () => {} });
  expect(new URL((await startSignIn(broken, new Request("https://erga.dev/auth/github"))).headers.get("location")!).searchParams.get("client_id")).toBe(GOOD.clientId);
});
