// `bun erga deploy` and `bun erga rollback` (deploy/cli/deploy.ts), from .erga/config.json, against the mock
// Cloudflare's example account (ERGA_DEPLOY_MOCK=1): the upload has the entry's vars, a staging entry gets
// SNAPSHOT_FROM and keeps its copy of the data, no secret goes out, the lock and the job record, the tests' gate, and
// a primary with no commit named takes the commit its staging instances report (a fake GET /api/ops). With --fresh, or
// with no copy yet, a staging entry gets a new copy of its primary's database and documents (its SNAPSHOT_TOKEN from
// .erga/secrets.json); without the token, it stops before the build. And the branches: merge deploys to each staging
// instance, then pushes staging; a primary's deploy then moves main (a clone of its own).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Entry, secretsPath, withEntry, writeConfig } from "../deploy/cli/config";
import {
  deployInstance,
  deployStaging,
  entryTarget,
  lockPath,
  passPath,
  rollbackInstance,
  stagingCommit,
  takeLock,
} from "../deploy/cli/deploy";
import { deployFacts } from "../deploy/pipeline/account";
import { guardTarget } from "../deploy/pipeline/pipeline";
import { MOCK_SNAPSHOT_TOKEN, mockCloudflare, PROD_DOCS } from "../dev/mock-cloudflare";
import {
  bindingsOf,
  bootstrap,
  prepareRelease,
  primary as primaryTarget,
  productionOf,
  ROOT,
  SHA1,
  staging as stagingTarget,
  stagingCopies,
  stagingDbOf,
  writesToProduction,
} from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const HEAD = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
const primary: Entry = { host: "example.com", ...deployFacts(primaryTarget()), token: "erga_ops_primary" };
const stagingFacts = deployFacts(stagingTarget());
const staging: Entry = {
  host: "staging.example.com",
  stagingOf: "example.com",
  ...stagingFacts,
  // A plain setting that only the entry has: the upload must carry it.
  vars: { ...stagingFacts.vars, GITHUB_CLIENT_ID: "Ov23-from-the-entry" },
  token: "erga_ops_staging",
};

let dir = "";
const fresh = (...entries: Entry[]) => {
  dir = join(mkdtempSync(join(tmpdir(), "erga-deploy-")), ".erga");
  writeConfig(dir, entries.reduce(withEntry, { instances: [] }));
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(passPath(dir, HEAD), "all passing\n");
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
  test("a staging entry: its vars, DEPLOY_TARGET=staging and SNAPSHOT_FROM; its copy of the data kept; no secret sent; production untouched", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const before = productionOf(mock.state);
    const db = bindingsOf(mock.state, "erga-staging").DB.database_id;
    const secrets = { ...mock.state.secrets["erga-staging"] };
    fresh(primary, staging);
    const lines: string[] = [];
    expect(await deployInstance({ dir, host: "staging.example.com", commit: "HEAD", net: mock.fetch, print: (l) => lines.push(l) })).toBe(
      HEAD
    );

    const b = bindingsOf(mock.state, "erga-staging");
    expect(b.ERGA_VERSION.text).toBe(HEAD.slice(0, 12));
    expect(b.GITHUB_CLIENT_ID.text).toBe("Ov23-from-the-entry");
    expect(b.DEPLOY_TARGET.text).toBe("staging");
    expect(b.SNAPSHOT_FROM.text).toBe("https://example.com");
    expect(JSON.parse(b.ERGA_DEPLOY.text).vars.SNAPSHOT_FROM).toBe("https://example.com");
    expect(b.DB.database_id).toBe(db);
    expect(lines.some((l) => l.startsWith("Copy production's database"))).toBe(false);
    expect(mock.state.scripts["erga-staging"].metadata.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(mock.state.secrets["erga-staging"]).toEqual(secrets);
    expect(productionOf(mock.state)).toBe(before);

    // The job record: the command, the commit, the tests, the output, the result. The lock is free again.
    const [job] = records();
    expect(job[0]).toMatchObject({ command: `bun erga deploy HEAD staging.example.com`, host: "staging.example.com", from: "terminal" });
    expect(job).toContainEqual({ commit: HEAD });
    expect(job).toContainEqual({ tests: "passed before" });
    expect(job.at(-1).result).toBe("ok");
    expect(job.filter((x) => x.out).length).toBe(lines.length);
    expect(existsSync(lockPath(dir, "staging.example.com"))).toBe(false);

    // A rollback by host, from the entry: the version before (the bootstrap's) serves again.
    expect(await rollbackInstance({ dir, host: "staging.example.com", net: mock.fetch, print: () => {} })).toBe(SHA1.slice(0, 12));
    expect(bindingsOf(mock.state, "erga-staging").ERGA_VERSION.text).toBe(SHA1.slice(0, 12));
  }, 60_000);

  test("a staging instance needs a commit; its primary's names are its guard", async () => {
    fresh(primary, staging);
    await expect(deployInstance({ dir, host: "staging.example.com", net: mockCloudflare({ fleet: true }).fetch })).rejects.toThrow(
      "name the commit"
    );
    const config = withEntry(withEntry({ instances: [] }, primary), { ...staging, worker: "erga" });
    expect(guardTarget(entryTarget(config, config.instances[1]))).toContain("would replace production's Worker (erga)");
    expect(entryTarget(config, primary).vars.SNAPSHOT_FROM).toBeUndefined();
  });

  test("a second deploy to the same host stops; a lock of a process that stopped is free", async () => {
    fresh(primary, staging);
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
    expect(bindingsOf(mock.state, "erga").SNAPSHOT_FROM).toBeUndefined();
  }, 60_000);

  test("the tests' gate: a commit with no pass runs them, and a failure stops before the build; --no-tests is in the record", async () => {
    fresh(primary);
    rmSync(passPath(dir, HEAD));
    const mock = mockCloudflare({ fleet: true });
    const tested: string[] = [];
    const failing = async (sha: string) => (tested.push(sha), false);
    await expect(
      deployInstance({ dir, host: "example.com", commit: "HEAD", net: mock.fetch, print: () => {}, test: failing })
    ).rejects.toThrow('did not end with "all passing"');
    expect(tested).toEqual([HEAD]);
    expect(mock.state.calls).toEqual([]);
    expect(records()[0].at(-1).result).toBe("failed");

    await deployInstance({ dir, host: "example.com", commit: "HEAD", noTests: true, net: mock.fetch, print: () => {}, test: failing });
    expect(tested).toEqual([HEAD]);
    expect(records().some((r) => r.some((x) => x.tests == "skipped: --no-tests") && r.at(-1).result == "ok")).toBe(true);
  }, 60_000);
});

describe("bun erga deploy --fresh", () => {
  const words = (mock: ReturnType<typeof mockCloudflare>, id: string) =>
    new TextDecoder().decode(mock.state.docs["erga-staging"].docs.get(id)?.entries.get("file:index.html") as Uint8Array);
  /** Whether the primary's database was exported since the call numbered `from`. */
  const exported = (mock: ReturnType<typeof mockCloudflare>, from: number) =>
    mock.state.calls.slice(from).some((c) => c.endsWith("/export"));
  const deploy = (mock: ReturnType<typeof mockCloudflare>, fresh?: boolean) =>
    deployInstance({ dir, host: "staging.example.com", commit: "HEAD", fresh, net: mock.fetch, print: () => {} });

  test("a new database with the primary's data and documents; without --fresh, nothing copies; without the token, it stops before the build", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const before = productionOf(mock.state);
    const copy = stagingDbOf(mock.state).name;
    mock.state.docs["erga-staging"].docs.get(PROD_DOCS[0])!.entries.set("file:index.html", new TextEncoder().encode("edited on staging"));
    fresh(primary, staging);

    // Without --fresh: the copy stays, with what an admin changed on it, and nothing is exported. No token is needed.
    const mark = mock.state.calls.length;
    await deploy(mock);
    expect(stagingDbOf(mock.state).name).toBe(copy);
    expect(words(mock, PROD_DOCS[0])).toBe("edited on staging");
    expect(exported(mock, mark)).toBe(false);

    // --fresh with no SNAPSHOT_TOKEN: it says where to put it, and nothing is built or uploaded.
    const calls = mock.state.calls.length;
    await expect(deploy(mock, true)).rejects.toThrow(`Put it in ${secretsPath(dir)} as { "example.com": { "SNAPSHOT_TOKEN": "..." } }`);
    expect(mock.state.calls.slice(calls).every((c) => c.startsWith("GET "))).toBe(true);
    expect(records().at(-1)!.at(-1).result).toBe("failed");

    // With the token in .erga/secrets.json: a new database, bound; the old copy deleted; the primary's documents.
    writeFileSync(secretsPath(dir), JSON.stringify({ "example.com": { SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN } }));
    const again = mock.state.calls.length;
    await deploy(mock, true);
    const now = stagingDbOf(mock.state);
    expect(now.name).not.toBe(copy);
    expect(now.name.startsWith("erga-staging-")).toBe(true);
    expect(stagingCopies(mock.state)).toEqual([now.name]);
    expect((now.rows ?? []).join("\n")).toContain("doc-1");
    expect(exported(mock, again)).toBe(true);
    for (const id of PROD_DOCS) expect(words(mock, id)).toContain("production's words");
    expect(records().at(-1)).toContainEqual({ copy: "fresh" });
    expect(bindingsOf(mock.state, "erga-staging").SNAPSHOT_IMPORT.text).toBe("1");
    expect(productionOf(mock.state)).toBe(before);
    expect(writesToProduction(mock.state)).toEqual([]);
  }, 60_000);

  test("a staging instance with no copy yet gets one without --fresh; a primary refuses --fresh", async () => {
    const mock = mockCloudflare({ fleet: true });
    // The staging Worker isn't there yet, but its secrets are (as setup gives them): the deploy sends none.
    mock.state.secrets["erga-staging"] = { SESSION_SECRET: "mock-staging-session-secret", SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN };
    fresh(primary, staging);
    writeFileSync(secretsPath(dir), JSON.stringify({ "example.com": { SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN } }));
    await deploy(mock);
    expect(stagingDbOf(mock.state).name.startsWith("erga-staging-")).toBe(true);
    expect(exported(mock, 0)).toBe(true);
    for (const id of PROD_DOCS) expect(words(mock, id)).toContain("production's words");
    expect(records().at(-1)).toContainEqual({ copy: "no copy yet" });

    await expect(deployInstance({ dir, host: "example.com", commit: "HEAD", fresh: true, net: mock.fetch })).rejects.toThrow(
      "--fresh is only for a staging instance"
    );
  }, 60_000);
});

describe("a primary with no commit", () => {
  test("takes the one commit its staging instances run, healthy; else it says why", () => {
    const ok = (host: string, version: string) => ({ host, version, healthy: true });
    expect(stagingCommit("a.com", [ok("s.a.com", "abc")])).toEqual({ version: "abc" });
    expect(stagingCommit("a.com", [])).toEqual({ problem: expect.stringContaining("bun erga deploy <commit> a.com") });
    expect(stagingCommit("a.com", [ok("s.a.com", "abc"), ok("t.a.com", "def")])).toEqual({
      problem: expect.stringContaining("different commits"),
    });
    expect(stagingCommit("a.com", [{ ...ok("s.a.com", "abc"), healthy: false }])).toEqual({
      problem: expect.stringContaining("Not healthy"),
    });
  });

  test("deploys the commit that GET /api/ops of its staging instance reports", async () => {
    const asked: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        asked.push(`${path} ${req.headers.get("authorization") ?? ""}`);
        if (path == "/api/ops") return Response.json({ version: HEAD.slice(0, 12), target: "staging", host: "x", deploy: null });
        if (path == "/api/health") return Response.json({ ok: true });
        return new Response("no", { status: 404 });
      },
    });
    try {
      const fake = `127.0.0.1:${server.port}`;
      fresh(primary, { ...staging, host: fake });
      const mock = mockCloudflare({ fleet: true });
      const net: typeof mock.fetch = (input, init) => (String(input).includes(fake) ? fetch(input, init) : mock.fetch(input, init));
      const lines: string[] = [];
      expect(await deployInstance({ dir, host: "example.com", net, print: (l) => lines.push(l) })).toBe(HEAD);
      expect(asked.sort()).toEqual(["/api/health ", "/api/ops Bearer erga_ops_staging"]);
      expect(lines[0]).toBe(`The staging instances of example.com run ${HEAD.slice(0, 12)}, healthy: that commit deploys.`);
      expect(bindingsOf(mock.state, "erga").ERGA_VERSION.text).toBe(HEAD.slice(0, 12));
    } finally {
      server.stop(true);
    }
  }, 60_000);
});

describe("the branches move only after a healthy deploy", () => {
  test("merge: one deploy to each staging instance, then staging; a primary: its deploy, then main; a plain push stops", async () => {
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
      Bun.spawnSync(["git", "init", "-q", "--bare", join(tmp, "origin.git")]);
      mkdirSync(join(clone, "deploy/cli/hooks"), { recursive: true });
      for (const f of ["deploy/cli/hooks/pre-push", "deploy/cli/pre-push.ts", "deploy/cli/flow.ts"])
        copyFileSync(join(ROOT, f), join(clone, f));
      chmodSync(join(clone, "deploy/cli/hooks/pre-push"), 0o755);
      run("git", "init", "-q", "-b", "work");
      run("git", "add", "-A");
      const c1 = commit("C1");
      run("git", "remote", "add", "origin", join(tmp, "origin.git"));
      run("git", "push", "-q", "origin", `${c1}:refs/heads/main`, `${c1}:refs/heads/staging`);
      run("git", "config", "core.hooksPath", "deploy/cli/hooks");
      const c2 = commit("C2: the merged commit");

      fresh(primary, staging);
      writeFileSync(passPath(dir, c2), "all passing\n");
      const mock = mockCloudflare({ fleet: true });
      await bootstrap(mock);
      // The hook needs bun on the PATH, in the push that the CLI makes.
      process.env.PATH = env.PATH;
      const seen: string[] = [];
      const print = (l: string) => {
        if (l.startsWith("Deployed")) seen.push(`deployed; staging ${remote("staging").slice(0, 7)}, main ${remote("main").slice(0, 7)}`);
        if (/ is at .* on origin\.$/.test(l)) seen.push(l);
      };

      // merge: the deploy to staging.example.com, then the push of staging. main stays.
      expect(await deployStaging({ dir, sha: c2, clone, net: mock.fetch, print })).toEqual(["staging.example.com"]);
      expect(seen).toEqual([`deployed; staging ${c1.slice(0, 7)}, main ${c1.slice(0, 7)}`, `staging is at ${c2.slice(0, 12)} on origin.`]);
      expect(bindingsOf(mock.state, "erga-staging").ERGA_VERSION.text).toBe(c2.slice(0, 12));
      expect([remote("staging"), remote("main")]).toEqual([c2, c1]);

      // A plain git push to main still stops.
      const plain = run("git", "push", "origin", `${c2}:refs/heads/main`);
      expect(plain.code).not.toBe(0);
      expect(plain.err).toContain("erga: Don't push to main directly");

      // A primary: the deploy, then main moves to its commit. Again: main has it, and stays.
      seen.length = 0;
      expect(await deployInstance({ dir, host: "example.com", commit: c2, clone, net: mock.fetch, print })).toBe(c2);
      expect(seen).toEqual([`deployed; staging ${c2.slice(0, 7)}, main ${c1.slice(0, 7)}`, `main is at ${c2.slice(0, 12)} on origin.`]);
      expect(bindingsOf(mock.state, "erga").ERGA_VERSION.text).toBe(c2.slice(0, 12));
      const lines: string[] = [];
      await deployInstance({ dir, host: "example.com", commit: c2, clone, net: mock.fetch, print: (l) => lines.push(l) });
      expect(lines).toContain(`main has ${c2.slice(0, 12)} already: main stays.`);
      expect(records().some((r) => r.some((x) => x.main == "kept"))).toBe(true);

      // A commit apart from main does not deploy: nothing is built or uploaded.
      run("git", "checkout", "-q", "--detach", c1);
      const apart = commit("C3: not on main");
      writeFileSync(passPath(dir, apart), "all passing\n");
      const calls = mock.state.calls.length;
      await expect(deployInstance({ dir, host: "example.com", commit: apart, clone, net: mock.fetch, print })).rejects.toThrow(
        "is not on main"
      );
      expect(mock.state.calls.length).toBe(calls);
      expect(remote("main")).toBe(c2);
    } finally {
      process.env.PATH = PATH;
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
