// The deployer's look, each minute (deploy/deployer/look.ts), and the Worker that runs it on Cloudflare
// (deploy/deployer/worker.ts). Against a pretend GitHub (its list of refs, its feed of commits, its registry), a real
// SQLite with the migrations' own tables, the mock Cloudflare (dev/mock-cloudflare.ts) and a clock of the test's own.
// Nothing real is touched: no network, no credential, no wait.

import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { d1Sql } from "../deploy/deployer/cloudflare";
import { Cloudflare, DeployError, type Fetch } from "../deploy/deployer/cloudflare-api";
import { readControl } from "../deploy/deployer/control";
import { commitsAtGitHub, headAtGitHub, TryLater } from "../deploy/deployer/github";
import { LEASE_MS, NoTable, openJob, readJobs, readLog, type Sql, writeSpec } from "../deploy/deployer/instance";
import { due, look, type LookPorts } from "../deploy/deployer/look";
import type { Spec } from "../deploy/deployer/spec";
import { deployer } from "../deploy/deployer/worker";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { bindingsOf, bootstrap, prepareRelease, ROOT, SHA1, SHA2, SHA3, testClock } from "./helpers/deploys.ts";
import { builtBundle, bundleOf, github, pkt } from "./helpers/github.ts";

beforeAll(prepareRelease, 120_000);

const run = Effect.runPromise;
const short = (sha: string) => sha.slice(0, 12);

const MIGRATIONS = ["0470_deploys.sql", "0480_deploy_control.sql"].map((name) =>
  readFileSync(new URL(`../server/migrations/${name}`, import.meta.url), "utf8")
);

/** An instance's database, with the tables of its deploys (`tables: false`: one from before them). */
function database(o: { tables?: boolean } = {}) {
  const db = new Database(":memory:");
  if (o.tables !== false) for (const m of MIGRATIONS) db.exec(m);
  const sql: Sql = (text, params) =>
    Effect.try({
      try: () =>
        db
          .query(text)
          .all(...params)
          .map((r) => String(Object.values(r as object)[0])),
      catch: (e) => (/no such table/.test((e as Error).message) ? new NoTable() : new DeployError({ message: (e as Error).message })),
    });
  return { db, sql };
}

const SPEC: Spec = {
  repo: "github.com/example/erga",
  branch: "main",
  target: {
    kind: "cloudflare",
    account: FLEET_ACCOUNT,
    worker: "erga-next",
    database: "erga-next",
    app: { kind: "domain", zoneName: "example.com", hostname: "next.example.com" },
    pages: { kind: "zone", zoneName: "example-pages-next.com", domain: "example-pages-next.com" },
  },
  settings: { GITHUB_CLIENT_ID: "Ov23next" },
  secrets: [],
};

/** A job's whole log. */
async function logOf(sql: Sql, id: number) {
  const parts: Uint8Array[] = [];
  const size = () => parts.reduce((n, p) => n + p.length, 0);
  for (let part = await run(readLog(sql, id, 0)); part.length; part = await run(readLog(sql, id, size()))) parts.push(part);
  return Buffer.concat(parts).toString("utf8");
}

describe("a look", () => {
  /** An instance with its spec and no Cloudflare behind it: a deploy that starts fails at once, in its job. */
  async function instance(o: { auto?: boolean; shas?: string[] } = {}) {
    const { db, sql } = database();
    await run(writeSpec(sql, SPEC));
    if (o.auto !== false) db.run("INSERT INTO deploy_control (id, auto) VALUES (1, 1)");
    const hub = github(o.shas);
    const clock = testClock();
    const ports: LookPorts = { sql, fetch: hub.fetch, cloud: {}, mine: () => true };
    /** One look, a minute after the one before: its line, and GitHub's calls in it. */
    const once = async (over: Partial<LookPorts> = {}) => {
      const from = hub.state.calls.length;
      await run(Effect.provideService(Effect.sleep(60_000), Clock.Clock, clock.clock));
      const line = await run(Effect.provideService(look({ ...ports, ...over }), Clock.Clock, clock.clock));
      return { line, calls: hub.state.calls.slice(from) };
    };
    const row = () => db.query("SELECT auto, looked, head, error FROM deploy_control").get() as Record<string, unknown> | null;
    const releases = async () => ((await run(readControl(sql)))?.commits ?? []).map((c) => `${short(c.sha)} ${c.release}`);
    return { db, sql, hub, clock, once, row, releases };
  }

  test("with auto-deploy off, it writes what GitHub has on the instance, and deploys nothing", async () => {
    const { sql, hub, clock, once, row } = await instance({ auto: false });
    hub.state.commits[0].title = "Tabs & <b>'more'</b>  spaces";
    hub.state.releases.set(SHA2, bundleOf(SHA2));
    const first = await once();
    expect(first.line).toBe(`main on github.com/example/erga is at ${short(SHA2)}. Auto-deploy is off.`);
    // Each commit's release is asked one time; the bundle is never fetched.
    expect(first.calls).toEqual(["refs", "feed", `manifest ${short(SHA2)}`, `manifest ${short(SHA1)}`]);
    expect(row()).toEqual({ auto: 0, looked: clock.now(), head: SHA2, error: null });
    expect((await run(readControl(sql)))?.commits).toEqual([
      { sha: SHA2, title: "Tabs & <b>'more'</b> spaces", at: Date.parse("2026-11-19T10:00:00Z"), release: "released" },
      { sha: SHA1, title: `Commit ${short(SHA1)}`, at: Date.parse("2026-11-19T09:59:00Z"), release: "none" },
    ]);
    // The next look: the head is the same, so GitHub's refs are all that it reads. Its time is new.
    const second = await once();
    expect(second.calls).toEqual(["refs"]);
    expect(row()?.looked).toBe(clock.now());
    expect(await run(readJobs(sql))).toEqual([]);
  });

  test("a head with no release yet waits, with no job; its release deploys one time, and a failed head is not tried again", async () => {
    const { sql, hub, once, releases } = await instance();
    const wait = await once();
    expect(wait.line).toBe(`main on github.com/example/erga is at ${short(SHA2)}. GitHub has no release of it yet: the look waits.`);
    expect(wait.calls).toEqual(["refs", "feed", `manifest ${short(SHA2)}`, `manifest ${short(SHA1)}`]);
    // Each minute it asks for the head's release again, and only for the head's.
    expect((await once()).calls).toEqual(["refs", `manifest ${short(SHA2)}`]);
    expect(await run(readJobs(sql))).toEqual([]);

    // GitHub's workflow ends: the release is there. The look takes the lock, fetches the bundle and deploys. This
    // deployer has no Cloudflare API, so the deploy fails, in its job.
    hub.state.releases.set(SHA2, bundleOf(SHA2));
    const tried = await once();
    expect(tried.calls).toEqual(["refs", `manifest ${short(SHA2)}`, `manifest ${short(SHA2)}`, `bundle ${short(SHA2)}`]);
    expect(tried.line).toBe(
      `main on github.com/example/erga is at ${short(SHA2)}. Its deploy failed: The instance is on Cloudflare, and this deploy has no Cloudflare API.`
    );
    expect(await releases()).toEqual([`${short(SHA2)} released`, `${short(SHA1)} none`]);
    const [job] = await run(readJobs(sql));
    expect(job).toMatchObject({
      kind: "deploy",
      command: `deploy ${SHA2}`,
      source: "auto-deploy",
      sha: SHA2,
      state: { at: "failed", why: "The instance is on Cloudflare, and this deploy has no Cloudflare API." },
    });
    expect(await logOf(sql, job.id)).toBe(
      `main on github.com/example/erga is at ${short(SHA2)}: auto-deploy deploys its release.\nThe instance is on Cloudflare, and this deploy has no Cloudflare API.\n`
    );

    // A commit is tried one time: the next look fetches nothing and starts no job.
    const after = await once();
    expect(after.calls).toEqual(["refs"]);
    expect(after.line).toContain(`A job of the instance has ${short(SHA2)} and did not end well: a commit is tried one time.`);
    expect(await run(readJobs(sql))).toHaveLength(1);

    // A new commit on the branch starts it again. The feed is read again, and only the new commit's release is asked.
    hub.state.commits.unshift({ sha: SHA3, title: "The next commit", at: Date.parse("2026-11-19T10:05:00Z") });
    const next = await once();
    expect(next.calls).toEqual(["refs", "feed", `manifest ${short(SHA3)}`]);
    expect(await releases()).toEqual([`${short(SHA3)} none`, `${short(SHA2)} released`, `${short(SHA1)} none`]);
  });

  test("a bundle that is not the one its manifest names fails in the job, and is not fetched again", async () => {
    const { sql, hub, once } = await instance();
    hub.state.releases.set(SHA2, bundleOf(SHA2));
    hub.state.served = bundleOf(SHA3);
    const tried = await once();
    expect(tried.line).toContain("Its deploy failed: The bundle of ghcr.io/example/erga:");
    expect(tried.line).toContain("It is not deployed.");
    const [job] = await run(readJobs(sql));
    expect(job.state.at).toBe("failed");
    expect(await logOf(sql, job.id)).toContain("is not the one that its manifest names");
    expect((await once()).calls).toEqual(["refs"]);
  });

  test("what the registry has for the head is not a release: written one time, never deployed", async () => {
    const { sql, hub, once, releases } = await instance();
    hub.state.releases.set(SHA2, "not a release");
    const first = await once();
    expect(first.line).toBe(
      `main on github.com/example/erga is at ${short(SHA2)}. What GitHub's registry has for it is not a release: it is not deployed.`
    );
    expect(await releases()).toEqual([`${short(SHA2)} refused`, `${short(SHA1)} none`]);
    expect((await once()).calls).toEqual(["refs"]);
    expect(await run(readJobs(sql))).toEqual([]);
  });

  test("a job that runs on the instance holds the look off; one that stopped with no end still counts as a try", async () => {
    const { sql, hub, clock, once } = await instance();
    hub.state.releases.set(SHA2, bundleOf(SHA2));
    const other = await run(
      Effect.provideService(
        openJob(sql, { kind: "deploy", command: "bun erga deploy next.example.com", source: "terminal" }),
        Clock.Clock,
        clock.clock
      )
    );
    const held = await once();
    expect(held.line).toContain("A job runs on the instance (bun erga deploy next.example.com): the look waits.");
    expect(held.calls).not.toContain(`bundle ${short(SHA2)}`);
    // The other job deployed the head and stopped with no end: after its lease the instance is free, and the head was tried.
    other.commit(SHA2);
    other.line("a line");
    await run(Effect.provideService(Effect.sleep(LEASE_MS), Clock.Clock, clock.clock));
    expect((await once()).line).toContain("a commit is tried one time");
    expect(await run(readJobs(sql))).toHaveLength(1);
  });

  test("GitHub gives no answer: the error is on the instance, with the head and the commits of the look before", async () => {
    const { hub, once, row, releases } = await instance({ auto: false });
    await once();
    hub.state.down = 503;
    const failed = await once();
    expect(failed.line).toBe("GitHub did not give the head of main on github.com/example/erga: it answered 503.");
    expect(row()).toMatchObject({ head: SHA2, error: failed.line });
    expect(await releases()).toEqual([`${short(SHA2)} none`, `${short(SHA1)} none`]);
    // A repository that is not there, or not public.
    hub.state.down = 404;
    expect((await once()).line).toContain("GitHub answered 404 for the head of main on github.com/example/erga");
    // GitHub answers again: the error goes.
    hub.state.down = null;
    await once();
    expect(row()?.error).toBeNull();
  });

  test("a feed that is behind the head changes nothing, and is read again at the next look", async () => {
    const { hub, once, row, releases } = await instance({ auto: false, shas: [SHA1] });
    await once();
    hub.state.feed = [...hub.state.commits];
    hub.state.commits.unshift({ sha: SHA2, title: "New", at: Date.parse("2026-11-19T10:05:00Z") });
    const behind = await once();
    expect(behind.calls).toEqual(["refs", "feed", `manifest ${short(SHA2)}`]);
    expect(row()?.head).toBe(SHA2);
    expect(await releases()).toEqual([`${short(SHA1)} none`]);
    hub.state.feed = null;
    expect((await once()).calls).toEqual(["refs", "feed", `manifest ${short(SHA2)}`]);
    expect(await releases()).toEqual([`${short(SHA2)} none`, `${short(SHA1)} none`]);
  });

  test("it keeps ten commits; a spec for another instance, no spec and no tables stop it before GitHub", async () => {
    const many = Array.from({ length: 12 }, (_, i) => (i + 10).toString(16).padStart(2, "0").repeat(20));
    const { sql, once, row, releases } = await instance({ auto: false, shas: many });
    await once();
    expect(await releases()).toEqual(many.slice(0, 10).map((sha) => `${short(sha)} none`));

    const other = await once({ mine: () => false });
    expect(other.line).toBe("The instance's spec names another instance than the one that this deployer is for.");
    expect(other.calls).toEqual([]);
    expect(row()).toMatchObject({ head: many[0], error: other.line });
    expect(await run(readJobs(sql))).toEqual([]);

    const empty = database();
    const clock = testClock();
    const hub = github();
    const ports = { fetch: hub.fetch, cloud: {}, mine: () => true };
    const at = (sql: Sql) => run(Effect.provideService(look({ ...ports, sql }), Clock.Clock, clock.clock));
    expect(await at(empty.sql)).toBe("The instance has no spec: nothing to look at.");
    expect(await at(database({ tables: false }).sql)).toBe(
      "The instance's database has no tables for its deploys yet: a deploy from a machine brings them."
    );
    expect(hub.state.calls).toEqual([]);
    expect(empty.db.query("SELECT count(*) AS n FROM deploy_control").get()).toEqual({ n: 0 });
  });
});

describe("when a head is due", () => {
  const now = 1_800_000_000_000;
  const job = (o: Partial<Parameters<typeof due>[0][number]>) => ({
    state: { at: "done" } as const,
    alive: now - 1000,
    sha: null,
    command: "c",
    ...o,
  });
  test("no job has it, and none runs", () => {
    expect(due([], SHA2, now)).toBeNull();
    expect(due([job({ sha: SHA1 }), job({ sha: null }), job({ sha: "2222" })], SHA2, now)).toBeNull();
    // A job that ran too long ago to hold the lock, of another commit.
    expect(due([job({ state: { at: "running" }, alive: now - LEASE_MS, sha: SHA1 })], SHA2, now)).toBeNull();
  });
  test("not while a job runs, and not a commit that a job has: by its full name or its first 12 characters", () => {
    expect(due([job({ state: { at: "running" }, sha: SHA1, command: "rollback" })], SHA2, now)).toContain(
      "A job runs on the instance (rollback)"
    );
    expect(due([job({ sha: SHA2 })], SHA2, now)).toBe(`The instance has ${short(SHA2)}: nothing to deploy.`);
    expect(due([job({ sha: short(SHA2), state: { at: "failed", why: "no" } })], SHA2, now)).toContain("a commit is tried one time");
    // A rollback after the head's deploy: the head is not deployed again.
    expect(due([job({ sha: null, command: "rollback" }), job({ sha: SHA2 })], SHA2, now)).toContain("nothing to deploy");
  });
});

describe("the branch, as github.com says it", () => {
  const branch = { repo: "github.com/example/erga", branch: "main" };
  const answers =
    (body: string, status = 200): Fetch =>
    async () =>
      new Response(body, { status });
  test("the head is the line of the branch's own ref, and no other ref's", async () => {
    const hub = github();
    expect(await run(headAtGitHub(hub.fetch, branch))).toBe(SHA2);
    // The branch's line is the first one, with git's own words after a NUL.
    expect(
      await run(
        headAtGitHub(answers(`${pkt("# service=git-upload-pack\n")}0000${pkt(`${SHA3} refs/heads/main\0multi_ack\n`)}0000`), branch)
      )
    ).toBe(SHA3);
    const none = await run(Effect.flip(headAtGitHub(hub.fetch, { ...branch, branch: "staging" })));
    expect(none.message).toBe("github.com/example/erga has no branch staging, as GitHub lists its refs.");
    expect(none).not.toBeInstanceOf(TryLater);
    const short40 = await run(Effect.flip(headAtGitHub(answers(pkt("abc refs/heads/main\n")), branch)));
    expect(short40.message).toContain("has no branch main");
  });
  test("no answer and GitHub's faults are TryLater; another answer is an error", async () => {
    for (const status of [429, 500, 503])
      expect(await run(Effect.flip(headAtGitHub(answers("", status), branch)))).toBeInstanceOf(TryLater);
    const offline: Fetch = async () => {
      throw new Error("no network");
    };
    expect(await run(Effect.flip(commitsAtGitHub(offline, branch)))).toBeInstanceOf(TryLater);
    for (const status of [401, 404])
      expect(await run(Effect.flip(commitsAtGitHub(answers("", status), branch)))).not.toBeInstanceOf(TryLater);
  });
  test("the commits are the feed's entries; a title is plain text, cut at 200 characters; an entry it can't read is an error", async () => {
    const hub = github();
    hub.state.commits[0].title = `A & B <script>'x'</script> ${"long ".repeat(60)}`;
    const commits = await run(commitsAtGitHub(hub.fetch, branch));
    expect(commits.map((c) => c.sha)).toEqual([SHA2, SHA1]);
    expect(commits[0].title).toBe(`A & B <script>'x'</script> ${"long ".repeat(60)}`.slice(0, 200));
    expect(commits[0].at).toBe(Date.parse("2026-11-19T10:00:00Z"));
    expect(await run(commitsAtGitHub(answers("<feed></feed>"), branch))).toEqual([]);
    const odd = await run(Effect.flip(commitsAtGitHub(answers("<feed><entry><id>Commit/abc</id><title>t</title></entry></feed>"), branch)));
    expect(odd.message).toContain("in a way Erga doesn't understand");
  });
});

describe("the deployer on Cloudflare", () => {
  const ENV = { CLOUDFLARE_API_TOKEN: "mock-deployer-token", ACCOUNT: FLEET_ACCOUNT, WORKER: "erga-next" };
  /** The instance as setup's pipeline made it (release SHA1), its spec on it, and GitHub with the release of SHA2. */
  async function instance() {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const clock = testClock();
    mock.state.now = clock.now;
    const hub = github();
    hub.state.releases.set(SHA2, builtBundle(SHA2));
    const fetch: Fetch = (input, init) =>
      String(input).startsWith("https://api.cloudflare.com/") ? mock.fetch(input, init) : hub.fetch(input, init);
    const cf = new Cloudflare(ENV.CLOUDFLARE_API_TOKEN, fetch);
    const sql = d1Sql(cf, { account: ENV.ACCOUNT, worker: ENV.WORKER });
    await run(writeSpec(sql, SPEC));
    return { mock, clock, hub, fetch, cf, sql };
  }

  test("auto-deploy: the head's release from GitHub goes on the instance, one time, with its job on the instance", async () => {
    const { mock, clock, hub, fetch, cf, sql } = await instance();
    await run(sql("INSERT INTO deploy_control (id, auto) VALUES (1, 1)", []));
    const ports: LookPorts = { sql, fetch, cloud: { cloudflare: cf }, mine: (t) => t.kind == "cloudflare" && t.worker == "erga-next" };
    const once = () => run(Effect.provideService(look(ports), Clock.Clock, clock.clock));
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(short(SHA1));
    expect(await once()).toBe(`main on github.com/example/erga is at ${short(SHA2)}. It is deployed.`);
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(short(SHA2));
    const [job, ...more] = await run(readJobs(sql));
    expect(more).toEqual([]);
    expect(job).toMatchObject({ kind: "deploy", command: `deploy ${SHA2}`, source: "auto-deploy", sha: SHA2, state: { at: "done" } });
    expect((await logOf(sql, job.id)).split("\n").map((l) => l.replace(/: done.*$/, ": done"))).toEqual([
      `main on github.com/example/erga is at ${short(SHA2)}: auto-deploy deploys its release.`,
      "Set up the database's tables...",
      "Set up the database's tables: done",
      "Upload the editor's files...",
      "Upload the editor's files: done",
      "Upload the Worker, with its settings and secrets...",
      "Upload the Worker, with its settings and secrets: done",
      "Wait for its health...",
      "Wait for its health: done",
      "",
    ]);
    expect((await run(readControl(sql)))?.commits.map((c) => `${short(c.sha)} ${c.release}`)).toEqual([
      `${short(SHA2)} released`,
      `${short(SHA1)} none`,
    ]);
    // The next look: nothing to deploy, and nothing fetched.
    const from = hub.state.calls.length;
    const uploads = mock.state.calls.filter((c) => c.startsWith("PUT ")).length;
    expect(await once()).toBe(`main on github.com/example/erga is at ${short(SHA2)}. The instance has ${short(SHA2)}: nothing to deploy.`);
    expect(hub.state.calls.slice(from)).toEqual(["refs"]);
    expect(mock.state.calls.filter((c) => c.startsWith("PUT ")).length).toBe(uploads);
    expect(await run(readJobs(sql))).toHaveLength(1);
  });

  test("the Worker's schedule runs one look, for its own instance only; it has no address", async () => {
    const { mock, fetch, sql } = await instance();
    const worker = deployer(fetch);
    expect(Object.keys(worker)).toEqual(["scheduled"]);
    await worker.scheduled(null, ENV);
    expect(await run(readControl(sql))).toMatchObject({ auto: false, head: SHA2 });
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(short(SHA1));
    // The spec on the instance names another Worker than the one that the deployer is for: an error, and no deploy.
    await run(sql("UPDATE deploy_control SET auto = 1", []));
    await run(writeSpec(sql, { ...SPEC, target: { ...SPEC.target, worker: "erga" } as Spec["target"] }));
    await worker.scheduled(null, ENV);
    const row = await run(sql("SELECT error FROM deploy_control", []));
    expect(row).toEqual(["The instance's spec names another instance than the one that this deployer is for."]);
    expect(await run(readJobs(sql))).toEqual([]);
  });

  test("the Worker is one file with Effect and this folder only: no Node, no other code of Erga's", async () => {
    const built = await Bun.build({
      entrypoints: [join(ROOT, "deploy/deployer/worker.ts")],
      target: "browser",
      format: "esm",
      minify: true,
    });
    expect(built.logs.map(String)).toEqual([]);
    expect(built.success).toBe(true);
    const code = await built.outputs[0].text();
    expect(code).not.toMatch(/from\s*"node:|require\(/);
    expect(code).toContain("scheduled");
    // Cloudflare takes a Worker of 3 MB at most (after gzip) on its free plan.
    expect(Bun.gzipSync(new TextEncoder().encode(code)).byteLength).toBeLessThan(1_000_000);
  });
});
