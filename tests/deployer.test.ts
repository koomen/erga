// The deployer's core (deploy/deployer/deploy.ts): deploy(spec, release, ports) with the code steps only. On
// Cloudflare, against the mock Cloudflare (dev/mock-cloudflare.ts) and a clock of the test's own: an instance that
// setup's pipeline made gets a new release, and the deploy makes none of the shape's calls. On AWS, against a fake of
// its four calls. Nothing real is touched: no network, no credential, no wait.

import { beforeAll, describe, expect, test } from "bun:test";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { AwsApi } from "../deploy/deployer/aws";
import { Cloudflare, DeployError } from "../deploy/deployer/cloudflare-api";
import { deploy } from "../deploy/deployer/deploy";
import type { Release } from "../deploy/deployer/release-format";
import { decodeSpec, type Spec } from "../deploy/deployer/spec";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { bindingsOf, bootstrap, databaseOf, nextSecrets, prepareRelease, release, SHA1, SHA2, SHA3 } from "./helpers/deploys.ts";

beforeAll(prepareRelease, 120_000);

/** The parts of a spec that a deploy does not read. */
const OF = { repo: "github.com/example/erga", branch: "main", secrets: [] };

/** A clock of the test's own: a sleep ends at once, and moves its time on. */
function testClock() {
  let now = Date.now();
  const nanos = () => BigInt(now) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (d) => Effect.sync(() => void (now += Duration.toMillis(d))),
  };
  return { clock, now: () => now };
}

/** Runs a deploy on the test's clock: its log, and its failure (null: it deployed). */
async function run(spec: Spec, rel: Release, ports: { cloudflare?: Cloudflare; aws?: AwsApi }, clock = testClock()) {
  const log: string[] = [];
  const failed = await Effect.runPromise(
    Effect.provideService(deploy(spec, rel, { ...ports, log: (line) => log.push(line) }), Clock.Clock, clock.clock).pipe(
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
  /** AWS's four calls, as a machine that ran `ran` answers them; `sick`: the releases that do not get healthy. */
  function fake(ran: string[], sick: string[] = []) {
    const calls: string[] = [];
    const aws: AwsApi = {
      putRelease: (r) => Effect.sync(() => (calls.push(`put ${r.version}`), 9_400_000)),
      deployed: Effect.sync(() => (calls.push("deployed"), ran)),
      load: (v) =>
        Effect.suspend(() => {
          calls.push(`load ${v}`);
          return sick.includes(v)
            ? Effect.fail(new DeployError({ message: `on the machine (Failed): release ${v} is not healthy` }))
            : Effect.succeed(`deployed\nruns ${v}`);
        }),
      setLive: (v) => Effect.sync(() => void calls.push(`live ${v}`)),
    };
    return { aws, calls };
  }

  test("the release goes into the bucket, the machine loads it, and the parameter says that it runs", async () => {
    expect(Effect.runSync(decodeSpec(spec))).toEqual(spec);
    const { aws, calls } = fake(["aaaaaaaaaaaa"]);
    const { log, failed } = await run(spec, rel, { aws });
    expect(failed).toBeNull();
    expect(calls).toEqual(["put bbbbbbbbbbbb", "deployed", "load bbbbbbbbbbbb", "live bbbbbbbbbbbb"]);
    expect(log).toEqual([
      "Put the release in the bucket...",
      "Put the release in the bucket: done, release bbbbbbbbbbbb is in the bucket erga-example-bucket (9.4 MB)",
      "Load it on the machine: the migrations, then the Worker...",
      "Load it on the machine: the migrations, then the Worker: done, i-0123456789abcdef0: runs bbbbbbbbbbbb (it ran aaaaaaaaaaaa)",
      "Record its health...",
      "Record its health: done, release bbbbbbbbbbbb, healthy on the machine's own check",
    ]);
  });

  test("a release that does not get healthy: the machine loads the release before again, and the parameter stays", async () => {
    const { aws, calls } = fake(["9999999999999", "aaaaaaaaaaaa"], ["bbbbbbbbbbbb"]);
    const { log, failed } = await run(spec, rel, { aws });
    expect(calls).toEqual(["put bbbbbbbbbbbb", "deployed", "load bbbbbbbbbbbb", "load aaaaaaaaaaaa"]);
    expect(failed?.message).toBe(
      "on the machine (Failed): release bbbbbbbbbbbb is not healthy It is rolled back to aaaaaaaaaaaa, which ran before."
    );
    expect(log.at(-1)).toBe("on the machine (Failed): release bbbbbbbbbbbb is not healthy It goes back to aaaaaaaaaaaa, which ran before.");
  });

  test("with no release before it (the first one, or the same one again), a failure loads nothing else", async () => {
    for (const ran of [[], ["bbbbbbbbbbbb"]]) {
      const { aws, calls } = fake(ran, ["bbbbbbbbbbbb"]);
      const { failed } = await run(spec, rel, { aws });
      expect(calls).toEqual(["put bbbbbbbbbbbb", "deployed", "load bbbbbbbbbbbb"]);
      expect(failed?.message).toBe("on the machine (Failed): release bbbbbbbbbbbb is not healthy");
    }
    // The way back fails too: the deploy says both.
    const { aws } = fake(["aaaaaaaaaaaa"], ["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
    expect((await run(spec, rel, { aws })).failed?.message).toBe(
      "on the machine (Failed): release bbbbbbbbbbbb is not healthy The rollback to aaaaaaaaaaaa failed too: on the machine (Failed): release aaaaaaaaaaaa is not healthy"
    );
  });
});
