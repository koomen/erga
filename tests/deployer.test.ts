// The deployer's core (deploy/deployer/deploy.ts): deploy(spec, release, ports) with the code steps only. On
// Cloudflare, against the mock Cloudflare (dev/mock-cloudflare.ts) and a clock of the test's own: an instance that
// setup's pipeline made gets a new release, and the deploy makes none of the shape's calls. On AWS, against a fake of
// its four calls. The branch's commits: a port of the test's, and GitHub's answers as a fetch of the test's. Nothing
// real is touched: no network, no credential, no wait.

import { beforeAll, describe, expect, test } from "bun:test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { AwsApi } from "../deploy/deployer/aws";
import { Cloudflare, DeployError, type Fetch } from "../deploy/deployer/cloudflare-api";
import { deploy, type Ports } from "../deploy/deployer/deploy";
import { onBranchAtGitHub, TryLater } from "../deploy/deployer/github";
import type { Release } from "../deploy/deployer/release-format";
import { decodeSpec, type Spec } from "../deploy/deployer/spec";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { bindingsOf, bootstrap, databaseOf, nextSecrets, prepareRelease, release, SHA1, SHA2, SHA3, testClock } from "./helpers/deploys.ts";

beforeAll(prepareRelease, 120_000);

/** The parts of a spec that a deploy does not read. */
const OF = { repo: "github.com/example/erga", branch: "main", secrets: [] };

/** Runs a deploy on the test's clock: its log, and its failure (null: it deployed). With no `onBranch`, the branch has the commit. */
async function run(spec: Spec, rel: Release, ports: Partial<Omit<Ports, "log">>, clock = testClock()) {
  const log: string[] = [];
  const all: Ports = { onBranch: () => Effect.succeed(true), ...ports, log: (line) => log.push(line) };
  const failed = await Effect.runPromise(
    Effect.provideService(deploy(spec, rel, all), Clock.Clock, clock.clock).pipe(
      Effect.match({ onSuccess: () => null, onFailure: (e) => e })
    )
  );
  return { log, failed };
}

const version = (sha: string) => sha.slice(0, 12);

describe("on Cloudflare", () => {
  /** The second instance of the mock's account (next.example.com), as its spec names it. */
  const spec: Spec = {
    ...OF,
    target: {
      kind: "cloudflare",
      account: FLEET_ACCOUNT,
      worker: "erga-next",
      database: "erga-next",
      app: { kind: "domain", zoneName: "example.com", hostname: "next.example.com" },
      pages: { kind: "zone", zoneName: "example-pages-next.com", domain: "example-pages-next.com" },
    },
    settings: { GITHUB_CLIENT_ID: "Ov23next" },
  };
  /** The instance as setup's pipeline made it (release SHA1), and the API as a deploy calls it. */
  async function instance() {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const clock = testClock();
    mock.state.now = clock.now;
    return { mock, clock, cf: new Cloudflare("mock-deployer-token", mock.fetch), from: mock.state.calls.length };
  }
  /** Each call's method and path, with ids as "*": one line for each kind of call. */
  const kinds = (calls: string[]) =>
    [
      ...new Set(
        calls.map((c) =>
          c
            .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "*")
            .replace(/upload\/[0-9a-f]{32}/, "upload/*")
            .replace(/\?.*$/, "")
        )
      ),
    ].sort();

  test("a new release on an instance that runs: the four code steps, and no call but theirs", async () => {
    expect(Effect.runSync(decodeSpec(spec))).toEqual(spec);
    const { mock, clock, cf, from } = await instance();
    const before = bindingsOf(mock.state, "erga-next");
    const database = databaseOf(mock.state, "erga-next").uuid;
    const { log, failed } = await run(spec, { ...release, version: version(SHA2) }, { cloudflare: cf }, clock);
    expect(failed).toBeNull();
    expect(log.map((l) => l.replace(/: done.*$/, ": done"))).toEqual([
      "Set up the database's tables...",
      "Set up the database's tables: done",
      "Upload the editor's files...",
      "Upload the editor's files: done",
      "Upload the Worker, with its settings and secrets...",
      "Upload the Worker, with its settings and secrets: done",
      "Wait for its health...",
      "Wait for its health: done",
    ]);
    expect(log[1]).toContain(`already up to date; restore point: version `);
    expect(log[1]).toContain(`(release ${version(SHA1)})`);
    expect(log.at(-1)).toBe(`Wait for its health: done, release ${version(SHA2)}, healthy (db ok 1 ms, documents ok 2 ms)`);
    // The Worker runs the new release on the database it had; its settings are the spec's; its secrets stay.
    const now = bindingsOf(mock.state, "erga-next");
    expect(now.ERGA_VERSION.text).toBe(version(SHA2));
    expect(now.DB.database_id).toBe(database);
    expect(now.GITHUB_CLIENT_ID.text).toBe("Ov23next");
    expect(now.PAGES_DOMAIN.text).toBe("example-pages-next.com");
    expect(now.ERGA_DEPLOY.text).toBe(before.ERGA_DEPLOY.text);
    expect(mock.state.secrets["erga-next"]).toMatchObject(nextSecrets);
    // Every call is one of the code steps': none reads or changes the account, a zone, a domain, a route or a bucket,
    // and none makes a database.
    const acc = `/accounts/${FLEET_ACCOUNT}`;
    expect(kinds(mock.state.calls.slice(from))).toEqual(
      [
        `GET ${acc}/d1/database/*/time_travel/bookmark`,
        `GET ${acc}/workers/scripts/erga-next/deployments`,
        `GET ${acc}/workers/scripts/erga-next/settings`,
        `GET ${acc}/workers/scripts/erga-next/versions/*`,
        `POST ${acc}/d1/database/*/query`,
        `POST ${acc}/workers/scripts/erga-next/assets-upload-session`,
        `PUT ${acc}/workers/scripts/erga-next`,
        `PUT ${acc}/workers/scripts/erga-next/schedules`,
      ].sort()
    );
  });

  test("the release that runs, deployed again with a setting that stops the server: its old health row does not count, and it goes back", async () => {
    const { mock, clock, cf } = await instance();
    const again = { ...release, version: version(SHA1) };
    // The same release, with the same settings: the server writes a new row, and the deploy is healthy.
    expect((await run(spec, again, { cloudflare: cf }, clock)).failed).toBeNull();
    const before = mock.state.deployments["erga-next"][0].id;
    // With a setting that stops the server as it starts, it writes no row. The row that the version before wrote is
    // of the same release, and fresh: it is not this deploy's.
    mock.state.silent = [version(SHA1)];
    const bad = { ...spec, settings: { ...spec.settings, SERVER_CONFIG: "{" } };
    const { failed, log } = await run(bad, again, { cloudflare: cf }, clock);
    expect(failed?.message).toContain("is deployed to erga-next, but it wrote no health row in 3 minutes");
    expect(failed?.message).toContain("It is rolled back to ");
    expect(log.at(-1)).toContain("which ran before.");
    // The version before serves again, with its own settings.
    expect(bindingsOf(mock.state, "erga-next").SERVER_CONFIG.text).toBe("");
    expect(mock.state.deployments["erga-next"][0].id).not.toBe(before);
  });

  test("an unhealthy release goes back to the version before, by itself, and the deploy fails with that", async () => {
    const { mock, clock, cf } = await instance();
    mock.state.unhealthy = [version(SHA3)];
    const started = clock.now();
    const { log, failed } = await run(spec, { ...release, version: version(SHA3) }, { cloudflare: cf }, clock);
    expect(failed).toBeInstanceOf(DeployError);
    expect(failed!.message).toMatch(
      new RegExp(
        `^Release ${version(SHA3)} is deployed to erga-next, but its health check fails: documents: a document didn't open .* It is rolled back to [0-9a-f-]{36}, which ran before\\.$`
      )
    );
    expect(log.at(-1)).toMatch(/It goes back to [0-9a-f-]{36}, which ran before\.$/);
    expect(log).not.toContain("Wait for its health: done");
    // It waited three minutes of the clock's time for a healthy row, then the Worker serves the release before again.
    expect(clock.now() - started).toBeGreaterThanOrEqual(180_000);
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(version(SHA1));
    expect(mock.state.calls.at(-1)).toBe(`POST /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-next/deployments?force=true`);
  });

  test("an instance that setup did not make: the deploy stops, and changes nothing", async () => {
    const { mock, cf, from } = await instance();
    const none = { ...spec, target: { ...spec.target, worker: "erga-none" } } as Spec;
    const { log, failed } = await run(none, release, { cloudflare: cf });
    expect(failed?.message).toContain("The Worker erga-none is not there, or it has no database");
    expect(log).toEqual(["Set up the database's tables..."]);
    expect(mock.state.calls.slice(from)).toEqual([`GET /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-none/settings`]);
  });

  test("a release with a binding that the steps can't make, or a deploy with no API for its cloud: no call at all", async () => {
    const { mock, cf, from } = await instance();
    const env = { ...release.worker.env, QUEUE: { type: "queue" } };
    const odd = await run(spec, { ...release, worker: { ...release.worker, env }, bindings: {} }, { cloudflare: cf });
    expect(odd.failed?.message).toContain("QUEUE (queue)");
    const wrong = await run(spec, release, { aws: {} as AwsApi });
    expect(wrong.failed?.message).toBe("The instance is on Cloudflare, and this deploy has no Cloudflare API.");
    expect([...odd.log, ...wrong.log]).toEqual([]);
    expect(mock.state.calls.slice(from)).toEqual([]);
  });
});

describe("on AWS", () => {
  const spec: Spec = {
    ...OF,
    target: {
      kind: "aws",
      account: "123456789012",
      region: "us-east-1",
      stack: "erga-example",
      bucket: "erga-example-bucket",
      machine: "i-0123456789abcdef0",
      app: "erga.example.com",
      pages: { kind: "domain", domain: "pages.example.com" },
    },
    settings: {},
  };
  const rel = { version: "bbbbbbbbbbbb" } as Release;
  /**
   * AWS's calls, as a machine that ran `ran` answers them; `sick`: the releases that do not get healthy. `noBack`: the
   * way back does not get healthy either. `noLive`: the parameter's write fails.
   */
  function fake(ran: string[], sick: string[] = [], o: { noBack?: boolean; noLive?: boolean } = {}) {
    const calls: string[] = [];
    const put: { vars?: Record<string, string> } = {};
    const aws: AwsApi = {
      putRelease: (r, vars) => Effect.sync(() => (calls.push(`put ${r.version}`), (put.vars = vars), 9_400_000)),
      deployed: Effect.sync(() => (calls.push("deployed"), ran)),
      load: (v) =>
        Effect.suspend(() => {
          calls.push(`load ${v}`);
          return sick.includes(v)
            ? Effect.fail(new DeployError({ message: `on the machine (Failed): release ${v} is not healthy` }))
            : Effect.succeed(`deployed\nruns ${v}`);
        }),
      back: Effect.suspend(() => {
        calls.push("back");
        return o.noBack
          ? Effect.fail(new DeployError({ message: `on the machine (Failed): release ${ran.at(-1)} is not healthy` }))
          : Effect.succeed(`runs ${ran.at(-1)}`);
      }),
      setLive: (v) =>
        Effect.suspend(() => {
          calls.push(`live ${v}`);
          return o.noLive ? Effect.fail(new DeployError({ message: "AWS refused to write which release runs." })) : Effect.void;
        }),
    };
    return { aws, calls, put };
  }

  test("the release goes into the bucket, the machine loads it, and the parameter says that it runs", async () => {
    expect(Effect.runSync(decodeSpec(spec))).toEqual(spec);
    const { aws, calls, put } = fake(["aaaaaaaaaaaa"]);
    const { log, failed } = await run({ ...spec, settings: { GITHUB_CLIENT_ID: "Ov23aws" } }, rel, { aws });
    expect(failed).toBeNull();
    expect(calls).toEqual(["put bbbbbbbbbbbb", "deployed", "load bbbbbbbbbbbb", "live bbbbbbbbbbbb"]);
    // The release goes in with the Worker's plain settings: the spec's, and the deploy's own. The facts are the target's.
    const { kind: _, ...facts } = spec.target;
    expect(put.vars).toEqual({
      GITHUB_CLIENT_ID: "Ov23aws",
      ERGA_VERSION: "bbbbbbbbbbbb",
      ERGA_DEPLOY: JSON.stringify({ aws: facts, vars: { GITHUB_CLIENT_ID: "Ov23aws" } }),
      PAGES_DOMAIN: "pages.example.com",
      ERGA_CHROME: "http://127.0.0.1:9222",
    });
    expect(log).toEqual([
      "Put the release in the bucket...",
      "Put the release in the bucket: done, release bbbbbbbbbbbb is in the bucket erga-example-bucket (9.4 MB)",
      "Load it on the machine: the migrations, then the Worker...",
      "Load it on the machine: the migrations, then the Worker: done, i-0123456789abcdef0: runs bbbbbbbbbbbb (it ran aaaaaaaaaaaa)",
      "Record its health...",
      "Record its health: done, release bbbbbbbbbbbb, healthy on the machine's own check",
    ]);
  });

  test("a release that does not get healthy: the machine loads again what its last healthy load ran, and the parameter stays", async () => {
    const { aws, calls } = fake(["9999999999999", "aaaaaaaaaaaa"], ["bbbbbbbbbbbb"]);
    const { log, failed } = await run(spec, rel, { aws });
    expect(calls).toEqual(["put bbbbbbbbbbbb", "deployed", "load bbbbbbbbbbbb", "back"]);
    expect(failed?.message).toBe(
      "on the machine (Failed): release bbbbbbbbbbbb is not healthy It is rolled back to aaaaaaaaaaaa, which ran before."
    );
    expect(log.at(-1)).toBe("on the machine (Failed): release bbbbbbbbbbbb is not healthy It goes back to aaaaaaaaaaaa, which ran before.");
  });

  test("the same release again, with settings that stop it: the way back is the same release, as it ran before", async () => {
    // (The bucket has only this deploy's object of that name: the machine goes back to what it kept, never to the bucket's.)
    const again = fake(["aaaaaaaaaaaa", "bbbbbbbbbbbb"], ["bbbbbbbbbbbb"]);
    expect((await run(spec, rel, { aws: again.aws })).failed?.message).toBe(
      "on the machine (Failed): release bbbbbbbbbbbb is not healthy It is rolled back to bbbbbbbbbbbb, which ran before."
    );
    expect(again.calls).toEqual(["put bbbbbbbbbbbb", "deployed", "load bbbbbbbbbbbb", "back"]);
    // The first release of a machine: a failure loads nothing else.
    const first = fake([], ["bbbbbbbbbbbb"]);
    expect((await run(spec, rel, { aws: first.aws })).failed?.message).toBe("on the machine (Failed): release bbbbbbbbbbbb is not healthy");
    expect(first.calls).toEqual(["put bbbbbbbbbbbb", "deployed", "load bbbbbbbbbbbb"]);
    // The way back fails too: the deploy says both.
    const { aws } = fake(["aaaaaaaaaaaa"], ["bbbbbbbbbbbb"], { noBack: true });
    expect((await run(spec, rel, { aws })).failed?.message).toBe(
      "on the machine (Failed): release bbbbbbbbbbbb is not healthy The rollback to aaaaaaaaaaaa failed too: on the machine (Failed): release aaaaaaaaaaaa is not healthy"
    );
  });

  test("a healthy load whose record fails: the release before comes from the bucket; the same release stays", async () => {
    // The machine keeps this deploy's release now: its way back would load this one again.
    const other = fake(["aaaaaaaaaaaa"], [], { noLive: true });
    expect((await run(spec, rel, { aws: other.aws })).failed?.message).toBe(
      "AWS refused to write which release runs. It is rolled back to aaaaaaaaaaaa, which ran before."
    );
    expect(other.calls).toEqual(["put bbbbbbbbbbbb", "deployed", "load bbbbbbbbbbbb", "live bbbbbbbbbbbb", "load aaaaaaaaaaaa"]);
    const same = fake(["bbbbbbbbbbbb"], [], { noLive: true });
    expect((await run(spec, rel, { aws: same.aws })).failed?.message).toBe("AWS refused to write which release runs.");
    expect(same.calls).toEqual(["put bbbbbbbbbbbb", "deployed", "load bbbbbbbbbbbb", "live bbbbbbbbbbbb"]);
  });

  test("a release whose commit is not on the spec's branch is refused before any step; no answer is not a refusal", async () => {
    const { aws, calls } = fake(["aaaaaaaaaaaa"]);
    const asked: string[] = [];
    const no = await run(spec, rel, { aws, onBranch: (v) => Effect.sync(() => (asked.push(v), false)) });
    expect(no.failed?.message).toBe(
      "Release bbbbbbbbbbbb is not a commit of main on github.com/example/erga: the instance deploys only a commit of that branch."
    );
    expect(no.failed).not.toBeInstanceOf(TryLater);
    expect(asked).toEqual(["bbbbbbbbbbbb"]);
    const later = await run(spec, rel, { aws, onBranch: () => Effect.fail(new TryLater({ message: "GitHub did not say." })) });
    expect(later.failed).toBeInstanceOf(TryLater);
    expect([...no.log, ...later.log, ...calls]).toEqual([]);
  });
});

describe("the branch's commits, as GitHub says them", () => {
  const COMMIT = "bbbbbbbbbbbb0123456789abcdef0123456789ab";
  const of = { repo: "github.com/Example/erga", branch: "release/1.x" };
  /** GitHub, as a fetch that answers each call with `status` and `body`: the calls it got. */
  function github(status: number, body: unknown = {}) {
    const calls: { url: string; headers: unknown }[] = [];
    const fetch: Fetch = async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers });
      if (status == 0) throw new Error("no network");
      return new Response(typeof body == "string" ? body : JSON.stringify(body), { status });
    };
    return { fetch, calls };
  }
  /** The port's answer for the release "bbbbbbbbbbbb": true or false, or its failure. */
  const ask = (fetch: Fetch, commit = COMMIT, version = "bbbbbbbbbbbb") =>
    Effect.runPromise(Effect.match(onBranchAtGitHub(fetch, of, commit)(version), { onSuccess: (on) => on, onFailure: (e) => e }));

  test("one call with no credential: the branch has the commit when it is not ahead of the branch", async () => {
    const has = github(200, { status: "behind", ahead_by: 0, behind_by: 15 });
    expect(await ask(has.fetch)).toBe(true);
    expect(has.calls).toEqual([
      {
        url: `https://api.github.com/repos/Example/erga/compare/release/1.x...${COMMIT}?per_page=1`,
        headers: { Accept: "application/vnd.github+json", "User-Agent": "erga-deployer" },
      },
    ]);
    expect(await ask(github(200, { status: "identical", ahead_by: 0, behind_by: 0 }).fetch)).toBe(true);
    // A commit of another branch (as verify's), and a commit or a branch that the repository has not.
    expect(await ask(github(200, { status: "diverged", ahead_by: 2, behind_by: 1 }).fetch)).toBe(false);
    expect(await ask(github(404, { message: "Not Found" }).fetch)).toBe(false);
  });

  test("GitHub's limit, its failure or no network is TryLater, never a refusal; another answer is an error", async () => {
    for (const status of [403, 429, 500, 503, 0]) {
      const later = await ask(github(status, { message: "API rate limit exceeded" }).fetch);
      expect([status, later instanceof TryLater]).toEqual([status, true]);
    }
    expect(await ask(github(200, "<html>").fetch)).toBeInstanceOf(TryLater);
    for (const g of [github(200, { status: "behind" }), github(301), github(422)]) {
      const odd = await ask(g.fetch);
      expect(odd).toBeInstanceOf(DeployError);
      expect(odd).not.toBeInstanceOf(TryLater);
    }
  });

  test("a short name, or a release that is not the tag's commit, makes no call", async () => {
    const g = github(200, { ahead_by: 0 });
    expect(((await ask(g.fetch, "bbbbbbbbbbbb")) as DeployError).message).toBe(
      '"bbbbbbbbbbbb" is not a commit\'s full name (40 hex characters).'
    );
    expect(await ask(g.fetch, "main")).toBeInstanceOf(DeployError);
    expect(((await ask(g.fetch, COMMIT, "aaaaaaaaaaaa")) as DeployError).message).toBe(
      `The release says that it is aaaaaaaaaaaa, and its tag is the commit ${COMMIT}.`
    );
    expect(await ask(g.fetch, COMMIT, "bbbb")).toBeInstanceOf(DeployError);
    expect(g.calls).toEqual([]);
  });
});
