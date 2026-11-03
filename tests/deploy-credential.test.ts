// The Cloudflare credential: an OAuth grant, consented to once, refreshed by
// itself (control/deploys/credential.ts), and the branch deploys that run on it.

import { beforeAll, describe, expect, test } from "bun:test";
import { CONTROL_OAUTH_SCOPES, exchangeCode, OAuthCredential, pkce } from "../control/deploys/credential";
import { Cloudflare } from "../control/deploys/cloudflare-api";
import { mockCloudflare } from "../dev/mock-cloudflare";
import { mockBuilder } from "../dev/mock-builder";
import { prepareRelease, release, SHA2, SHA3, env, staging, Server, bootstrap } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

beforeAll(prepareRelease, 120_000);

describe("the Cloudflare credential: an OAuth grant, consented to once, refreshed by itself", () => {
  const SEAL = "k".repeat(43);
  /** A grant over storage of its own, with a clock the test moves. */
  function grant(mock: ReturnType<typeof mockCloudflare>, storage = new Map<string, unknown>()) {
    const clock = { now: 1_800_000_000_000 };
    const log: string[] = [];
    const c = new OAuthCredential({
      storage: { get: async (k) => structuredClone(storage.get(k)) as any, put: async (k, v) => { storage.set(k, structuredClone(v)); }, delete: async (k) => { storage.delete(k); } },
      net: mock.fetch, client: { id: "erga-client" }, sealKey: SEAL, now: () => clock.now, log: (l) => log.push(l),
    });
    return { c, clock, log, storage };
  }
  /** The consent's end: the code exchanged (PKCE), the grant kept. */
  async function consent(mock: ReturnType<typeof mockCloudflare>, c: OAuthCredential, by = "ada") {
    const { verifier } = await pkce();
    const answer = await exchangeCode(mock.fetch, { code: "mock-code", redirect: "https://ops.erga.dev/install/callback", verifier, client: { id: "erga-client" } });
    return c.connect(answer, by);
  }

  test("before the consent: no token, and the status says what to do", async () => {
    const mock = mockCloudflare({ fleet: true });
    const { c } = grant(mock);
    await expect(c.token()).rejects.toThrow("an admin connects Cloudflare (a consent in a popup)");
    expect(await c.status()).toMatchObject({ connected: false, by: null, problem: expect.stringContaining("connects Cloudflare") });
    expect((await c.status()).problem).not.toContain("/install");
  });

  test("the consent gives a grant; the token is the same until ten minutes before it expires, then a refresh rotates both tokens", async () => {
    const mock = mockCloudflare({ fleet: true });
    const { c, clock, log, storage } = grant(mock);
    const first = await consent(mock, c);
    expect(first).toMatch(/^mock-oauth-/);
    expect(mock.state.oauthGrants).toBe(1);
    expect(await c.status()).toMatchObject({ connected: true, by: "ada", at: clock.now, expiresAt: clock.now + 3600_000, scopes: CONTROL_OAUTH_SCOPES.split(" "), error: null, problem: null });
    // Sealed at rest: the tokens aren't in the storage in the clear.
    expect(JSON.stringify([...storage.values()])).not.toContain(first);
    expect(await c.token()).toBe(first);
    clock.now += 49 * 60_000;
    expect(await c.token()).toBe(first);
    clock.now += 2 * 60_000;
    const [a, b] = await Promise.all([c.token(), c.token()]);
    expect(a).toBe(b);
    expect(a).not.toBe(first);
    expect(mock.state.oauthGrants).toBe(2);
    expect(mock.state.refreshTokens).toHaveLength(1);
    expect(await c.status()).toMatchObject({ connected: true, refreshedAt: clock.now, expiresAt: clock.now + 3600_000 });
    expect(log.some((l) => l.startsWith("Cloudflare credential refreshed"))).toBe(true);
  });

  test("a grant revoked on Cloudflare: the refresh is refused, the status says so, a new consent mends it; Disconnect revokes", async () => {
    const mock = mockCloudflare({ fleet: true });
    const { c, clock } = grant(mock);
    await consent(mock, c);
    mock.state.refreshTokens = [];
    clock.now += 55 * 60_000;
    await expect(c.token()).rejects.toThrow("stopped working (400 invalid_grant: refresh token revoked or unknown): an admin connects Cloudflare again.");
    expect(await c.status()).toMatchObject({ connected: false, error: "400 invalid_grant: refresh token revoked or unknown", problem: expect.stringContaining("stopped working") });
    await consent(mock, c, "bo");
    expect(await c.status()).toMatchObject({ connected: true, by: "bo", error: null });
    await c.disconnect();
    expect(mock.state.revoked).toBe(1);
    expect(mock.state.refreshTokens).toEqual([]);
    expect(await c.status()).toMatchObject({ connected: false, by: null });
  });

  test("a 429 on the refresh is a moment's trouble, not a dead grant: the next use refreshes again", async () => {
    const mock = mockCloudflare({ fleet: true });
    const { c, clock, log } = grant(mock);
    await consent(mock, c);
    clock.now += 55 * 60_000;
    mock.state.oauthRefreshStatus = 429;
    await expect(c.token()).rejects.toThrow("Cloudflare asked Erga to slow down while it refreshed the control Worker's Cloudflare credential (429 rate_limited): try again in a minute.");
    expect(await c.status()).toMatchObject({ connected: true, error: null, problem: null });
    expect(log.at(-1)).toContain("failed for now");
    expect(await c.token()).toMatch(/^mock-oauth-/);
    expect(await c.status()).toMatchObject({ connected: true, refreshedAt: clock.now });
  });

  test("an access token Cloudflare's API refuses (401): a refresh at once, and a refused refresh ends the grant", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const { c } = grant(mock);
    const first = await consent(mock, c);
    // Revoked on the dashboard: the access token is refused at once, and so is the refresh token.
    mock.state.refusedTokens = [first];
    mock.state.refreshTokens = [];
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-control", env(), { credential: c });
    await server.instance.hook("staging", SHA2);
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "failed" });
    // The refused call's refresh says it: the grant is gone.
    expect(await c.status()).toMatchObject({ connected: false, error: "400 invalid_grant: refresh token revoked or unknown" });
    await expect(c.token()).rejects.toThrow("stopped working (400 invalid_grant: refresh token revoked or unknown)");
  });

  test("a refresh during a deploy (Cloudflare ends the old access token) doesn't fail it: the step that gets 401 goes on with the new token", async () => {
    // Staging, 2026-11-02: the account step ran on one token; a refresh in the same second ended it, and the database
    // step failed with "Authentication error [code 10000]".
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const { c, clock } = grant(mock);
    const first = await consent(mock, c);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-control", env(), { credential: c, now: () => clock.now });
    // Just before the database step lists the databases, another use of the credential refreshes it.
    const real = mock.fetch;
    let refreshed: string | null = null;
    mock.fetch = async (input, init) => {
      if (!refreshed && String(input).includes("/d1/database?")) {
        clock.now += 51 * 60_000;
        refreshed = await c.token();
      }
      return real(input, init);
    };
    await server.instance.hook("staging", SHA2);
    await server.settle();
    expect(refreshed).not.toBe(first);
    expect(mock.state.rotatedTokens).toEqual([first]);
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA2, error: null });
    expect(mock.state.oauthGrants).toBe(2); // the refresh that ended the old token, and no other
  });

  test("the branch deploys run on it: a push with no credential waits, deploys once Cloudflare is connected, and a deploy an hour later refreshes first", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const { c, clock } = grant(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-control", env(), { credential: c, now: () => clock.now });
    await server.instance.hook("staging", SHA2);
    await server.settle();
    // It waits, and says why: no credential. (It used to be dropped, with a log line only.)
    expect(await server.status("staging")).toMatchObject({ state: "idle", commit: SHA2, pending: SHA2, error: expect.stringContaining("waits to deploy. The control Worker has no Cloudflare credential") });
    await consent(mock, c);
    await server.instance.ready();
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA2, pending: null, error: null });
    expect((await server.instance.status()).credential).toMatchObject({ connected: true, by: "ada" });
    clock.now += 61 * 60_000;
    await server.instance.hook("staging", SHA3);
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA3 });
    expect(mock.state.oauthGrants).toBe(2);
  });
});
