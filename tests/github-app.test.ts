// Erga's GitHub App (control/source/github.ts) against the pretend GitHub (dev/github-mock.ts), on a port: the App's
// JWT and installation tokens, the webhook's signature, the relay's sealing; and the control Worker's routes
// (control/routes.ts): Connect GitHub from the popup to the repository linked (one repository, a pick, a new one),
// the consent relayed for an install, the sign-in relayed, and the webhook (a good signature taken, a bad one refused).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { controlRoutes, type Control } from "../control/routes";
import { sealKeyFrom } from "../control/deploys/credential";
import { mockGithub, type MockGithub } from "../dev/github-mock";
import { finishSignIn, startSignIn } from "../server/identity/sign-in";
import type { Platform } from "../server/platform";
import type { Session } from "../server/platform";
import {
  api,
  appJwt,
  GithubError,
  installationToken,
  signWebhook,
  verifyRelay,
  verifyWebhook,
  type GithubApp,
  type GithubLink,
  type PushEvent,
} from "../control/source/github";
import type { GithubStatus } from "../control/source/index.ts";
import { openRelay, relayNonce, relayOrigin, relayState, sealRelay } from "../shared/relay";
import { TEST_APP, testPrivateKey } from "./helpers/source-fixture";
import { Directory } from "../server/directory/index.ts";
import { memory } from "./helpers/memory-sql.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const OPS = "https://ops.erga.test", INSTALL = "https://ops.install.test";
let gh: MockGithub, server: ReturnType<typeof Bun.serve>, www: string, app: GithubApp, key: string;

beforeAll(async () => {
  key = await testPrivateKey();
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (r) => (await gh.fetch(r)) ?? new Response("not here", { status: 404 }) });
  www = `http://127.0.0.1:${server.port}`;
  // The pretend GitHub on this port: its clone URLs name it.
  gh = mockGithub({ app: { ...TEST_APP, privateKey: key, administration: true }, origin: www, base: "", callback: `${OPS}/auth/github/callback`, user: "ada", orgs: ["acme"], repos: ["ada/erga"] });
  app = { appId: "1", ...TEST_APP, privateKey: key, www, api: `${www}/api` };
});
afterAll(() => server.stop(true));

const session = { login: "ada", name: "Ada" } as unknown as Session;
const users = { isAdmin: async () => true, actsAsAdmin: async () => true, allowed: async () => true, signedIn: async () => true, setGithubId: async () => {}, get: async () => null };
/** A control Worker to run the routes on: an admin signed in, a repository whose GitHub calls are recorded. */
function control(o: { github?: GithubApp | null; relay?: string; forks?: Control["forks"]; isInstall?: (origin: string) => boolean; signedIn?: boolean; /** The webhook's push isn't the connected repository's (the repository says so with null). */ ownRepo?: boolean } = {}) {
  const linked: GithubLink[] = [], pushed: PushEvent[] = [], background: Promise<unknown>[] = [];
  const status = (link: GithubLink | null): GithubStatus => ({ connected: !!link, link, state: "idle", lastSyncAt: null, lastSyncBy: null, error: null });
  const platform = {
    secret: "control-secret", sessionOf: async () => (o.signedIn === false ? null : session), directory: { users },
    source: { object: { connectGithub: async (_origin: string, link: GithubLink) => { linked.push(link); return status(link); }, githubPushed: async (_origin: string, ev: PushEvent) => { pushed.push(ev); return o.ownRepo === false ? null : status(null); } }, remote: async () => null },
  } as unknown as Platform;
  const c: Control = {
    platform, app: "https://erga.test", version: "v1", layout: (x) => new Response(x.body, { headers: { "Content-Type": "text/html" } }),
    deploys: { isInstall: async (origin: string) => o.isInstall?.(origin) ?? false } as never,
    oauth: { clientId: "erga-client", accountId: "0".repeat(32), worker: "erga-control", net: fetch, ...(o.relay ? { relay: o.relay } : {}) },
    github: o.github === undefined ? app : o.github, sealKey: sealKeyFrom("control-secret"), background: (w) => background.push(w), net: fetch,
    ...(o.forks ? { forks: o.forks } : {}),
  };
  const go = (origin: string, path: string, init: RequestInit & { cookie?: string } = {}) => controlRoutes(new Request(`${origin}${path}`, { ...init, headers: { accept: "text/html", origin, ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string> ?? {}) } }), c);
  return { c, go, linked, pushed, background, settle: async () => { while (background.length) await Promise.allSettled(background.splice(0)); } };
}
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(",").map((x) => x.split(";")[0].trim()).filter((x) => x && !x.endsWith("=")).join("; ");
/** GitHub's install page, as the person submits it: the installation made, the browser sent back to the callback. */
async function installOnGithub(state: string, o: { account?: string; selection?: "all" | "selected"; repos?: number[] } = {}) {
  const form = new URLSearchParams({ state, account: o.account ?? "ada", selection: o.selection ?? "selected" });
  for (const id of o.repos ?? gh.state.repos.filter((r) => r.owner == (o.account ?? "ada")).map((r) => r.id)) form.append("repo", String(id));
  const r = await gh.fetch(new Request(`${www}/apps/erga-editor/installations/new`, { method: "POST", body: form }));
  expect(r!.status).toBe(302);
  return new URL(r!.headers.get("location")!);
}

describe("the App itself", () => {
  test("its JWT: signed with the key, checked by GitHub; a tampered one is refused", async () => {
    const jwt = await appJwt("1", key);
    expect((await api(app, jwt, "GET", "/app")) as { slug: string }).toMatchObject({ slug: "erga-editor" });
    const [h, b, s] = jwt.split(".");
    const tampered = `${h}.${b}.${s.slice(0, -2)}${s.endsWith("AA") ? "BB" : "AA"}`;
    await expect(api(app, tampered, "GET", "/app")).rejects.toThrow(GithubError);
    expect(gh.state.badJwts).toBeGreaterThan(0);
    await expect(appJwt("1", "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----")).rejects.toThrow(/PKCS#8/);
  });

  test("installation tokens: an hour's, for an installation that exists; none for one that's gone", async () => {
    const id = 777;
    gh.state.installations.push({ id, account: { login: "ada", type: "User" }, selection: "selected", repoIds: [] });
    const t = await installationToken(app, id);
    expect(t.token).toStartWith("ghs_mock_777_");
    expect(t.expiresAt - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(gh.gitTokenOk(t.token)).toBe(true);
    await expect(installationToken(app, 778)).rejects.toThrow(/no longer installed/);
    expect(gh.gitTokenOk("ghs_mock_778_1")).toBe(false);
  });

  test("the webhook's signature is the secret's over the body; anything else is refused", async () => {
    const body = JSON.stringify({ ref: "refs/heads/staging" });
    const sig = await signWebhook("s3cret", body);
    expect(sig).toStartWith("sha256=");
    expect(await verifyWebhook("s3cret", body, sig)).toBe(true);
    expect(await verifyWebhook("s3cret", body + " ", sig)).toBe(false);
    expect(await verifyWebhook("other", body, sig)).toBe(false);
    expect(await verifyWebhook("s3cret", body, null)).toBe(false);
    expect(await verifyWebhook("s3cret", body, "sha256=00")).toBe(false);
    expect(await verifyWebhook("", body, sig)).toBe(false);
    // The relay's: the fork secret's hash as the key.
    expect(await verifyRelay("abc", body, await signWebhook("erga-relay:abc", body))).toBe(true);
    expect(await verifyRelay("abd", body, await signWebhook("erga-relay:abc", body))).toBe(false);
  });

  test("the relay: the state names the install's origin; what erga.dev relays opens only with the state's nonce", async () => {
    const state = relayState(INSTALL, "n0nce");
    expect(relayOrigin(state)).toBe(INSTALL);
    expect(relayNonce(state)).toBe("n0nce");
    expect(relayOrigin("plainstate")).toBeNull();
    expect(relayOrigin(`${btoa("javascript:alert(1)").replace(/=+$/, "")}.x`)).toBeNull();
    const sealed = await sealRelay("n0nce", { token: "ghu_x" });
    expect(await openRelay("n0nce", sealed)).toEqual({ token: "ghu_x" });
    expect(await openRelay("other", sealed)).toBeNull();
    expect(await openRelay("n0nce", sealed.slice(0, -3) + "AAA")).toBeNull();
  });
});

describe("Connect GitHub (control/routes.ts)", () => {
  test("the popup goes to the App's install page; GitHub comes back with the installation; the one repository is linked and the page told", async () => {
    gh.state.installations.length = 0;
    const { go, linked } = control();
    const start = await go(OPS, "/github/connect?popup=1");
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(`${www}/apps/erga-editor/installations/new`);
    const state = to.searchParams.get("state")!;
    expect(relayOrigin(state)).toBeNull();
    const cookie = cookieOf(start);
    expect(cookie).toStartWith("erga_github=");
    const back = await installOnGithub(state);
    expect(back.origin + back.pathname).toBe(`${OPS}/auth/github/callback`);
    expect(back.searchParams.get("setup_action")).toBe("install");
    const done = await go(OPS, back.pathname + back.search, { cookie });
    const html = await done.text();
    expect(done.status).toBe(200);
    expect(html).toContain("GitHub is connected: ada/erga.");
    expect(html).toContain('"type":"erga-github","ok":true,"repo":"ada/erga"');
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ installationId: Number(back.searchParams.get("installation_id")), account: { login: "ada" }, repo: { fullName: "ada/erga", cloneUrl: `${www}/ada/erga.git` }, by: "ada" });
    // The cookie is cleared with the answer.
    expect(done.headers.get("set-cookie")).toContain("erga_github=; Path=/; Max-Age=0");
  });

  test("no cookie, or another state: refused in place; no admin: refused", async () => {
    const { go, linked } = control();
    const r = await go(OPS, "/auth/github/callback?code=x&installation_id=1&setup_action=install&state=nope");
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("This didn't start here, or took more than ten minutes.");
    expect(linked).toHaveLength(0);
    const out = control({ signedIn: false });
    expect((await out.go(OPS, "/github/connect?popup=1")).status).toBe(302);
    expect((await out.go(OPS, "/github/connect?popup=1")).headers.get("location")).toStartWith("/auth/github?next=");
  });

  test("several repositories: the pick page, then the one picked; or a new one Erga makes, and refused in place when the App may not", async () => {
    gh.state.repos.push({ id: 4242, owner: "ada", name: "notes", private: true });
    const { go, linked } = control();
    const start = await go(OPS, "/github/connect?popup=1");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const back = await installOnGithub(state);
    const pick = await go(OPS, back.pathname + back.search, { cookie: cookieOf(start) });
    const html = await pick.text();
    expect(pick.status).toBe(200);
    expect(html).toContain("ada/erga");
    expect(html).toContain("ada/notes");
    expect(html).toContain("Make it and use it");
    expect(linked).toHaveLength(0);
    const cookie = cookieOf(pick);
    const picked = await go(OPS, "/github/connect/pick", { method: "POST", cookie, body: new URLSearchParams({ state, repo: "4242" }) });
    expect(await picked.text()).toContain("GitHub is connected: ada/notes.");
    expect(linked[0]).toMatchObject({ repo: { fullName: "ada/notes", private: true } });
    // A new repository, made with the person's token and added to the installation.
    const again = await go(OPS, "/github/connect?popup=1");
    const state2 = new URL(again.headers.get("location")!).searchParams.get("state")!;
    const back2 = await installOnGithub(state2);
    const pick2 = await go(OPS, back2.pathname + back2.search, { cookie: cookieOf(again) });
    const made = await go(OPS, "/github/connect/pick", { method: "POST", cookie: cookieOf(pick2), body: new URLSearchParams({ state: state2, name: "erga-source", private: "on" }) });
    expect(await made.text()).toContain("GitHub is connected: ada/erga-source.");
    expect(gh.state.repos.find((r) => r.name == "erga-source")).toMatchObject({ owner: "ada", private: true });
    expect(gh.state.installations.find((i) => i.account.login == "ada")!.repoIds).toContain(gh.state.repos.find((r) => r.name == "erga-source")!.id);
    // Without the Administration permission GitHub refuses: the pick page says so, and says what to do.
    gh.app.administration = false;
    const third = await go(OPS, "/github/connect?popup=1");
    const state3 = new URL(third.headers.get("location")!).searchParams.get("state")!;
    const back3 = await installOnGithub(state3);
    const pick3 = await go(OPS, back3.pathname + back3.search, { cookie: cookieOf(third) });
    const refused = await go(OPS, "/github/connect/pick", { method: "POST", cookie: cookieOf(pick3), body: new URLSearchParams({ state: state3, name: "another" }) });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("The App needs the Administration permission on repositories for that; or make ada/another on GitHub yourself");
    gh.app.administration = true;
  });

  test("an install's consent: erga.dev relays it with the token sealed, remembers whose installation it is, and the install's control Worker finishes it", async () => {
    const seen: [string, number][] = [];
    gh.state.repos.splice(1); gh.state.installations.length = 0;
    const upstream = control({ isInstall: (o) => o == INSTALL, forks: { installationSeen: async (o: string, i: number) => { seen.push([o, i]); return true; } } as never });
    const install = control({ github: { ...app, clientSecret: undefined, privateKey: undefined, webhookSecret: undefined }, relay: OPS });
    // The install's popup: the state names its origin.
    const start = await install.go(INSTALL, "/github/connect?popup=1");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    expect(relayOrigin(state)).toBe(INSTALL);
    // GitHub comes back to erga.dev's callback (the App's one), which relays.
    const back = await installOnGithub(state);
    const relayed = await upstream.go(OPS, back.pathname + back.search);
    expect(relayed.status).toBe(302);
    const on = new URL(relayed.headers.get("location")!);
    expect(on.origin + on.pathname).toBe(`${INSTALL}/auth/github/callback`);
    expect(on.searchParams.get("state")).toBe(state);
    expect(on.searchParams.get("installation_id")).toBe(back.searchParams.get("installation_id"));
    expect(on.searchParams.get("code")).toBeNull();
    expect(await openRelay(relayNonce(state), on.searchParams.get("relay")!)).toMatchObject({ token: expect.stringMatching(/^ghu_mock_ada_/) });
    expect(seen).toEqual([[INSTALL, Number(back.searchParams.get("installation_id"))]]);
    // Not an install: nothing relayed.
    expect((await upstream.go(OPS, back.pathname + back.search.replace(encodeURIComponent(state), encodeURIComponent(relayState("https://evil.test", "n"))))).status).toBe(400);
    // The install's control Worker finishes it with the relayed token: linked there.
    const done = await install.go(INSTALL, on.pathname + on.search, { cookie: cookieOf(start) });
    expect(await done.text()).toContain("GitHub is connected: ");
    expect(install.linked).toHaveLength(1);
    expect(upstream.linked).toHaveLength(0);
  });

  test("the sign-in relay: an install's server sends people to GitHub with erga.dev's callback, and takes the token erga.dev relays", async () => {
    const upstream = control({ isInstall: (o) => o == INSTALL, forks: { installationSeen: async () => true } as never });
    const platform = {
      secret: "install-secret", dev: () => false, directory: new Directory(memory(), { admins: ["ada"] }),
      signIn: { app: { clientId: TEST_APP.clientId, secret: "" }, github: www, relay: OPS, devLogin: null, encryptionKey: null },
      own: { get: async () => undefined, put: async () => {}, delete: async () => {} },
      deploy: { target: null },
    } as unknown as Platform;
    const start = await startSignIn(platform, new Request(`${INSTALL}/auth/github?next=/admin/ops`));
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    expect(to.searchParams.get("redirect_uri")).toBe(`${OPS}/auth/github/callback`);
    const state = to.searchParams.get("state")!;
    expect(relayOrigin(state)).toBe(INSTALL);
    // GitHub's sign-in page, authorized: a code to erga.dev's callback; relayed to the install with the token sealed.
    const page = await fetch(to);
    const authorize = /id="authorize" href="([^"]+)"/.exec(await page.text())![1].replace(/&amp;/g, "&");
    const back = new URL(authorize);
    const relayed = await upstream.go(OPS, back.pathname + back.search);
    expect(relayed.status).toBe(302);
    const on = new URL(relayed.headers.get("location")!);
    expect(on.origin).toBe(INSTALL);
    const signedIn = await finishSignIn(platform, new Request(on, { headers: { cookie: cookieOf(start) } }));
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("location")).toBe("/admin/ops");
    expect(signedIn.headers.get("set-cookie")).toContain("erga_session=");
    // A relayed answer for another sign-in doesn't open.
    const other = await startSignIn(platform, new Request(`${INSTALL}/auth/github`));
    const stale = await finishSignIn(platform, new Request(`${INSTALL}/auth/github/callback?state=${encodeURIComponent(new URL(other.headers.get("location")!).searchParams.get("state")!)}&relay=${on.searchParams.get("relay")}`, { headers: { cookie: cookieOf(other) } }));
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain("didn&#39;t open");
  });
});

describe("the webhook (control/routes.ts)", () => {
  const push = (ref: string) => JSON.stringify({ ref, before: "0".repeat(40), after: "1".repeat(40), repository: { id: 1, full_name: "ada/erga" }, installation: { id: 5 }, sender: { login: "bo" } });
  const send = (go: ReturnType<typeof control>["go"], body: string, headers: Record<string, string>) => go(OPS, "/github/webhook", { method: "POST", body, headers: { "Content-Type": "application/json", "X-GitHub-Event": "push", ...headers } });

  test("a push event with the right signature is taken and synced in the background; a bad one is refused and changes nothing", async () => {
    const { go, pushed, settle } = control();
    const body = push("refs/heads/staging");
    const bad = await send(go, body, { "X-Hub-Signature-256": await signWebhook("not-the-secret", body) });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "The signature isn't the webhook secret's." });
    expect((await send(go, body, {})).status).toBe(401);
    const tampered = await send(go, body.replace("bo", "al"), { "X-Hub-Signature-256": await signWebhook(TEST_APP.webhookSecret, body) });
    expect(tampered.status).toBe(401);
    await settle();
    expect(pushed).toHaveLength(0);
    const good = await send(go, body, { "X-Hub-Signature-256": await signWebhook(TEST_APP.webhookSecret, body) });
    expect(good.status).toBe(202);
    expect(await good.json()).toEqual({ ok: true, accepted: "refs/heads/staging" });
    await settle();
    expect(pushed).toEqual([JSON.parse(body)]);
    // A ping answers; another event is ignored; no webhook secret here: no webhooks.
    const ping = await go(OPS, "/github/webhook", { method: "POST", body: "{}", headers: { "X-GitHub-Event": "ping", "X-Hub-Signature-256": await signWebhook(TEST_APP.webhookSecret, "{}") } });
    expect(await ping.json()).toEqual({ ok: true, pong: true });
    const none = control({ github: { ...app, webhookSecret: undefined } });
    expect((await send(none.go, body, { "X-Hub-Signature-256": await signWebhook(TEST_APP.webhookSecret, body) })).status).toBe(404);
  });

  test("an install's push is relayed to its control Worker, signed with its fork secret's hash; the install takes only that", async () => {
    const relayedTo: Request[] = [];
    const upstream = control({ ownRepo: false, forks: { ofInstallation: async (i: number) => (i == 5 ? { control: INSTALL, secretHash: "h4sh" } : null) } as never });
    upstream.c.net = (async (input: RequestInfo | URL, init?: RequestInit) => { relayedTo.push(new Request(input, init)); return new Response("{}", { status: 202 }); }) as typeof fetch;
    const body = push("refs/heads/main");
    expect((await send(upstream.go, body, { "X-Hub-Signature-256": await signWebhook(TEST_APP.webhookSecret, body) })).status).toBe(202);
    await upstream.settle();
    expect(relayedTo).toHaveLength(1);
    expect(relayedTo[0].url).toBe(`${INSTALL}/github/webhook`);
    const sig = relayedTo[0].headers.get("x-erga-relay-signature")!;
    expect(await verifyRelay("h4sh", await relayedTo[0].text(), sig)).toBe(true);
    // The install's control Worker: the relay's signature, or nothing.
    const install = control({ github: { ...app, clientSecret: undefined, privateKey: undefined, webhookSecret: undefined }, relay: OPS });
    install.c.forkSecretHash = "h4sh";
    expect((await install.go(INSTALL, "/github/webhook", { method: "POST", body, headers: { "X-GitHub-Event": "push", "X-Erga-Relay-Signature": "sha256=00" } })).status).toBe(401);
    expect((await install.go(INSTALL, "/github/webhook", { method: "POST", body, headers: { "X-GitHub-Event": "push", "X-Erga-Relay-Signature": sig } })).status).toBe(202);
    await install.settle();
    expect(install.pushed).toHaveLength(1);
  });
});
