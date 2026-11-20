// `bun erga deploy` and `bun erga rollback` (deploy/cli/deploy.ts), from .erga/config.json, against the mock
// Cloudflare's example account (ERGA_DEPLOY_MOCK=1): every entry takes the same path (entryTarget); the upload has the
// entry's vars, no secret goes out, the lock and the job log on the instance, its spec there, and the tests' gate. A Worker keeps its database:
// its entry takes the name of the database that it is bound to. And the branches (a clone of its own): an instance
// deploys the head of the branch it tracks, and only a commit of that branch; no deploy moves a branch;
// `bun erga promote` moves main to staging's head. And --remove-domain (deploy/cli/remove-domain.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CloudflareEntry, type Entry, entryOf, readConfig, withEntry, writeConfig } from "../deploy/cli/config";
import { commitOf, deployInstance, entryTarget, rollbackInstance, trackedHead } from "../deploy/cli/deploy";
import { promote, promoteRefusal } from "../deploy/cli/promote";
import { entryFrom, specOn, sqlOf, startInstanceJob, trackOn } from "../deploy/cli/instance";
import { removalPlan } from "../deploy/cli/remove-domain";
import { findInstance, instanceReader, jobsReader } from "../deploy/cli/running";
import { d1 } from "../deploy/deployer/cloudflare";
import { Cloudflare } from "../deploy/deployer/cloudflare-api";
import { LEASE_MS } from "../deploy/deployer/instance";
import { packRelease } from "../deploy/pipeline/build";
import { targetFacts } from "../deploy/pipeline/pipeline";
import { mockCloudflare } from "../dev/mock-cloudflare";
import {
  bindingsOf,
  bootstrap,
  databaseOf,
  fleet as fleetTarget,
  next as nextTarget,
  prepareRelease,
  ROOT,
  SHA1,
} from "./helpers/deploys.ts";
import type { Suite } from "../deploy/cli/test-run";
import { writePass } from "./helpers/pass.ts";
import { registry } from "./helpers/registry.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const HEAD = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
const REPO = "github.com/koomen/erga";
const fleet: Entry = { host: "example.com", repo: REPO, branch: "main", ...targetFacts(fleetTarget()) };
const nextFacts = targetFacts(nextTarget());
const next: Entry = {
  host: "next.example.com",
  repo: REPO,
  branch: "staging",
  ...nextFacts,
  // A plain setting that only the entry has: the upload must carry it.
  vars: { ...nextFacts.vars, GITHUB_CLIENT_ID: "Ov23-from-the-entry" },
};

let dir = "";
/** The record that every test passed on HEAD's tree. */
let pass = "";
const fresh = (...entries: Entry[]) => {
  dir = join(mkdtempSync(join(tmpdir(), "erga-deploy-")), ".erga");
  writeConfig(dir, entries.reduce(withEntry, { instances: [] }));
  pass = writePass(dir, HEAD);
  return dir;
};
type Mock = ReturnType<typeof mockCloudflare>;
/** An instance's jobs, as its own database has them in the mock Cloudflare: the newest first. */
const jobsOn = async (mock: Mock, entry: Entry) => (await jobsReader({ net: mock.fetch })(entry)).jobs;
/** The instance's database in the mock Cloudflare, for its record of its deploys. */
const sqlOn = (mock: Mock, entry: Entry) => sqlOf(entry, { cf: new Cloudflare("mock-machine-token", mock.fetch) });
/** The calls that change what an instance runs: no read, and no statement on its database. */
const changes = (mock: Mock) => mock.state.calls.filter((c) => !c.startsWith("GET ") && !/\/d1\/database\/[^/]+\/query$/.test(c));

beforeAll(async () => {
  process.env.ERGA_DEPLOY_MOCK = "1";
  await prepareRelease();
}, 120_000);
afterAll(() => {
  delete process.env.ERGA_DEPLOY_MOCK;
  if (dir) rmSync(join(dir, ".."), { recursive: true, force: true });
});

describe("bun erga deploy", () => {
  test("an entry's deploy: its vars, no secret sent, its database kept; the job record; the other instance untouched", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const other = JSON.stringify([mock.state.scripts.erga, mock.state.secrets.erga]);
    const db = bindingsOf(mock.state, "erga-next").DB.database_id;
    const secrets = { ...mock.state.secrets["erga-next"] };
    fresh(fleet, next);
    const lines: string[] = [];
    // The ops page's variable, as a merge started from the page had it: the job record still says "terminal",
    // because only the CLI's command line reads it (deploy/cli/main.ts).
    const page = process.env.ERGA_JOB_FROM;
    process.env.ERGA_JOB_FROM = "page";
    // As Cloudflare did on staging on 2026-11-19: just after an upload, the Worker's settings list no secret that the
    // Worker kept. The deploy reads the secrets' names before it changes the Worker.
    let uploaded = false;
    const net: typeof mock.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (init?.method == "PUT" && url.endsWith("/workers/scripts/erga-next")) uploaded = true;
      const answer = await mock.fetch(input, init);
      if (!uploaded || !url.endsWith("/workers/scripts/erga-next/settings")) return answer;
      const body = (await answer.json()) as { result: { bindings: { type: string }[] } };
      body.result.bindings = body.result.bindings.filter((b) => b.type != "secret_text");
      return Response.json(body);
    };
    try {
      expect(await deployInstance({ dir, host: "next.example.com", commit: "HEAD", net, print: (l) => lines.push(l) })).toBe(HEAD);
    } finally {
      if (page == undefined) delete process.env.ERGA_JOB_FROM;
      else process.env.ERGA_JOB_FROM = page;
    }

    const b = bindingsOf(mock.state, "erga-next");
    expect(b.ERGA_VERSION.text).toBe(HEAD.slice(0, 12));
    expect(b.GITHUB_CLIENT_ID.text).toBe("Ov23-from-the-entry");
    // No setting says which instance it is.
    for (const name of ["DEPLOY_TARGET", "SNAPSHOT_IMPORT", "SNAPSHOT_FROM"]) expect(b[name]).toBeUndefined();
    expect(b.DB.database_id).toBe(db);
    expect(mock.state.scripts["erga-next"].metadata.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(mock.state.secrets["erga-next"]).toEqual(secrets);
    expect(JSON.stringify([mock.state.scripts.erga, mock.state.secrets.erga])).toBe(other);

    // The job on the instance: the command, the commit, the output, the result. It holds the lock no more.
    const [job, ...before] = await jobsOn(mock, next);
    expect(before).toEqual([]);
    expect(job).toMatchObject({
      kind: "deploy",
      command: "bun erga deploy HEAD next.example.com",
      host: "next.example.com",
      from: "terminal",
      commit: HEAD,
      phase: "ok",
    });
    expect(lines).toContain("Test the commit: done");
    expect(job.out).toEqual(lines.join("\n").split("\n"));
    // The instance had no spec: it has the entry's now, with the names of the secrets that the Worker holds.
    expect(lines.at(-1)).toBe("The instance has its spec now: the entry's values.");
    expect(await specOn(await sqlOn(mock, next))).toMatchObject({
      repo: REPO,
      branch: "staging",
      target: { kind: "cloudflare", worker: "erga-next", database: "erga-next" },
      settings: { GITHUB_CLIENT_ID: "Ov23-from-the-entry" },
      secrets: Object.keys(secrets).sort(),
    });

    // A rollback by host, from the entry: the version before (the bootstrap's) serves again. It is the instance's second job.
    expect(await rollbackInstance({ dir, host: "next.example.com", net: mock.fetch, print: () => {} })).toBe(SHA1.slice(0, 12));
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(SHA1.slice(0, 12));
    expect((await jobsOn(mock, next)).map((j) => [j.kind, j.phase, j.command])).toEqual([
      ["rollback", "ok", "bun erga rollback next.example.com"],
      ["deploy", "ok", "bun erga deploy HEAD next.example.com"],
    ]);
  }, 60_000);

  test("a Worker keeps its database: its entry takes the name of the database that the Worker is bound to", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    // The Worker's database has another name than the entry's (an instance from before had one named for a copy).
    const bound = databaseOf(mock.state, "erga-next");
    bound.name = "erga-next-mhz2k4q8";
    fresh(fleet, next);
    const lines: string[] = [];
    await deployInstance({ dir, host: "next.example.com", commit: "HEAD", net: mock.fetch, print: (l) => lines.push(l) });
    expect(lines).toContain(
      "NOTE  erga-next is bound to the database erga-next-mhz2k4q8, and next.example.com's entry names erga-next: the entry takes erga-next-mhz2k4q8."
    );
    expect(databaseOf(mock.state, "erga-next").uuid).toBe(bound.uuid);
    expect(mock.state.databases.map((d) => d.name).sort()).toEqual(["erga", "erga-next-mhz2k4q8"]);
    expect((entryOf(readConfig(dir), "next.example.com") as CloudflareEntry).database).toBe("erga-next-mhz2k4q8");
    expect(JSON.parse(bindingsOf(mock.state, "erga-next").ERGA_DEPLOY.text).database).toBe("erga-next-mhz2k4q8");
    // The next deploy changes nothing.
    lines.length = 0;
    await deployInstance({ dir, host: "next.example.com", commit: "HEAD", net: mock.fetch, print: (l) => lines.push(l) });
    expect(lines.some((l) => l.startsWith("NOTE  erga-next is bound"))).toBe(false);
  }, 60_000);

  test("one job at a time on an instance, from any machine: a second deploy stops; a job that stopped frees the instance after its lease", async () => {
    fresh(fleet, next);
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const deploy = () => deployInstance({ dir, host: "next.example.com", commit: "HEAD", net: mock.fetch, print: () => {} });
    // A job of another machine runs on the instance: its row in the instance's database is the lock.
    const sql = await sqlOn(mock, next);
    const other = await startInstanceJob(sql, {
      kind: "deploy",
      command: "bun erga deploy main next.example.com",
      source: "terminal",
      host: "next.example.com",
      print: () => {},
    });
    const uploads = changes(mock).length;
    await expect(deploy()).rejects.toThrow(
      "next.example.com: Another job runs on the instance: bun erga deploy main next.example.com (from terminal), since "
    );
    expect(changes(mock).length).toBe(uploads);
    // The other job ends: the instance is free.
    await other.end();
    expect(await deploy()).toBe(HEAD);
    expect(changes(mock).length).toBeGreaterThan(uploads);
    // A job that stopped with no end holds the instance until its lease is over.
    await startInstanceJob(sql, {
      kind: "rollback",
      command: "bun erga rollback next.example.com",
      source: "page",
      host: "next.example.com",
      print: () => {},
    });
    await expect(deploy()).rejects.toThrow("bun erga rollback next.example.com (from page)");
    await Effect.runPromise(sql("UPDATE deploy_jobs SET alive = alive - ? WHERE state = 'running'", [LEASE_MS + 1]));
    expect(await deploy()).toBe(HEAD);
    expect((await jobsOn(mock, next)).map((j) => [j.kind, j.phase])).toEqual([
      ["deploy", "ok"],
      ["rollback", "stopped"],
      ["deploy", "ok"],
      ["deploy", "ok"],
    ]);
  }, 60_000);

  test("the ops page's reader of an instance's jobs: one statement for a read, and a log only as far as it is new", async () => {
    fresh(fleet, next);
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const sql = await sqlOn(mock, next);
    const job = await startInstanceJob(sql, {
      kind: "deploy",
      command: "bun erga deploy next.example.com",
      source: "terminal",
      host: "next.example.com",
      print: () => {},
    });
    job.log("one");
    const read = jobsReader({ net: mock.fetch });
    const calls = () => mock.state.calls.length;
    // While it runs, the page shows it as running.
    expect((await read(next)).jobs.map((j) => j.phase)).toEqual(["running"]);
    await job.end();
    let before = calls();
    expect((await read(next)).jobs.map((j) => [j.phase, j.out])).toEqual([["ok", ["one"]]]);
    // Nothing new in the log: the read is the list of the jobs, and the row that says who deploys the instance.
    const query = expect.stringMatching(/^POST .*\/d1\/database\/[^/]+\/query$/);
    expect(mock.state.calls.slice(before)).toEqual([query, query]);
    // More in the log: the list, and the part of the log that is new.
    await Effect.runPromise(sql("UPDATE deploy_jobs SET log = log || ?", ["two\nthree\n"]));
    before = calls();
    expect((await read(next)).jobs[0].out).toEqual(["one", "two", "three"]);
    expect(calls() - before).toBe(3);
    // Who deploys the instance: a deployer in its own account, when its row says that one looked in the last minutes
    // with auto-deploy on. An old look, or the switch off, is no deployer.
    expect((await read(next)).cloud).toBe(false);
    await Effect.runPromise(sql("INSERT INTO deploy_control (id, auto, looked) VALUES (1, 1, ?)", [Date.now() - 60_000]));
    expect((await read(next)).cloud).toBe(true);
    await Effect.runPromise(sql("UPDATE deploy_control SET looked = ?", [Date.now() - 10 * 60_000]));
    expect((await read(next)).cloud).toBe(false);
    await Effect.runPromise(sql("UPDATE deploy_control SET looked = ?, auto = 0", [Date.now()]));
    expect((await read(next)).cloud).toBe(false);
    // An instance whose database has no table for its jobs has none.
    expect(await read(fleet)).toEqual({ jobs: [], cloud: false });
  }, 60_000);

  test("the tests' gate: a commit with no record runs the tests, and a failure stops before the build; --no-tests is in the record", async () => {
    fresh(fleet);
    rmSync(pass);
    const mock = mockCloudflare({ fleet: true });
    let ran = 0;
    const failing: Suite = (_, log) => (
      ran++, writeFileSync(log, "FAILED (1 s)\n"), { run: { results: [{ file: "e2e/a.e2e.ts", titlePath: ["breaks"], status: "failed" }] } }
    );
    const deploy = (more: object = {}) =>
      deployInstance({ dir, host: "example.com", commit: "HEAD", net: mock.fetch, print: () => {}, suite: failing, ...more });
    await expect(deploy()).rejects.toThrow("1 test failed on");
    // The failed run is the tree's record: a second deploy refuses it with the test's name, and runs nothing.
    await expect(deploy()).rejects.toThrow("\n  e2e/a.e2e.ts: breaks");
    expect(ran).toBe(1);
    expect(changes(mock)).toEqual([]);
    // The fleet's database is from before the table of the jobs: a job that fails before its migrations leaves no row.
    expect(await jobsOn(mock, fleet)).toEqual([]);

    // A deploy changes the code only. The fleet's Worker is from before the documents' bucket, which this release
    // binds: the upload stops in Cloudflare's words, and the Worker runs what it ran.
    const before = bindingsOf(mock.state, "erga").ERGA_VERSION?.text;
    await expect(deploy({ noTests: true })).rejects.toThrow("binding FILES: no R2 bucket erga-files");
    expect(bindingsOf(mock.state, "erga").ERGA_VERSION?.text).toBe(before);
    expect(ran).toBe(1);
    // That deploy brought the table (its migrations), so its job is there, whole: it ran with no lock on the instance.
    expect((await jobsOn(mock, fleet)).map((j) => [j.phase, j.commit])).toEqual([["failed", HEAD]]);
    // With the bucket, as a setup of today makes it, the same deploy goes through.
    mock.state.buckets!.push("erga-files");
    await deploy({ noTests: true });
    const [job] = await jobsOn(mock, fleet);
    expect(job).toMatchObject({ phase: "ok", commit: HEAD });
    expect(job.out).toContainEqual(expect.stringContaining("did not run (--no-tests)"));
  }, 60_000);
});

describe("what an instance runs comes from Cloudflare, never from the instance", () => {
  test("status with no app server: the commit of the version that serves and its health row, after a deploy and after a rollback", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    fresh(fleet, next);
    // Every request that is not to Cloudflare's API: there must be none.
    const servers: string[] = [];
    const net: typeof mock.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin != "https://api.cloudflare.com") servers.push(url.href);
      return mock.fetch(input, init);
    };
    const ask = instanceReader({ net });
    // The fleet's Worker is from before the health row: its commit is known, its health is not. The second instance's server
    // writes its row each minute (its Cron Trigger).
    expect(await ask(fleet)).toEqual({ version: "prim00000000", healthy: null, health: "the server wrote no health row yet" });
    expect(await ask(next)).toEqual({ version: SHA1.slice(0, 12), healthy: true });
    const said: string[] = [];
    await deployInstance({ dir, host: "next.example.com", commit: "HEAD", net, print: (l) => said.push(l) });
    expect(await ask(next)).toEqual({ version: HEAD.slice(0, 12), healthy: true });
    // The files of the release before come from this machine's own copy: it has none of the bootstrap's release.
    expect(said).toContain(
      `This machine has no copy of the files of release ${SHA1.slice(0, 12)}, which next.example.com runs (another machine deployed it): the release keeps none of the release before.`
    );
    // An instance whose deployment did not change costs two calls: its deployments, and its health row.
    const calls = mock.state.calls.length;
    expect((await ask(next)).version).toBe(HEAD.slice(0, 12));
    const db = bindingsOf(mock.state, "erga-next").DB.database_id;
    expect(mock.state.calls.slice(calls)).toEqual([
      `GET /accounts/${nextFacts.account}/workers/scripts/erga-next/deployments`,
      `POST /accounts/${nextFacts.account}/d1/database/${db}/query`,
    ]);
    // A rollback is a new deployment of the version before: it waits for that release's health row, and the reader
    // sees that version's commit.
    const lines: string[] = [];
    expect(await rollbackInstance({ dir, host: "next.example.com", net, print: (l) => lines.push(l) })).toBe(SHA1.slice(0, 12));
    expect(lines.at(-1)).toBe(`next.example.com runs release ${SHA1.slice(0, 12)} now, health ok.`);
    expect(await ask(next)).toEqual({ version: SHA1.slice(0, 12), healthy: true });
    // A release whose own report says that a check fails.
    mock.state.unhealthy = [SHA1.slice(0, 12)];
    expect(await ask(next)).toEqual({
      version: SHA1.slice(0, 12),
      healthy: false,
      health: "documents: a document didn't open (the mock says this release is unhealthy)",
    });
    // Neither the reader, the deploy nor the rollback asked a server anything.
    expect(servers).toEqual([]);
    // A Worker that is not there, and a credential that Cloudflare refuses: the answer says so.
    expect(await ask({ ...next, host: "new.example.com", worker: "erga-new" } as Entry)).toEqual({
      version: null,
      error: "Cloudflare has no deployment of the Worker erga-new: bun erga deploy new.example.com",
      healthy: null,
    });
    const refused = await instanceReader({ net: mock.fetch, token: "not-a-token" })(fleet);
    expect(refused.error).toContain("Cloudflare didn't accept the credential");
  }, 60_000);

  test("bun erga register: the entry's facts come from the bindings of the Worker's version that serves", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const mark = mock.state.calls.length;
    const found = await findInstance("next.example.com", { net: mock.fetch });
    expect(found.version).toBe(SHA1.slice(0, 12));
    expect(found.facts).toEqual(nextFacts);
    // The fleet's first Worker is from before the pipeline gave a Worker its facts; no Worker answers at an unknown host.
    await expect(findInstance("example.com", { net: mock.fetch })).rejects.toThrow("The Worker erga at example.com holds no deploy facts");
    await expect(findInstance("nowhere.example.com", { net: mock.fetch })).rejects.toThrow("No Worker answers at nowhere.example.com");
    // It only reads, and only Cloudflare's API.
    expect(mock.state.calls.slice(mark).every((c) => c.startsWith("GET /accounts"))).toBe(true);
  }, 60_000);
});

describe("the release is the one that GitHub built", () => {
  /** This checkout's built release as GitHub's bundle of HEAD, and a registry that has it. */
  const github = async (over: Parameters<typeof registry>[0] = {}) => {
    const bundle = JSON.parse(new TextDecoder().decode(packRelease(join(ROOT, ".build/release"))));
    bundle.index.version = HEAD.slice(0, 12);
    return registry({ bundle: new TextEncoder().encode(JSON.stringify(bundle)), commit: HEAD, ...over });
  };
  const world = async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    fresh(fleet, next);
    const lines: string[] = [];
    const deploy = (fetch: Awaited<ReturnType<typeof registry>>["fetch"]) =>
      deployInstance({ dir, host: "next.example.com", commit: "HEAD", net: mock.fetch, registry: fetch, print: (l) => lines.push(l) });
    return { mock, lines, deploy };
  };

  test("a deploy fetches the commit's release from the registry, checks it, and runs the deployer's steps with it; it builds nothing", async () => {
    const { mock, lines, deploy } = await world();
    const { fetch, calls } = await github();
    expect(await deploy(fetch)).toBe(HEAD);
    expect(calls.map((c) => c.url.replace(/sha256:.*/, "<digest>"))).toEqual([
      "https://ghcr.io/token?service=ghcr.io&scope=repository:koomen/erga:pull",
      `https://ghcr.io/v2/koomen/erga/manifests/${HEAD}`,
      "https://ghcr.io/v2/koomen/erga/blobs/<digest>",
    ]);
    expect(lines).toContain(`Fetch the release from GitHub: done, ghcr.io/koomen/erga:${HEAD}, checked against its digest`);
    expect(lines.some((l) => l.startsWith("Build the code"))).toBe(false);
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(HEAD.slice(0, 12));
    // The code steps alone: the deployer's four, and no step that gives the instance its shape.
    expect(lines.filter((l) => l.endsWith("...")).slice(-4)).toEqual([
      "Set up the database's tables...",
      "Upload the editor's files...",
      "Upload the Worker, with its settings and secrets...",
      "Wait for its health...",
    ]);
    expect(lines.some((l) => l.startsWith("Give it its address") || l.startsWith("Check your Cloudflare account"))).toBe(false);
    expect(lines).toContain(`Deployed ${HEAD.slice(0, 12)} to https://next.example.com: healthy.`);
  }, 60_000);

  test("GitHub has no release of the commit yet: this machine builds it, and says so", async () => {
    const { mock, lines, deploy } = await world();
    const { fetch } = await github({ commit: "f".repeat(40) });
    expect(await deploy(fetch)).toBe(HEAD);
    expect(lines).toContain(
      `Fetch the release from GitHub: done, GitHub has no release of ${HEAD.slice(0, 12)} yet (ghcr.io/koomen/erga:${HEAD}): this machine builds it`
    );
    expect(lines).toContain("Build the code: done");
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(HEAD.slice(0, 12));
  }, 60_000);

  test("a release that fails its check, or a registry that gives no answer, stops the deploy: no build in its place, nothing uploaded", async () => {
    const { mock, lines, deploy } = await world();
    const uploads = changes(mock).length;
    const tampered = packRelease(join(ROOT, ".build/release"));
    await expect(deploy((await github({ served: tampered })).fetch)).rejects.toThrow("is not the one that its manifest names");
    await expect(deploy((await github({ fail: true })).fetch)).rejects.toThrow("GitHub's registry did not give the release");
    await expect(deploy((await github({ tagged: new Response("{}", { status: 401 }) })).fetch)).rejects.toThrow("must be public");
    expect(lines.some((l) => l.startsWith("Build the code"))).toBe(false);
    expect(changes(mock).length).toBe(uploads);
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(SHA1.slice(0, 12));
    expect((await jobsOn(mock, next)).map((j) => j.phase)).toEqual(["failed", "failed", "failed"]);
  }, 60_000);

  test("a release that is up but not healthy: the deployer puts the version before back, and the deploy fails with that", async () => {
    const { mock, deploy } = await world();
    mock.state.unhealthy = [HEAD.slice(0, 12)];
    await expect(deploy((await github()).fetch)).rejects.toThrow(
      /^Release \w{12} is deployed to erga-next, but its health check fails: .* It is rolled back to [\w-]+, which ran before\.$/
    );
    // The Worker serves the version before again.
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(SHA1.slice(0, 12));
    expect((await jobsOn(mock, next))[0]).toMatchObject({ phase: "failed", error: expect.stringContaining("It is rolled back to") });
  }, 60_000);
});

describe("the instance holds its spec, and the entry must agree with it", () => {
  test("a deploy stops when they differ, with each field and both ways out; --write-spec, register and track make them agree", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    fresh(fleet, next);
    const lines: string[] = [];
    const deploy = (more: object = {}) =>
      deployInstance({ dir, host: "next.example.com", commit: "HEAD", net: mock.fetch, print: (l) => lines.push(l), ...more });
    // Its first deploy from this code gives the instance its spec: the entry's values.
    await deploy();
    const sql = await sqlOn(mock, next);
    const first = (await specOn(sql))!;
    expect(first).toMatchObject({
      branch: "staging",
      settings: next.vars,
      secrets: ["GITHUB_CLIENT_SECRET", "SECRETS_KEY", "SESSION_SECRET"],
    });

    // A person changes the entry by hand: what it tracks, a setting, and a new setting.
    const edited: Entry = { ...next, branch: "main", vars: { ...next.vars, GITHUB_CLIENT_ID: "Ov23-edited", SERVER_CONFIG: "{}" } };
    writeConfig(dir, withEntry(readConfig(dir), edited));
    const uploads = changes(mock).length;
    await expect(deploy()).rejects.toThrow(
      [
        "next.example.com's entry in .erga/config.json and the spec on the instance differ:",
        '  branch: the entry has "main", the instance has "staging"',
        '  settings.GITHUB_CLIENT_ID: the entry has "Ov23-edited", the instance has "Ov23-from-the-entry"',
        '  settings.SERVER_CONFIG: the entry has "{}", the instance has nothing',
        "It does not deploy. To deploy with the entry's values (they become the instance's spec): bun erga deploy next.example.com --write-spec",
        "To take the instance's spec into the entry: bun erga register next.example.com",
      ].join("\n")
    );
    // Nothing went up, the spec is as it was, and the job that stopped is in the instance's log.
    expect(changes(mock).length).toBe(uploads);
    expect(await specOn(sql)).toEqual(first);
    expect((await jobsOn(mock, next))[0]).toMatchObject({ phase: "failed", error: expect.stringContaining("differ") });

    // --write-spec: the entry's values become the spec, with the secrets' names that the Worker holds, and they deploy.
    lines.length = 0;
    await deploy({ writeSpec: true });
    expect(lines[0]).toBe(
      [
        "The instance's spec has the entry's values now:",
        '  branch: the entry has "main", the instance has "staging"',
        '  settings.GITHUB_CLIENT_ID: the entry has "Ov23-edited", the instance has "Ov23-from-the-entry"',
        '  settings.SERVER_CONFIG: the entry has "{}", the instance has nothing',
      ].join("\n")
    );
    expect(await specOn(sql)).toEqual({ ...first, branch: "main", settings: edited.vars });
    expect(bindingsOf(mock.state, "erga-next").GITHUB_CLIENT_ID.text).toBe("Ov23-edited");
    // They agree now: the next deploy needs no flag, and writes no spec.
    lines.length = 0;
    await deploy();
    expect(lines.some((l) => l.includes("spec"))).toBe(false);

    // bun erga register: the entry takes what the spec says; the host, the upstream and nothing else are the entry's own.
    const upstream = { repo: REPO, branch: "staging" };
    expect(entryFrom((await specOn(sql))!, { ...next, upstream })).toEqual({ ...edited, upstream });
    // bun erga track: the spec takes the new repository and branch, and only a repository on GitHub.
    expect(await trackOn(sql, "github.com/example/erga-fork", "release")).toBe(true);
    expect(await specOn(sql)).toMatchObject({ repo: "github.com/example/erga-fork", branch: "release", settings: edited.vars });
    await expect(trackOn(sql, "example.com/team/erga", "main")).rejects.toThrow("This is not a spec");
    // An instance with no spec yet (its database is from before the table): nothing to change there.
    expect(await trackOn(await sqlOn(mock, fleet), REPO, "main")).toBe(false);
  }, 60_000);

  test("an entry that is no spec does not deploy: nothing starts", async () => {
    const mock = mockCloudflare({ fleet: true });
    fresh({ ...fleet, repo: "example.com/team/erga" });
    await expect(deployInstance({ dir, host: "example.com", commit: "HEAD", net: mock.fetch, print: () => {} })).rejects.toThrow(
      "example.com's entry in .erga/config.json is not a spec that an instance can hold:"
    );
    expect(mock.state.calls).toEqual([]);
  });
});

describe("every entry takes one path", () => {
  test("an entry's target is its names and its vars, and nothing says which instance it is", () => {
    const a = entryTarget(fleet as CloudflareEntry),
      b = entryTarget(next as CloudflareEntry);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.vars).toEqual((fleet as CloudflareEntry).vars);
    expect(b.vars).toEqual((next as CloudflareEntry).vars);
    expect([a.secrets, b.secrets]).toEqual([{}, {}]);
  });
});

describe("bun erga deploy --domain", () => {
  test("registers each custom domain on the instance; the Worker holds them, and the entry gets what the deploy sent", async () => {
    const mock = mockCloudflare({ fleet: true });
    mock.state.zones.push({ id: "zone00000000000000000000000e7ga4", name: "example.org", status: "active" });
    fresh(fleet, next);
    const lines: string[] = [];
    const facts = () => JSON.parse(bindingsOf(mock.state, "erga").ERGA_DEPLOY.text).domains;
    await deployInstance({
      dir,
      host: "example.com",
      commit: "HEAD",
      domains: ["Example.org"],
      net: mock.fetch,
      print: (l) => lines.push(l),
    });
    expect(mock.state.domains).toContainEqual(expect.objectContaining({ hostname: "example.org", service: "erga" }));
    expect(facts()).toEqual(["example.org"]);
    expect(lines).toContainEqual(expect.stringContaining("the custom domain https://example.org"));
    expect((entryOf(readConfig(dir), "example.com") as CloudflareEntry | null)?.domains).toEqual(["example.org"]);
    expect((await jobsOn(mock, fleet))[0].command).toBe("bun erga deploy HEAD example.com --domain example.org");

    // The next deploy keeps it, from the entry's copy; another --domain adds to it.
    await deployInstance({ dir, host: "example.com", commit: "HEAD", net: mock.fetch, print: () => {} });
    expect(facts()).toEqual(["example.org"]);
    await deployInstance({
      dir,
      host: "example.com",
      commit: "HEAD",
      domains: ["blog.example.org", "example.org"],
      net: mock.fetch,
      print: () => {},
    });
    expect(facts()).toEqual(["example.org", "blog.example.org"]);
    expect(mock.state.domains.map((d) => d.hostname)).toContain("blog.example.org");
  }, 60_000);

  test("only a name on the account's zones, never the app's own address", async () => {
    const mock = mockCloudflare({ fleet: true });
    fresh(fleet, next);
    const deploy = (host: string, domain: string, commit = "HEAD") =>
      deployInstance({ dir, host, commit, domains: [domain], net: mock.fetch, print: () => {} });
    await expect(deploy("example.com", "nowhere.test")).rejects.toThrow("nowhere.test is on none of this Cloudflare account's zones");
    await expect(deploy("example.com", "not a domain")).rejects.toThrow("give a domain name");
    await expect(deploy("example.com", "example.com")).rejects.toThrow("is the app's address");
    expect(mock.state.domains.map((d) => d.hostname)).not.toContain("nowhere.test");
  }, 60_000);
});

describe("the branches", () => {
  test("promote refuses unless each instance that tracks staging runs the commit, healthy", () => {
    const sha = "abc".repeat(14).slice(0, 40);
    const ok = (host: string, version = sha.slice(0, 12)) => ({ host, version, healthy: true });
    expect(promoteRefusal(sha, [])).toBeNull();
    expect(promoteRefusal(sha, [ok("s.a.com"), ok("t.a.com")])).toBeNull();
    expect(promoteRefusal(sha, [ok("s.a.com"), ok("t.a.com", "def000000000")])).toContain(
      `t.a.com (runs def000000000) tracks staging, and does not run ${sha.slice(0, 12)}, healthy`
    );
    expect(promoteRefusal(sha, [{ ...ok("s.a.com"), healthy: false }])).toContain("s.a.com (not healthy)");
    expect(promoteRefusal(sha, [{ host: "s.a.com", version: null, healthy: null, error: "no answer" }])).toContain("s.a.com (no answer)");
  });

  test("an instance deploys its branch's head, and only a commit of its branch; no deploy moves a branch; promote moves main", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "erga-branches-"));
    const env = { ...process.env, ERGA_CLI_PUSH: "", PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
    const clone = join(tmp, "clone");
    const run = (...cmd: string[]) => {
      const r = Bun.spawnSync(cmd, { cwd: clone, env, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
    };
    const commit = (m: string) => (
      run("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", m), run("git", "rev-parse", "HEAD").out
    );
    const remote = (b: string) => run("git", "ls-remote", "origin", `refs/heads/${b}`).out.split(/\s/)[0];
    const PATH = process.env.PATH;
    try {
      // origin with main and staging at C1; the clone has the pre-push hook on, as bun install sets it.
      mkdirSync(join(clone, "deploy/cli/hooks"), { recursive: true });
      for (const f of ["deploy/cli/hooks/pre-push", "deploy/cli/pre-push.ts", "deploy/cli/flow.ts"])
        copyFileSync(join(ROOT, f), join(clone, f));
      chmodSync(join(clone, "deploy/cli/hooks/pre-push"), 0o755);
      run("git", "init", "-q", "-b", "work");
      run("git", "add", "-A");
      const c1 = commit("C1");
      // The origin has GitHub's name for the repository, as the entries do: in this clone, that name is a folder.
      Bun.spawnSync(["git", "init", "-q", "--bare", join(clone, REPO)]);
      run("git", "remote", "add", "origin", REPO);
      run("git", "push", "-q", "origin", `${c1}:refs/heads/main`, `${c1}:refs/heads/staging`);
      run("git", "config", "core.hooksPath", "deploy/cli/hooks");
      // C2 is on staging, as a merge pushes it: a clone that is not this one has it, so this one must fetch it.
      const c2 = commit("C2: the merged commit");
      Bun.spawnSync(["git", "push", "-q", "origin", `${c2}:refs/heads/staging`], { cwd: clone, env: { ...env, ERGA_CLI_PUSH: "1" } });
      run("git", "checkout", "-q", "--detach", c1);

      // Each entry tracks a branch of the origin: example.com main, next.example.com staging.
      fresh(fleet, next);
      writePass(dir, c1, clone);
      writePass(dir, c2, clone);
      const mock = mockCloudflare({ fleet: true });
      // (The fleet's instance has the documents' bucket, as a setup of today makes it.)
      mock.state.buckets!.push("erga-files");
      await bootstrap(mock);
      // The hook needs bun on the PATH, in the push that the CLI makes.
      process.env.PATH = env.PATH;
      const lines: string[] = [];
      const print = (l: string) => void lines.push(l);
      const versionOf = (worker: string) => bindingsOf(mock.state, worker).ERGA_VERSION.text;

      // With no commit named: the head of the branch it tracks, as the repository has it now. No branch moves.
      expect(await deployInstance({ dir, host: "next.example.com", clone, net: mock.fetch, print })).toBe(c2);
      expect(lines).toContain(`staging on ${REPO} is at ${c2.slice(0, 12)}: that commit deploys.`);
      expect(await deployInstance({ dir, host: "example.com", clone, net: mock.fetch, print })).toBe(c1);
      expect([versionOf("erga-next"), versionOf("erga")]).toEqual([c2.slice(0, 12), c1.slice(0, 12)]);
      expect([remote("staging"), remote("main")]).toEqual([c2, c1]);

      // A commit that its branch does not have does not deploy: nothing is built or uploaded.
      const calls = changes(mock).length;
      await expect(deployInstance({ dir, host: "example.com", commit: c2, clone, net: mock.fetch, print })).rejects.toThrow(
        `${c2.slice(0, 12)} is not a commit of main on ${REPO} (its head: ${c1.slice(0, 12)}). example.com deploys only a commit of the branch it tracks.`
      );
      expect(changes(mock).length).toBe(calls);
      // An older commit of its branch deploys. It keeps the files of the release that ran (this machine deployed it,
      // and kept them: here both builds have the same files, so none is lacking).
      expect(await deployInstance({ dir, host: "next.example.com", commit: c1, clone, net: mock.fetch, print })).toBe(c1);
      expect(lines).toContain(`The release keeps 0 files of the release before (${c2.slice(0, 12)}), for pages still open.`);

      // A plain git push to main still stops.
      const plain = run("git", "push", "origin", `${c2}:refs/heads/main`);
      expect(plain.code).not.toBe(0);
      expect(plain.err).toContain("erga: Don't push to main directly");

      // promote: main moves to staging's head when the instance that tracks staging runs it, healthy. It deploys nothing.
      // What the instance runs, and its health, come from Cloudflare: the Worker's deployment, and the server's row in D1.
      const ask = instanceReader({ net: mock.fetch });
      await expect(promote({ dir, clone, ask, print })).rejects.toThrow(
        `next.example.com (runs ${c1.slice(0, 12)}) tracks staging, and does not run ${c2.slice(0, 12)}, healthy.`
      );
      expect(remote("main")).toBe(c1);
      expect(await deployInstance({ dir, host: "next.example.com", clone, net: mock.fetch, print })).toBe(c2);
      const uploads = changes(mock).length;
      expect(await promote({ dir, clone, ask, print })).toBe(c2);
      expect([remote("staging"), remote("main")]).toEqual([c2, c2]);
      expect(lines).toContain(`main is at ${c2.slice(0, 12)} on origin.`);
      expect(lines).toContain("NEXT  example.com tracks main. Deploy the commit to it: bun erga deploy example.com");
      expect(changes(mock).length).toBe(uploads);
      expect(versionOf("erga")).toBe(c1.slice(0, 12));
      // A promote is a job of this machine: its record is in .erga/jobs/.
      const [record] = readdirSync(join(dir, "jobs")).filter((f) => f.endsWith(".jsonl"));
      expect(JSON.parse(readFileSync(join(dir, "jobs", record), "utf8").split("\n")[0])).toMatchObject({
        command: "bun erga promote",
        host: "main",
      });
      // Again: main has it.
      expect(await promote({ dir, clone, ask, print })).toBeNull();
      // The instance that tracks main gets the commit with its own deploy.
      expect(await deployInstance({ dir, host: "example.com", clone, net: mock.fetch, print })).toBe(c2);
      expect(versionOf("erga")).toBe(c2.slice(0, 12));

      // A commit whose tests did not pass does not reach main.
      const c3 = (run("git", "checkout", "-q", "--detach", c2), commit("C3: its tests fail"));
      Bun.spawnSync(["git", "push", "-q", "origin", `${c3}:refs/heads/staging`], { cwd: clone, env: { ...env, ERGA_CLI_PUSH: "1" } });
      const failing: Suite = (_, log) => (writeFileSync(log, "FAILED (1 s)\n"), null);
      await expect(promote({ dir, clone, ask, print, suite: failing })).rejects.toThrow("main stays.");
      expect(remote("main")).toBe(c2);

      // `main` and `staging` name origin's branches: the clone's own main, which nothing moves, is still at C1.
      run("git", "branch", "main", c1);
      expect([commitOf("main", clone), commitOf("staging", clone)]).toEqual([c2, c3]);

      // An instance that tracks a branch that its repository does not have: the error says how to change it.
      expect(() => trackedHead(clone, { host: "example.com", repo: REPO, branch: "gone" })).toThrow(
        `${REPO} has no branch gone, which example.com tracks. Change it: bun erga track example.com --branch <branch>`
      );
    } finally {
      process.env.PATH = PATH;
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("bun erga deploy --remove-domain", () => {
  test("a dry run changes nothing; the removal deletes the domain on Cloudflare, takes it off the instance and the entry, and tells the server", async () => {
    const mock = mockCloudflare({ fleet: true });
    mock.state.zones.push({ id: "zone00000000000000000000000e7ga4", name: "example.org", status: "active" });
    fresh(fleet, next);
    const lines: string[] = [];
    const deploy = (o: Partial<Parameters<typeof deployInstance>[0]>) =>
      deployInstance({ dir, host: "example.com", commit: "HEAD", net: mock.fetch, print: (l) => lines.push(l), ...o });
    const facts = () => JSON.parse(bindingsOf(mock.state, "erga").ERGA_DEPLOY.text).domains;
    const entry = () => (entryOf(readConfig(dir), "example.com") as CloudflareEntry).domains;
    const attached = () => mock.state.domains.map((d) => d.hostname);
    await deploy({ domains: ["example.org", "blog.example.org"] });

    // The dry run: what it removes, with what Cloudflare has now. No call changes anything.
    const before = changes(mock).length;
    const plan = await removalPlan({ dir, host: "example.com", domains: ["Example.org"], net: mock.fetch });
    expect(plan[0]).toBe("A dry run: nothing changes. bun erga deploy example.com --remove-domain example.org does this:");
    expect(plan.join("\n")).toContain("1. The custom domain example.org of the Worker erga is deleted on Cloudflare");
    expect(plan.join("\n")).toContain("3. The server: it unpublishes the document that is published to example.org");
    expect([changes(mock).length, entry(), attached().includes("example.org")]).toEqual([
      before,
      ["example.org", "blog.example.org"],
      true,
    ]);

    // Only a custom domain of the instance, and in a deploy of its own.
    await expect(deploy({ removeDomains: ["nowhere.test"] })).rejects.toThrow(
      "nowhere.test is not a custom domain of example.com. Its custom domains: example.org, blog.example.org."
    );
    await expect(deploy({ host: "next.example.com", removeDomains: ["example.org"] })).rejects.toThrow("Its custom domains: none.");
    await expect(deploy({ removeDomains: ["example.org"], domains: ["new.example.org"] })).rejects.toThrow("a deploy of its own");
    expect(changes(mock).length).toBe(before);

    // The server's row goes in when the new code is up, before the wait for its health: the release's first scheduled
    // run takes it.
    const from = lines.length;
    const uploadedFirst: boolean[] = [];
    const net: typeof mock.fetch = (input, init) => {
      if (typeof init?.body == "string" && init.body.includes("INTO removed_domains"))
        uploadedFirst.push(
          changes(mock)
            .slice(before)
            .some((c) => /^PUT .*\/workers\/scripts\/erga$/.test(c))
        );
      return mock.fetch(input, init);
    };
    await deploy({ removeDomains: ["Example.org"], net });
    const said = (text: string) => lines.findIndex((l, i) => i >= from && l.includes(text));
    expect(uploadedFirst).toEqual([true]);
    expect(said("The server unpublishes the document that is published to example.org")).toBeLessThan(said("Wait for its health..."));
    expect(attached()).toEqual(expect.arrayContaining(["example.com", "blog.example.org"]));
    expect(attached()).not.toContain("example.org");
    expect([facts(), entry()]).toEqual([["blog.example.org"], ["blog.example.org"]]);
    expect((await specOn(await sqlOn(mock, fleet)))!.target).toMatchObject({ domains: ["blog.example.org"] });
    expect((await jobsOn(mock, fleet))[0].command).toBe("bun erga deploy HEAD example.com --remove-domain example.org");
    // The domain leaves Cloudflare before the Worker's upload.
    const made = changes(mock).slice(before);
    const gone = made.findIndex((c) => /^DELETE .*\/workers\/domains\//.test(c));
    expect(gone).toBeGreaterThanOrEqual(0);
    expect(gone).toBeLessThan(made.findIndex((c) => /^PUT .*\/workers\/scripts\/erga$/.test(c)));
    const rows = () =>
      d1(
        new Cloudflare("mock-machine-token", mock.fetch),
        `/accounts/${fleet.account}`,
        databaseOf(mock.state, "erga").uuid,
        "SELECT domain FROM removed_domains ORDER BY domain",
        [],
        "read"
      );
    expect(await rows()).toEqual([{ domain: "example.org" }]);

    // The last one, which Cloudflare has no more (a run that stopped, run again): the entry has no list after.
    mock.state.domains = mock.state.domains.filter((d) => d.hostname != "blog.example.org");
    await deploy({ removeDomains: ["blog.example.org"] });
    expect(lines).toContainEqual(
      expect.stringContaining("Cloudflare has no custom domain blog.example.org: there is nothing to delete there")
    );
    expect([facts(), entry()]).toEqual([undefined, undefined]);
    expect((await specOn(await sqlOn(mock, fleet)))!.target).not.toHaveProperty("domains");
    expect(await rows()).toEqual([{ domain: "blog.example.org" }, { domain: "example.org" }]);
  }, 60_000);
});
