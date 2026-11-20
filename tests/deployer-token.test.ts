// The deployer's token (deploy/pipeline/deployer.ts, checkToken) and the page where the person pastes it
// (deploy/own/browser.ts, deployerToken). Against the mock Cloudflare, whose token for one Worker is the design's
// reading of Cloudflare's scope, not a record of its answers: a real token is tried in the deploy plan's task 12.

import { beforeAll, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { d1Sql } from "../deploy/deployer/cloudflare";
import { Cloudflare, type Fetch } from "../deploy/deployer/cloudflare-api";
import { readControl } from "../deploy/deployer/control";
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
    const { check, calls } = await account();
    expect(await check("mock-only-erga-next")).toEqual({ refused: [], unconfirmed: NEVER_SHOWN });
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
