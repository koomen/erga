// The deployer's token (deploy/pipeline/deployer.ts, checkToken) and the page where the person pastes it
// (deploy/own/browser.ts, deployerToken). Against the mock Cloudflare, whose token for one Worker is the design's
// reading of Cloudflare's scope, not a record of its answers: a real token is tried in the deploy plan's task 12.

import { beforeAll, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { d1Sql } from "../deploy/deployer/cloudflare";
import { Cloudflare, type Fetch } from "../deploy/deployer/cloudflare-api";
import { readControl } from "../deploy/deployer/control";
import { keptLogin } from "../deploy/local-credential";
import { deployerToken } from "../deploy/own/browser";
import { checkToken, hasDeployer, installDeployer, installWithToken, removeDeployer } from "../deploy/pipeline/deployer";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { bootstrap, prepareRelease } from "./helpers/deploys.ts";

beforeAll(prepareRelease, 120_000);

const TARGET = { account: FLEET_ACCOUNT, worker: "erga-next" };
/** What no read can show: said each time. */
const NEVER_SHOWN = [
  "That the token may deploy to erga-next (the role Editor): Erga changes nothing to try it. The first deploy from the cloud shows it.",
  "That the token has no other permission than those tried here (D1, another Worker): Cloudflare shows a token's permissions on its own page only.",
];

/** The instance on the mock Cloudflare, with the person's own login. */
async function account() {
  const mock = mockCloudflare({ fleet: true });
  await bootstrap(mock);
  const own = new Cloudflare("mock-setup-token", mock.fetch);
  const from = mock.state.calls.length;
  return {
    mock,
    own,
    check: (token: string, net: Fetch = mock.fetch) => checkToken(net, own, TARGET, token),
    calls: () => mock.state.calls.slice(from),
  };
}

describe("the check of the deployer's token", () => {
  test("a token for the instance's Worker only is taken, and the check says what it could not confirm", async () => {
    const { mock, check, calls } = await account();
    // Cloudflare's no to the D1 list is a 401 (the mock answers as a real token got it): a clear no, as a 403 is.
    const statuses: number[] = [];
    const seen: Fetch = async (input, init) => {
      const answer = await mock.fetch(input, init);
      if (String(input).includes("/d1/database")) statuses.push(answer.status);
      return answer;
    };
    expect(await check("mock-only-erga-next", seen)).toEqual({ refused: [], unconfirmed: NEVER_SHOWN });
    expect(statuses).toEqual([401]);
    const forbidden: Fetch = (input, init) =>
      String(input).includes("/d1/database") ? Promise.resolve(new Response("{}", { status: 403 })) : mock.fetch(input, init);
    expect(await check("mock-only-erga-next", forbidden)).toEqual({ refused: [], unconfirmed: NEVER_SHOWN });
    // Reads only: the check changes nothing.
    expect(calls().every((c) => c.startsWith("GET "))).toBe(true);
  });

  test("a token that can do more is refused, with each thing that it can do", async () => {
    const { mock, own, check } = await account();
    // An account's own token: D1, and each Worker.
    const wide = await check("mock-deployer-token");
    expect(wide.refused).toHaveLength(2);
    expect(wide.refused[0]).toBe(
      "The token can read the account's D1 databases. The deployer needs no permission for D1: make a token without it."
    );
    expect(wide.refused[1]).toMatch(/^The token can read another Worker \([\w-]+\)\. Make a token for the Worker erga-next only\.$/);
    // The other Worker that it tries is the deployer itself, when there is one: the token must not change the deployer.
    await installDeployer(own, TARGET, "mock-only-erga-next");
    expect((await check("mock-deployer-token")).refused[1]).toContain("another Worker (erga-next-deployer)");
    expect(mock.state.calls.at(-1)).toBe(`GET /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-next-deployer/settings`);
  });

  test("a token that is not for the instance's Worker, or that Cloudflare does not know, is refused at once", async () => {
    const { check, calls } = await account();
    expect((await check("mock-only-erga")).refused).toEqual([
      "The token can't read the Worker erga-next. Give it that Worker, with the role Editor.",
    ]);
    expect((await check("not-a-token")).refused).toEqual([
      "Cloudflare does not know this token: it is not whole, it expired, or it is not a token of this account.",
    ]);
    // Nothing more is tried with such a token.
    expect(calls()).toHaveLength(2);
  });

  test("no clear answer, and an account with no other Worker, are said: not a refusal, and not a yes", async () => {
    const { mock, check } = await account();
    const down: Fetch = (input, init) =>
      String(input).includes("/d1/database") ? Promise.resolve(new Response("Bad gateway", { status: 502 })) : mock.fetch(input, init);
    expect(await check("mock-only-erga-next", down)).toEqual({
      refused: [],
      unconfirmed: [
        "Whether the token can read the account's D1 databases: Cloudflare gave no clear answer (it answered 502).",
        ...NEVER_SHOWN,
      ],
    });
    // An account whose only Worker is the instance's.
    for (const name of Object.keys(mock.state.scripts)) if (name != "erga-next") delete mock.state.scripts[name];
    expect((await check("mock-only-erga-next")).unconfirmed).toEqual([
      "That the token is for the Worker erga-next only: the account has no other Worker to try it on.",
      ...NEVER_SHOWN,
    ]);
  });
});

describe("the person's own login, in a setup that waits for the token", () => {
  // What the setup of staging showed on 2026-11-20: a good token for one Worker, and Cloudflare's 401 [code 10000] to
  // "list your Workers". That list is a call with the person's own login, which the setup had read at its start.
  test("a login that ends while the person makes the token is read again: the check goes on", async () => {
    const { mock } = await account();
    const HOUR = 3_600_000;
    let now = 0;
    const reads: string[] = [];
    const login = keptLogin(
      () => {
        reads.push(`mock-login-${reads.length + 1}`);
        return { token: reads.at(-1)!, from: "the cf CLI's login", expires: now + HOUR };
      },
      () => now
    );
    // Cloudflare takes a login until its end only.
    const net: Fetch = (input, init) =>
      new Headers(init?.headers).get("authorization") == "Bearer mock-login-1" && now >= HOUR
        ? Promise.resolve(Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 401 }))
        : mock.fetch(input, init);
    const own = new Cloudflare(() => login()!.token, net);
    const list = () => own.call<{ id: string }[]>("GET", `/accounts/${FLEET_ACCOUNT}/workers/scripts`, "list your Workers");
    expect((await list())?.map((s) => s.id)).toContain("erga-next");
    now = HOUR - 1;
    await list();
    expect(reads).toEqual(["mock-login-1"]);

    now = HOUR + 1;
    expect(await checkToken(net, own, TARGET, "mock-only-erga-next")).toEqual({ refused: [], unconfirmed: NEVER_SHOWN });
    expect(reads).toEqual(["mock-login-1", "mock-login-2"]);
    // With the login as it was at the start, the check stops at Cloudflare's no to the person's own list.
    expect(await checkToken(net, new Cloudflare("mock-login-1", net), TARGET, "mock-only-erga-next").catch((e: Error) => e.message)).toBe(
      "Cloudflare didn't accept the credential when it tried to list your Workers: the token may be expired or revoked. (Cloudflare said: Authentication error [code 10000])"
    );
  });

  test("a credential without an end (CLOUDFLARE_API_TOKEN) is read one time", () => {
    let reads = 0;
    const login = keptLogin(
      () => ({ token: `mock-${++reads}`, from: "CLOUDFLARE_API_TOKEN" }),
      () => Number.MAX_SAFE_INTEGER
    );
    expect([login()?.token, login()?.token, reads]).toEqual(["mock-1", "mock-1", 1]);
  });
});

describe("cloud deploys, from a person's token", () => {
  const sql = (own: Cloudflare) => d1Sql(own, TARGET);
  test("a good token installs the deployer and turns auto-deploy on; a refused one changes nothing", async () => {
    const { mock, own } = await account();
    const from = mock.state.calls.length;
    await expect(installWithToken(mock.fetch, own, TARGET, "mock-deployer-token")).rejects.toThrow(
      /^The token can read the account's D1 databases\..*\nThe token can read another Worker \(/
    );
    expect(mock.state.scripts["erga-next-deployer"]).toBeUndefined();
    expect(mock.state.calls.slice(from).every((c) => c.startsWith("GET "))).toBe(true);
    expect(await Effect.runPromise(readControl(sql(own)))).toBeNull();

    expect(await installWithToken(mock.fetch, own, TARGET, "mock-only-erga-next")).toEqual(NEVER_SHOWN);
    expect(mock.state.secrets["erga-next-deployer"]).toEqual({ CLOUDFLARE_API_TOKEN: "mock-only-erga-next" });
    expect(await hasDeployer(own, TARGET)).toBe(true);
    expect(await Effect.runPromise(readControl(sql(own)))).toMatchObject({ auto: true, ask: null });

    // Local deploys again: the deployer goes, with its token.
    expect(await removeDeployer(own, TARGET)).toBe(true);
    expect(mock.state.scripts["erga-next-deployer"]).toBeUndefined();
    expect(await hasDeployer(own, TARGET)).toBe(false);
    expect(await removeDeployer(own, TARGET)).toBe(false);
    expect(mock.state.scripts["erga-next"]).toBeDefined();
  });
});

describe("the page for the deployer's token", () => {
  test("says how to make the token, refuses one with the reason, and takes a good one: the token is on no page", async () => {
    const taken: string[] = [];
    const take = async (token: string) => {
      taken.push(token);
      if (token != "the-good-token")
        throw new Error("The token can read another Worker (erga).\nMake a token for the Worker erga-next only.");
      return ["That the token may deploy to erga-next."];
    };
    let at = "";
    const ended = deployerToken({ account: FLEET_ACCOUNT, worker: "erga-next", take }, 20_000, (url) => (at = url));
    expect(at).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const post = async (secret: string) => (await fetch(at, { method: "POST", body: new URLSearchParams({ secret }) })).text();

    const first = await (await fetch(at)).text();
    expect(first).toContain(`href="https://dash.cloudflare.com/${FLEET_ACCOUNT}/api-tokens"`);
    expect(first).toContain("for the Worker <code>erga-next</code> only, with the role Editor");
    expect(first).toContain('type="password"');
    expect(await post("  ")).toContain("Paste the token.");
    const refused = await post("the-wide-token");
    expect(refused).toContain("The token can read another Worker (erga).\nMake a token for the Worker erga-next only.");
    expect(refused).toContain('type="password"');
    const done = await post("the-good-token");
    expect(done).toContain("The deployer has the token.");
    expect(done).toContain("<p>Erga could not confirm:</p><ul><li>That the token may deploy to erga-next.</li></ul>");
    expect(await ended).toBe("");
    expect(taken).toEqual(["the-wide-token", "the-good-token"]);
    for (const page of [first, refused, done]) expect(page).not.toMatch(/the-(wide|good)-token/);
  });
});
