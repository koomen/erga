// `bun erga deploy` and `bun erga rollback` (deploy/cli/deploy.ts), from .erga/config.json, against the mock
// Cloudflare's copy of Erga's account (ERGA_DEPLOY_MOCK=1): the upload has the entry's vars, a staging entry gets
// SNAPSHOT_FROM and keeps its copy of the data, no secret goes out, the lock and the job record, the tests' gate, and
// a primary with no commit named takes the commit its staging instances report (a fake GET /api/ops).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Entry, withEntry, writeConfig } from "../deploy/cli/config";
import { deployInstance, entryTarget, lockPath, passPath, rollbackInstance, stagingCommit, takeLock } from "../deploy/cli/deploy";
import { deployFacts } from "../deploy/pipeline/account";
import { guardTarget } from "../deploy/pipeline/pipeline";
import { targetFor } from "../deploy/run";
import { mockCloudflare } from "../dev/mock-cloudflare";
import { bindingsOf, bootstrap, env, prepareRelease, productionOf, ROOT, SHA1 } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const HEAD = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
const primary: Entry = { host: "erga.dev", ...deployFacts(targetFor("production", env())), token: "erga_ops_primary" };
const stagingFacts = deployFacts(targetFor("staging", env()));
const staging: Entry = {
  host: "staging.erga.dev",
  stagingOf: "erga.dev",
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
    expect(await deployInstance({ dir, host: "staging.erga.dev", commit: "HEAD", net: mock.fetch, print: (l) => lines.push(l) })).toBe(
      HEAD
    );

    const b = bindingsOf(mock.state, "erga-staging");
    expect(b.ERGA_VERSION.text).toBe(HEAD.slice(0, 12));
    expect(b.GITHUB_CLIENT_ID.text).toBe("Ov23-from-the-entry");
    expect(b.DEPLOY_TARGET.text).toBe("staging");
    expect(b.SNAPSHOT_FROM.text).toBe("https://erga.dev");
    expect(JSON.parse(b.ERGA_DEPLOY.text).vars.SNAPSHOT_FROM).toBe("https://erga.dev");
    expect(b.DB.database_id).toBe(db);
    expect(lines.some((l) => l.startsWith("Copy production's database"))).toBe(false);
    expect(mock.state.scripts["erga-staging"].metadata.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(mock.state.secrets["erga-staging"]).toEqual(secrets);
    expect(productionOf(mock.state)).toBe(before);

    // The job record: the command, the commit, the tests, the output, the result. The lock is free again.
    const [job] = records();
    expect(job[0]).toMatchObject({ command: `bun erga deploy HEAD staging.erga.dev`, host: "staging.erga.dev", from: "terminal" });
    expect(job).toContainEqual({ commit: HEAD });
    expect(job).toContainEqual({ tests: "passed before" });
    expect(job.at(-1).result).toBe("ok");
    expect(job.filter((x) => x.out).length).toBe(lines.length);
    expect(existsSync(lockPath(dir, "staging.erga.dev"))).toBe(false);

    // A rollback by host, from the entry: the version before (the bootstrap's) serves again.
    expect(await rollbackInstance({ dir, host: "staging.erga.dev", net: mock.fetch, print: () => {} })).toBe(SHA1.slice(0, 12));
    expect(bindingsOf(mock.state, "erga-staging").ERGA_VERSION.text).toBe(SHA1.slice(0, 12));
  }, 60_000);

  test("a staging instance needs a commit; its primary's names are its guard", async () => {
    fresh(primary, staging);
    await expect(deployInstance({ dir, host: "staging.erga.dev", net: mockCloudflare({ fleet: true }).fetch })).rejects.toThrow(
      "name the commit"
    );
    const config = withEntry(withEntry({ instances: [] }, primary), { ...staging, worker: "erga" });
    expect(guardTarget(entryTarget(config, config.instances[1]))).toContain("would replace production's Worker (erga)");
    expect(entryTarget(config, primary).vars.SNAPSHOT_FROM).toBeUndefined();
  });

  test("a second deploy to the same host stops; a lock of a process that stopped is free", async () => {
    fresh(primary, staging);
    const free = takeLock(dir, "erga.dev", "bun erga deploy main erga.dev");
    await expect(deployInstance({ dir, host: "erga.dev", commit: "HEAD", net: mockCloudflare({ fleet: true }).fetch })).rejects.toThrow(
      `erga.dev is locked: bun erga deploy main erga.dev (process ${process.pid})`
    );
    free();
    expect(existsSync(lockPath(dir, "erga.dev"))).toBe(false);

    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(lockPath(dir, "erga.dev"), JSON.stringify({ pid: dead.pid, command: "bun erga deploy x erga.dev", started: "then" }));
    const mock = mockCloudflare({ fleet: true });
    expect(await deployInstance({ dir, host: "erga.dev", commit: "HEAD", net: mock.fetch, print: () => {} })).toBe(HEAD);
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
      deployInstance({ dir, host: "erga.dev", commit: "HEAD", net: mock.fetch, print: () => {}, test: failing })
    ).rejects.toThrow('did not end with "all passing"');
    expect(tested).toEqual([HEAD]);
    expect(mock.state.calls).toEqual([]);
    expect(records()[0].at(-1).result).toBe("failed");

    await deployInstance({ dir, host: "erga.dev", commit: "HEAD", noTests: true, net: mock.fetch, print: () => {}, test: failing });
    expect(tested).toEqual([HEAD]);
    expect(records().some((r) => r.some((x) => x.tests == "skipped: --no-tests") && r.at(-1).result == "ok")).toBe(true);
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
      expect(await deployInstance({ dir, host: "erga.dev", net, print: (l) => lines.push(l) })).toBe(HEAD);
      expect(asked.sort()).toEqual(["/api/health ", "/api/ops Bearer erga_ops_staging"]);
      expect(lines[0]).toBe(`The staging instances of erga.dev run ${HEAD.slice(0, 12)}, healthy: that commit deploys.`);
      expect(bindingsOf(mock.state, "erga").ERGA_VERSION.text).toBe(HEAD.slice(0, 12));
    } finally {
      server.stop(true);
    }
  }, 60_000);
});
