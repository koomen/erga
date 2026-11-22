// The deployer's token (deploy/deployer/token.ts): the check that the deployer makes of a token, its fetch handler,
// which takes a token from the instance (the service binding DEPLOYER), and its store, which keeps the token sealed.
// Against the mock Cloudflare, whose token for one Worker is the design's reading of Cloudflare's scope, not a record
// of its answers: a real token is tried in the deploy plan's task 12.

import { beforeAll, describe, expect, test } from "bun:test";
import { Cloudflare, type Fetch } from "../deploy/deployer/cloudflare-api";
import { type DeployerAnswer, open, tokenProblem } from "../deploy/deployer/token";
import { deployer, type Env } from "../deploy/deployer/worker";
import { keptLogin } from "../deploy/local-credential";
import { installDeployer } from "../deploy/pipeline/deployer";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { KEY, storeBinding } from "./helpers/binding.ts";
import { bootstrap, prepareRelease } from "./helpers/deploys.ts";

beforeAll(prepareRelease, 120_000);

const TARGET = { account: FLEET_ACCOUNT, worker: "erga-next" };
const WHERE = { ACCOUNT: FLEET_ACCOUNT, WORKER: "erga-next" };
/** A token for the instance's Worker and the deployer's own; and one for the instance's Worker only. */
const GOOD = "mock-pair-erga-next";
const ONE = "mock-only-erga-next";
const UNKNOWN = `Cloudflare does not know this token: it is not whole, it was deleted, or it is a token of another account than ${FLEET_ACCOUNT}.`;
const D1 = "The token can read the account's D1 databases. The deployer needs no permission for D1: make a token without it.";

/** The instance on the mock Cloudflare, with the person's own login. */
async function account() {
  const mock = mockCloudflare({ fleet: true });
  await bootstrap(mock);
  const own = new Cloudflare("mock-setup-token", mock.fetch);
  const from = mock.state.calls.length;
  return {
    mock,
    own,
    check: (token: string, net: Fetch = mock.fetch) => tokenProblem(net, WHERE, token),
    calls: () => mock.state.calls.slice(from),
  };
}

describe("the deployer's check of a token", () => {
  test("a token for the instance's Worker and the deployer's is taken, with reads only; one for the instance's Worker only too", async () => {
    const { mock, check, calls } = await account();
    // Cloudflare's no to the D1 list is a 401 (the mock answers as a real token got it): a clear no, as a 403 is.
    const statuses: number[] = [];
    const seen: Fetch = async (input, init) => {
      const answer = await mock.fetch(input, init);
      if (String(input).includes("/d1/database")) statuses.push(answer.status);
      return answer;
    };
    expect(await check(GOOD, seen)).toBeNull();
    expect(statuses).toEqual([401]);
    const forbidden: Fetch = (input, init) =>
      String(input).includes("/d1/database") ? Promise.resolve(new Response("{}", { status: 403 })) : mock.fetch(input, init);
    expect(await check(GOOD, forbidden)).toBeNull();
    expect(await check(ONE)).toBeNull();
    // Reads only: the check changes nothing. Its last read asks for the account's Workers: such a token lists none.
    expect(calls().every((c) => c.startsWith("GET "))).toBe(true);
    expect(calls().at(-1)).toBe(`GET /accounts/${FLEET_ACCOUNT}/workers/scripts`);
  });

  test("a token that can do more is refused, with what it can do", async () => {
    const { mock, own, check } = await account();
    // An account's own token: D1, and each Worker.
    expect(await check("mock-deployer-token")).toBe(D1);
    // With no D1, it still reads another Worker: the first one that it lists, which is not the instance's or its deployer.
    await installDeployer(own, TARGET);
    const noD1: Fetch = (input, init) =>
      String(input).includes("/d1/database") ? Promise.resolve(new Response("{}", { status: 403 })) : mock.fetch(input, init);
    expect(await check("mock-deployer-token", noD1)).toBe(
      "The token can read another Worker (erga). Make a token for the Workers erga-next and erga-next-deployer only."
    );
    // A list that Cloudflare does not answer is no "none".
    const noList: Fetch = (input, init) =>
      String(input).endsWith("/workers/scripts") ? Promise.resolve(new Response("Bad gateway", { status: 502 })) : noD1(input, init);
    expect(await check(GOOD, noList)).toContain("whether the token lists the account's Workers (it answered 502)");
  });

  test("a token that is not for the instance's Worker, that Cloudflare does not know, or that is no token, is refused at once", async () => {
    const { check, calls } = await account();
    expect(await check("mock-only-erga-000")).toBe(
      `Cloudflare knows this token, but the token can't read the Worker erga-next of the account ${FLEET_ACCOUNT} (Cloudflare answered 403). Give it that Worker, with the role Editor.`
    );
    expect(await check("not-a-token-0123456789")).toBe(UNKNOWN);
    // Nothing more is tried with such a token: the first one is verified and reads its Worker, the second one is
    // verified as an account's token and as a user's. Text that is no token is tried on nothing.
    expect(calls()).toEqual([
      `GET /accounts/${FLEET_ACCOUNT}/tokens/verify`,
      `GET /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-next/settings`,
      `GET /accounts/${FLEET_ACCOUNT}/tokens/verify`,
      "GET /user/tokens/verify",
    ]);
    expect([await check(""), await check("two words")]).toEqual([
      "Paste the token.",
      "That isn't a token: it is one line, with no spaces.",
    ]);
    expect(calls()).toHaveLength(4);
  });

  test("no clear answer from Cloudflare is no yes: the token is not taken, and the person pastes it again", async () => {
    const { mock, check } = await account();
    const down: Fetch = (input, init) =>
      String(input).includes("/d1/database") ? Promise.resolve(new Response("Bad gateway", { status: 502 })) : mock.fetch(input, init);
    expect(await check(GOOD, down)).toBe(
      "Cloudflare gave no clear answer about whether the token reads the account's D1 databases (it answered 502). Paste the token again in a minute."
    );
    const gone: Fetch = () => Promise.reject(new Error("no network"));
    expect(await check(GOOD, gone)).toContain("whether it knows the token (no answer)");
  });
});

describe("the check against Cloudflare's own answers", () => {
  // Recorded from api.cloudflare.com on 2026-11-21, with a token that Cloudflare does not know (40 letters): both
  // verifies answer 401 [code 1000], and a read of a Worker's settings or of D1 answers 401 [code 10000].
  // Recorded on 2026-11-20, with a real token for one Worker: the statuses 401 for D1 and 403 for another Worker.
  // Not recorded: what verify answers to a token that Cloudflare knows (no agent holds one). It is as Cloudflare's
  // API reference gives it. That Cloudflare answers 401 [code 10000] to a known token for a Worker that the token may
  // not read is Pete's case of 2026-11-21 on staging, as the manager gave it: the check must not call that token unknown.
  const INVALID = {
    status: 401,
    body: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }], messages: [], result: null },
  };
  const DENIED = {
    status: 401,
    body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null },
  };
  const verified = (status: string) => ({
    status: 200,
    body: {
      success: true,
      errors: [],
      messages: [{ code: 10000, message: "This API Token is valid and active", type: null }],
      result: { id: "0".repeat(32), status },
    },
  });
  const OK = { status: 200, body: { success: true, errors: [], messages: [], result: {} } };
  const ACC = `/accounts/${FLEET_ACCOUNT}`;
  /** Cloudflare, as a table of its answers by path; a path that the table lacks fails the test. */
  function cloudflare(answers: Record<string, { status: number; body: object }>) {
    const calls: string[] = [];
    const net: Fetch = async (input) => {
      const path = String(input).replace("https://api.cloudflare.com/client/v4", "");
      calls.push(path);
      const a = answers[path];
      if (!a) throw new Error(`no answer for ${path}`);
      return Response.json(a.body, { status: a.status });
    };
    return { calls, check: () => tokenProblem(net, WHERE, "x".repeat(40)) };
  }
  const WORKER = `${ACC}/workers/scripts/erga-next/settings`;
  const REST = {
    [`${ACC}/d1/database?per_page=1`]: DENIED,
    // (What Cloudflare answers such a token for the list of the account's Workers is not recorded: a refusal, here.)
    [`${ACC}/workers/scripts`]: { ...DENIED, status: 403 },
  };

  test("a token that Cloudflare does not know: both verifies say so, and no Worker is read", async () => {
    const cf = cloudflare({ [`${ACC}/tokens/verify`]: INVALID, "/user/tokens/verify": INVALID, [WORKER]: DENIED });
    expect(await cf.check()).toBe(UNKNOWN);
    expect(cf.calls).toEqual([`${ACC}/tokens/verify`, "/user/tokens/verify"]);
  });

  test("a token that Cloudflare knows, which may not read the Worker: a 401 there is not 'unknown'", async () => {
    for (const status of [401, 403]) {
      const cf = cloudflare({ [`${ACC}/tokens/verify`]: verified("active"), [WORKER]: { ...DENIED, status } });
      expect(await cf.check()).toBe(
        `Cloudflare knows this token, but the token can't read the Worker erga-next of the account ${FLEET_ACCOUNT} (Cloudflare answered ${status}). Give it that Worker, with the role Editor.`
      );
    }
  });

  test("a user's token is not an account's: it verifies at the user, and is taken as an account's is", async () => {
    const cf = cloudflare({ [`${ACC}/tokens/verify`]: INVALID, "/user/tokens/verify": verified("active"), [WORKER]: OK, ...REST });
    expect(await cf.check()).toBeNull();
    expect(cf.calls.slice(0, 3)).toEqual([`${ACC}/tokens/verify`, "/user/tokens/verify", WORKER]);
  });

  test("a token that Cloudflare knows, but that is not active, is refused with Cloudflare's word", async () => {
    const cf = cloudflare({ [`${ACC}/tokens/verify`]: verified("expired") });
    expect(await cf.check()).toBe("Cloudflare knows this token, but it is expired. Make a new one.");
  });
});

describe("the deployer's fetch handler, as its instance calls it", () => {
  /** The deployer, with the mock Cloudflare as its network and its real store on a Map. */
  async function installed() {
    const { mock } = await account();
    const store = storeBinding();
    const env = { ...WHERE, KEY, STATE: store } as unknown as Env;
    const worker = deployer({ fetch: mock.fetch, now: () => 0, sleep: async () => {}, version: "111111111111" });
    const ask = async (token?: string) =>
      (await (
        await worker.fetch(new Request("https://deployer/", token == null ? {} : { method: "POST", body: token }), env)
      ).json()) as DeployerAnswer;
    return { mock, store, ask, sealed: () => (store.cell.has("token") ? (JSON.parse(store.cell.get("token")!) as string) : null) };
  }

  test("it holds no token at first; a token that the check refuses changes nothing; a good one is kept, sealed under its own secret", async () => {
    const { store, ask, sealed } = await installed();
    // (Its answer says the release that its code is of, and that it never gave itself newer code.)
    const none = { ok: true as const, ready: false, head: null, version: "111111111111", renewed: null };
    expect(await ask()).toEqual(none);
    expect(await ask("mock-deployer-token")).toEqual({ ok: false, why: D1 });
    expect([await ask(), sealed()]).toEqual([none, null]);

    // (The instance sends the token as the person pasted it: the space around it is not the token's.)
    expect(await ask(`  ${GOOD}\n`)).toEqual({ ...none, ready: true });
    expect(await ask()).toEqual({ ...none, ready: true });
    // The store never holds the token in the clear, and only the deployer's own secret opens it.
    expect([...store.cell.values()].join("\n")).not.toContain(GOOD);
    expect([await open(KEY, sealed()), await open("another-secret", sealed())]).toEqual([GOOD, null]);

    // Another token takes the same way, and the place of the first one. A refused one leaves the one that is there.
    const first = sealed();
    expect(await ask("mock-only-erga-000")).toMatchObject({ ok: false });
    expect(sealed()).toBe(first);
    expect(await ask(GOOD)).toMatchObject({ ok: true, ready: true });
    expect(sealed()).not.toBe(first);
    expect(await open(KEY, sealed())).toBe(GOOD);
  });

  test("the answer says the head of the last look; a run that ends while a token comes does not lose the token", async () => {
    const { store, ask, sealed } = await installed();
    const object = store.get("state");
    const tell = (body: object) => object.fetch("https://state/", { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
    // A run takes the lock, and holds the state as it read it.
    const state = (await tell({ take: 1 })) as { lock?: number; head?: string };
    // The token comes while the run goes on. Then the run ends, and writes its state whole.
    expect(await ask(GOOD)).toMatchObject({ ok: true, ready: true });
    await tell({ put: { ...state, head: "a".repeat(40) } });
    expect(await open(KEY, sealed())).toBe(GOOD);
    expect(await ask()).toMatchObject({ ok: true, ready: true, head: "a".repeat(40) });
  });
});

describe("the person's own login, in a setup that takes long", () => {
  // What the setup of staging showed on 2026-11-20: Cloudflare's 401 [code 10000] to "list your Workers", a call with
  // the person's own login, which the setup had read at its start.
  test("a login that ends while the setup runs is read again", async () => {
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
    await list();
    expect(reads).toEqual(["mock-login-1", "mock-login-2"]);
    // With the login as it was at the start, Cloudflare says no.
    expect(
      await new Cloudflare("mock-login-1", net)
        .call("GET", `/accounts/${FLEET_ACCOUNT}/workers/scripts`, "list your Workers")
        .catch((e: Error) => e.message)
    ).toBe(
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
