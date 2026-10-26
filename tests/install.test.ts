// /install on the control Worker: the consent's start, and what the page says
// when Cloudflare refuses (a scope the OAuth client doesn't allow) or consents.
// And the same consent from the Ops page's Cloudflare card: a popup, whose last
// page tells the page that opened it.
import { describe, expect, test } from "bun:test";
import { controlRoutes, type Control } from "../control/routes";
import { CONTROL_OAUTH_SCOPES, OAuthCredential, sealKeyFrom, type CredentialStatus } from "../control/deploys/credential";
import { OAUTH } from "../control/deploys/cloudflare-api";
import { ACCOUNT_ID, mockCloudflare, MOCK_OAUTH_SCOPES } from "../dev/mock-cloudflare";
import type { Platform } from "../server/platform";
import type { Session } from "../server/platform";

const ORIGIN = "https://ops.erga.test";
const session = { login: "ada", name: "Ada" } as unknown as Session;
const platform = { sessionOf: async () => session, directory: { users: { isAdmin: async () => true, actsAsAdmin: async () => true } } } as unknown as Platform;

/** A control with a real OAuthCredential on a memory store, against the mock's OAuth, or a fetch of the test's own. */
function control(net: typeof fetch, mock = false) {
  const store = new Map<string, unknown>();
  const storage = { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, v); }, delete: async (k: string) => store.delete(k) };
  const credential = new OAuthCredential({ storage: storage as never, net: net as never, client: { id: "erga-client" }, sealKey: sealKeyFrom("s") });
  const calls: string[] = [];
  const c: Control = {
    github: null,
    platform, app: "https://erga.test", version: "v1",
    layout: (o) => new Response(`<title>${o.title}</title>${o.body}`, { headers: { "Content-Type": "text/html" } }),
    deploys: { credentialStatus: () => credential.status(), connectCredential: (a: never, by: string) => credential.connect(a, by), disconnectCredential: () => credential.disconnect() } as never,
    oauth: { clientId: "erga-client", accountId: ACCOUNT_ID, worker: "erga-control", net: ((input: RequestInfo | URL, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`); return net(input, init); }) as never, mock },
  };
  const go = (path: string, init: RequestInit & { cookie?: string } = {}) => controlRoutes(new Request(`${ORIGIN}${path}`, { ...init, headers: { accept: "text/html", origin: ORIGIN, ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) } }), c);
  return { go, calls, credential };
}

describe("/install", () => {
  test("Connect Cloudflare asks Cloudflare for every control scope, with PKCE", async () => {
    const { go } = control(fetch);
    const r = await go("/install/start", { method: "POST" });
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(OAUTH.authorize);
    expect(to.searchParams.get("client_id")).toBe("erga-client");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/install/callback`);
    expect(to.searchParams.get("scope")).toBe(CONTROL_OAUTH_SCOPES);
    expect(to.searchParams.get("scope")!.split(" ")).toContain("cloudchamber.write");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(r.headers.get("set-cookie")).toMatch(
      /^erga_install=[A-Za-z0-9_-]+; Path=\/install; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/
    );
  });

  test("a scope the client doesn't allow: Cloudflare's refusal reaches the page, names the scope, and nothing is stored", async () => {
    const { go, calls, credential } = control(fetch);
    const start = await go("/install/start", { method: "POST" });
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    // What Cloudflare sends the browser back with (RFC 6749 §4.1.2.1; its description names the scope).
    const refusal = new URLSearchParams({ error: "invalid_scope", error_description: "The requested scope is invalid, unknown, or malformed. The OAuth 2.0 Client is not allowed to request scope 'cloudchamber.write'.", state });
    const back = await go(`/install/callback?${refusal}`, { cookie });
    expect(back.status).toBe(302);
    const where = new URL(back.headers.get("location")!, ORIGIN);
    expect(where.pathname).toBe("/install");
    expect(where.searchParams.get("error")).toBe("Cloudflare didn't authorize Erga: The requested scope is invalid, unknown, or malformed. The OAuth 2.0 Client is not allowed to request scope 'cloudchamber.write'.");
    expect(back.headers.get("set-cookie")).toContain("erga_install=; Path=/install; Max-Age=0");
    expect(calls).toEqual([]); // no token exchange
    expect(await credential.status()).toMatchObject({ connected: false, by: null });
    const html = await (await go(where.pathname + where.search)).text();
    expect(html).toContain("not allowed to request scope &#39;cloudchamber.write&#39;");
    expect(html).toContain("Not connected");
  });

  test("a callback that didn't start here, or without Cloudflare's code, is refused", async () => {
    const { go, calls } = control(fetch);
    const r = await go("/install/callback?code=mock-code&state=other");
    expect(new URL(r.headers.get("location")!, ORIGIN).searchParams.get("error")).toBe("This consent didn't start here, or took more than ten minutes. Try again.");
    expect(calls).toEqual([]);
  });

  test("consent: the grant is stored, read once, and its scopes shown; a scope Cloudflare left out is named", async () => {
    const cf = mockCloudflare({ fleet: true });
    const { go, credential } = control(cf.fetch as never);
    const start = await go("/install/start", { method: "POST" });
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const back = await go(`/install/callback?code=mock-code&state=${state}`, { cookie });
    const where = new URL(back.headers.get("location")!, ORIGIN);
    expect(Object.fromEntries(where.searchParams)).toEqual({ ok: "1" });
    expect(await credential.status()).toMatchObject({ connected: true, by: "ada", scopes: MOCK_OAUTH_SCOPES.split(" ") });
    const html = await (await go(where.pathname + where.search)).text();
    expect(html).toContain("Connected");
    expect(html).toContain("The grant reads erga-control's settings: it works.");

    // Cloudflare grants fewer scopes than asked (the client lost one): the page says which.
    cf.state.oauthScopes = CONTROL_OAUTH_SCOPES.split(" ").filter((s) => s != "cloudchamber.write").join(" ");
    const again = await go("/install/start", { method: "POST" });
    const cookie2 = again.headers.get("set-cookie")!.split(";")[0];
    const state2 = new URL(again.headers.get("location")!).searchParams.get("state")!;
    const back2 = await go(`/install/callback?code=mock-code&state=${state2}`, { cookie: cookie2 });
    expect(Object.fromEntries(new URL(back2.headers.get("location")!, ORIGIN).searchParams)).toEqual({ ok: "1", missing: "cloudchamber.write" });
  });
});

describe("Connect Cloudflare from the Ops page: a popup", () => {
  /** The popup's last page: the message it posts to the page that opened it. */
  const posted = async (r: Response) => JSON.parse(/const m = (\{.*\});/.exec(await r.text())![1]) as { type: string; ok: boolean; error?: string; warnings: string[] };

  test("a GET starts it (the Ops page may be on another origin); the callback tells the opener and closes; the deploys waiting go", async () => {
    const cf = mockCloudflare({ fleet: true });
    const { go, credential } = control(cf.fetch as never);
    const start = await go("/install/start?popup=1", { headers: { origin: "" } });
    expect(start.status).toBe(302);
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const back = await go(`/install/callback?code=mock-code&state=${state}`, { cookie });
    expect(back.status).toBe(200);
    expect(back.headers.get("set-cookie")).toContain("erga_install=; Path=/install; Max-Age=0");
    const html = await back.clone().text();
    // Posted to Erga's own origins only (this one, the app's, and the environments'), and on the channel here.
    expect(html).toContain(`for (const o of ["${ORIGIN}","https://erga.test","https://erga.dev","https://staging.erga.dev","https://ops.erga.dev"])`);
    expect(html).toContain("window.close()");
    expect(await posted(back)).toEqual({ type: "erga-deploy-credential", ok: true, warnings: [] });
    expect(await credential.status()).toMatchObject({ connected: true, by: "ada" });
  });

  test("Cancel on Cloudflare's page, in the popup: the opener hears why, and the popup stays open to say it", async () => {
    const { go, credential } = control(fetch);
    const start = await go("/install/start?popup=1");
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const back = await go(`/install/callback?error=access_denied&state=${state}`, { cookie });
    expect(back.status).toBe(400);
    expect(await back.clone().text()).not.toContain("window.close()");
    expect(await posted(back)).toEqual({ type: "erga-deploy-credential", ok: false, error: "You didn't authorize Erga on Cloudflare, so nothing changed.", warnings: [] });
    expect(await credential.status()).toMatchObject({ connected: false });
  });
});
