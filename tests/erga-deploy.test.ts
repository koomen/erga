// `bun erga deploy` and `bun erga rollback` (deploy/cli/deploy.ts), from .erga/config.json, against the mock
// Cloudflare's example account (ERGA_DEPLOY_MOCK=1): every entry takes the same path (entryTarget); the upload has the
// entry's vars, no secret goes out, the lock and the job record, and the tests' gate. A Worker keeps its database:
// its entry takes the name of the database that it is bound to. And the branches (a clone of its own): an instance
// deploys the head of the branch it tracks, and only a commit of that branch; no deploy moves a branch;
// `bun erga promote` moves main to staging's head.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CloudflareEntry, type Entry, entryOf, readConfig, withEntry, writeConfig } from "../deploy/cli/config";
import { commitOf, deployInstance, entryTarget, rollbackInstance, trackedHead } from "../deploy/cli/deploy";
import { promote, promoteRefusal } from "../deploy/cli/promote";
import { findInstance, instanceReader } from "../deploy/cli/running";
import { lockPath, takeLock } from "../deploy/cli/jobs";
import { deployFacts } from "../deploy/pipeline/account";
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
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const HEAD = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
const REPO = "github.com/koomen/erga";
const fleet: Entry = { host: "example.com", repo: REPO, branch: "main", ...deployFacts(fleetTarget()) };
const nextFacts = deployFacts(nextTarget());
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
const records = () =>
  readdirSync(join(dir, "jobs"))
    .filter((f) => f.endsWith(".jsonl"))
    .sort() // a name starts with its start time: the order of the jobs
    .map((f) =>
      readFileSync(join(dir, "jobs", f), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    );

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
    try {
      expect(await deployInstance({ dir, host: "next.example.com", commit: "HEAD", net: mock.fetch, print: (l) => lines.push(l) })).toBe(
        HEAD
      );
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

    // The job record: the command, the commit, the tests, the output, the result. The lock is free again.
    const [job] = records();
    expect(job[0]).toMatchObject({ command: `bun erga deploy HEAD next.example.com`, host: "next.example.com", from: "terminal" });
    expect(job).toContainEqual({ commit: HEAD });
    expect(job).toContainEqual({ tests: "passed" });
    expect(job.at(-1).result).toBe("ok");
    expect(job.filter((x) => x.out).length).toBe(lines.length);
    expect(existsSync(lockPath(dir, "next.example.com"))).toBe(false);

    // A rollback by host, from the entry: the version before (the bootstrap's) serves again.
    expect(await rollbackInstance({ dir, host: "next.example.com", net: mock.fetch, print: () => {} })).toBe(SHA1.slice(0, 12));
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(SHA1.slice(0, 12));
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

  test("a second deploy to the same host stops; a lock of a process that stopped is free", async () => {
    fresh(fleet, next);
    const free = takeLock(dir, "example.com", "bun erga deploy main example.com");
    await expect(deployInstance({ dir, host: "example.com", commit: "HEAD", net: mockCloudflare({ fleet: true }).fetch })).rejects.toThrow(
      `example.com is locked: bun erga deploy main example.com (process ${process.pid})`
    );
    free();
    expect(existsSync(lockPath(dir, "example.com"))).toBe(false);

    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(
      lockPath(dir, "example.com"),
      JSON.stringify({ pid: dead.pid, command: "bun erga deploy x example.com", started: "then" })
    );
    const mock = mockCloudflare({ fleet: true });
    expect(await deployInstance({ dir, host: "example.com", commit: "HEAD", net: mock.fetch, print: () => {} })).toBe(HEAD);
    expect(bindingsOf(mock.state, "erga").ERGA_VERSION.text).toBe(HEAD.slice(0, 12));

    // A job killed with its lock, and its pid given to another process later (here, this one): the lock names the
    // process by its pid and its start time, so it is free.
    writeFileSync(
      lockPath(dir, "example.com"),
      JSON.stringify({ pid: process.pid, pidStart: "Thu Jan  1 00:00:00 1970", command: "bun erga deploy x example.com", started: "then" })
    );
    expect(await deployInstance({ dir, host: "example.com", commit: "HEAD", net: mock.fetch, print: () => {} })).toBe(HEAD);
    // A lock and a job record name this process with its start time.
    const held = takeLock(dir, "example.com", "bun erga deploy main example.com");
    expect(JSON.parse(readFileSync(lockPath(dir, "example.com"), "utf8")).pidStart).toMatch(/\d\d:\d\d:\d\d/);
    held();
    expect(records().at(-1)?.[0].pidStart).toMatch(/\d\d:\d\d:\d\d/);
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
    expect(mock.state.calls).toEqual([]);
    expect(records()[0].at(-1).result).toBe("failed");

    await deploy({ noTests: true });
    expect(ran).toBe(1);
    expect(records().some((r) => r.some((x) => x.tests == "skipped: --no-tests") && r.at(-1).result == "ok")).toBe(true);
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
    expect(lines.at(-1)).toBe("next.example.com: health ok.");
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
    expect(records().at(-1)?.[0].command).toBe("bun erga deploy HEAD example.com --domain example.org");

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
      const origin = join(tmp, "origin.git");
      Bun.spawnSync(["git", "init", "-q", "--bare", origin]);
      mkdirSync(join(clone, "deploy/cli/hooks"), { recursive: true });
      for (const f of ["deploy/cli/hooks/pre-push", "deploy/cli/pre-push.ts", "deploy/cli/flow.ts"])
        copyFileSync(join(ROOT, f), join(clone, f));
      chmodSync(join(clone, "deploy/cli/hooks/pre-push"), 0o755);
      run("git", "init", "-q", "-b", "work");
      run("git", "add", "-A");
      const c1 = commit("C1");
      run("git", "remote", "add", "origin", origin);
      run("git", "push", "-q", "origin", `${c1}:refs/heads/main`, `${c1}:refs/heads/staging`);
      run("git", "config", "core.hooksPath", "deploy/cli/hooks");
      // C2 is on staging, as a merge pushes it: a clone that is not this one has it, so this one must fetch it.
      const c2 = commit("C2: the merged commit");
      Bun.spawnSync(["git", "push", "-q", "origin", `${c2}:refs/heads/staging`], { cwd: clone, env: { ...env, ERGA_CLI_PUSH: "1" } });
      run("git", "checkout", "-q", "--detach", c1);

      // Each entry tracks a branch of the origin: example.com main, next.example.com staging.
      const prod = { ...fleet, repo: origin };
      const stage = { ...next, repo: origin };
      fresh(prod, stage);
      writePass(dir, c1, clone);
      writePass(dir, c2, clone);
      const mock = mockCloudflare({ fleet: true });
      await bootstrap(mock);
      // The hook needs bun on the PATH, in the push that the CLI makes.
      process.env.PATH = env.PATH;
      const lines: string[] = [];
      const print = (l: string) => void lines.push(l);
      const versionOf = (worker: string) => bindingsOf(mock.state, worker).ERGA_VERSION.text;

      // With no commit named: the head of the branch it tracks, as the repository has it now. No branch moves.
      expect(await deployInstance({ dir, host: "next.example.com", clone, net: mock.fetch, print })).toBe(c2);
      expect(lines).toContain(`staging on ${origin} is at ${c2.slice(0, 12)}: that commit deploys.`);
      expect(await deployInstance({ dir, host: "example.com", clone, net: mock.fetch, print })).toBe(c1);
      expect([versionOf("erga-next"), versionOf("erga")]).toEqual([c2.slice(0, 12), c1.slice(0, 12)]);
      expect([remote("staging"), remote("main")]).toEqual([c2, c1]);
      expect(records().some((r) => r.some((x) => "main" in x))).toBe(false);

      // A commit that its branch does not have does not deploy: nothing is built or uploaded.
      const calls = mock.state.calls.length;
      await expect(deployInstance({ dir, host: "example.com", commit: c2, clone, net: mock.fetch, print })).rejects.toThrow(
        `${c2.slice(0, 12)} is not a commit of main on ${origin} (its head: ${c1.slice(0, 12)}). example.com deploys only a commit of the branch it tracks.`
      );
      expect(mock.state.calls.length).toBe(calls);
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
      const changes = () => mock.state.calls.filter((c) => /^(PUT|POST|DELETE|PATCH) .*\/workers\//.test(c)).length;
      const uploads = changes();
      expect(await promote({ dir, clone, ask, print })).toBe(c2);
      expect([remote("staging"), remote("main")]).toEqual([c2, c2]);
      expect(lines).toContain(`main is at ${c2.slice(0, 12)} on origin.`);
      expect(lines).toContain("NEXT  example.com tracks main. Deploy the commit to it: bun erga deploy example.com");
      expect(changes()).toBe(uploads);
      expect(versionOf("erga")).toBe(c1.slice(0, 12));
      expect(records().at(-1)?.[0]).toMatchObject({ command: "bun erga promote", host: "main" });
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
      expect(() => trackedHead(clone, { host: "example.com", repo: origin, branch: "gone" })).toThrow(
        `${origin} has no branch gone, which example.com tracks. Change it: bun erga track example.com --branch <branch>`
      );
    } finally {
      process.env.PATH = PATH;
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
