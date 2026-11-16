// `bun erga deploy` and `bun erga rollback` (deploy/cli/deploy.ts), from .erga/config.json, against the mock
// Cloudflare's example account (ERGA_DEPLOY_MOCK=1): every entry takes the same path (entryTarget); the upload has the
// entry's vars, an entry with copyOf gets SNAPSHOT_FROM and keeps its copy of the data, no secret goes out, the lock
// and the job record, and the tests' gate. With --fresh, or with no copy yet, an entry with copyOf gets a new copy of
// its source's database and documents (its SNAPSHOT_TOKEN from .erga/secrets.json); without the token, it stops before
// the build. And the branches (a clone of its own): an instance deploys the head of the branch it tracks, and only a
// commit of that branch; no deploy moves a branch; `bun erga promote` moves main to staging's head.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CloudflareEntry, type Entry, entryOf, readConfig, secretsPath, withEntry, writeConfig } from "../deploy/cli/config";
import { commitOf, deployInstance, entryTarget, rollbackInstance, trackedHead } from "../deploy/cli/deploy";
import { promote, promoteRefusal } from "../deploy/cli/promote";
import { lockPath, takeLock } from "../deploy/cli/jobs";
import { replaceSnapshotSecret } from "../deploy/cli/snapshot-secret";
import { snapshotAuth } from "../document/store/snapshot";
import { deployFacts } from "../deploy/pipeline/account";
import { ALL_STEPS, guardTarget, STEPS, stepsFor } from "../deploy/pipeline/pipeline";
import { copyCommitRefusal, readsOldSetting } from "../deploy/cli/copy-commit";
import { MOCK_SNAPSHOT_TOKEN, mockCloudflare, PRIMARY_DOCS } from "../dev/mock-cloudflare";
import {
  bindingsOf,
  bootstrap,
  prepareRelease,
  primary as primaryTarget,
  primaryOf,
  ROOT,
  SHA1,
  staging as stagingTarget,
  stagingCopies,
  stagingDbOf,
  writesToPrimary,
} from "./helpers/deploys.ts";
import type { Suite } from "../deploy/cli/test-run";
import { writePass } from "./helpers/pass.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const HEAD = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
const REPO = "github.com/koomen/erga";
const primary: Entry = { host: "example.com", repo: REPO, branch: "main", ...deployFacts(primaryTarget()), token: "erga_ops_primary" };
const stagingFacts = deployFacts(stagingTarget());
const staging: Entry = {
  host: "staging.example.com",
  repo: REPO,
  branch: "staging",
  copyOf: "example.com",
  ...stagingFacts,
  // A plain setting that only the entry has: the upload must carry it.
  vars: { ...stagingFacts.vars, GITHUB_CLIENT_ID: "Ov23-from-the-entry" },
  token: "erga_ops_staging",
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
  test("an entry with copyOf: its vars and SNAPSHOT_FROM, no other flag; its copy of the data kept; no secret sent; its source untouched", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const before = primaryOf(mock.state);
    const db = bindingsOf(mock.state, "erga-staging").DB.database_id;
    const secrets = { ...mock.state.secrets["erga-staging"] };
    fresh(primary, staging);
    const lines: string[] = [];
    // The ops page's variable, as a merge started from the page had it: the job record still says "terminal",
    // because only the CLI's command line reads it (deploy/cli/main.ts).
    const page = process.env.ERGA_JOB_FROM;
    process.env.ERGA_JOB_FROM = "page";
    try {
      expect(await deployInstance({ dir, host: "staging.example.com", commit: "HEAD", net: mock.fetch, print: (l) => lines.push(l) })).toBe(
        HEAD
      );
    } finally {
      if (page == undefined) delete process.env.ERGA_JOB_FROM;
      else process.env.ERGA_JOB_FROM = page;
    }

    const b = bindingsOf(mock.state, "erga-staging");
    expect(b.ERGA_VERSION.text).toBe(HEAD.slice(0, 12));
    expect(b.GITHUB_CLIENT_ID.text).toBe("Ov23-from-the-entry");
    expect(b.DEPLOY_TARGET).toBeUndefined();
    expect(b.SNAPSHOT_IMPORT).toBeUndefined();
    expect(b.SNAPSHOT_FROM.text).toBe("https://example.com");
    expect(JSON.parse(b.ERGA_DEPLOY.text).vars.SNAPSHOT_FROM).toBe("https://example.com");
    expect(b.DB.database_id).toBe(db);
    expect(lines.some((l) => l.startsWith("Copy its source's database"))).toBe(false);
    expect(mock.state.scripts["erga-staging"].metadata.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(mock.state.secrets["erga-staging"]).toEqual(secrets);
    expect(primaryOf(mock.state)).toBe(before);

    // The job record: the command, the commit, the tests, the output, the result. The lock is free again.
    const [job] = records();
    expect(job[0]).toMatchObject({ command: `bun erga deploy HEAD staging.example.com`, host: "staging.example.com", from: "terminal" });
    expect(job).toContainEqual({ commit: HEAD });
    expect(job).toContainEqual({ tests: "passed" });
    expect(job.at(-1).result).toBe("ok");
    expect(job.filter((x) => x.out).length).toBe(lines.length);
    expect(existsSync(lockPath(dir, "staging.example.com"))).toBe(false);

    // A rollback by host, from the entry: the version before (the bootstrap's) serves again.
    expect(await rollbackInstance({ dir, host: "staging.example.com", net: mock.fetch, print: () => {} })).toBe(SHA1.slice(0, 12));
    expect(bindingsOf(mock.state, "erga-staging").ERGA_VERSION.text).toBe(SHA1.slice(0, 12));
  }, 60_000);

  test("an entry with copyOf: its source's names are its guard, and its source must have an entry", () => {
    const config = withEntry(withEntry({ instances: [] }, primary), { ...staging, worker: "erga" });
    expect(guardTarget(entryTarget(config, config.instances[1] as CloudflareEntry))).toContain("would replace its source's Worker (erga)");
    expect(entryTarget(config, primary as CloudflareEntry).vars.SNAPSHOT_FROM).toBeUndefined();
    expect(() => entryTarget({ instances: [staging] }, staging as CloudflareEntry)).toThrow(
      "staging.example.com runs on a copy of example.com's data, and example.com has no entry"
    );
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
    expect(bindingsOf(mock.state, "erga").SNAPSHOT_FROM.text).toBe("");

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
    fresh(primary);
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

describe("every entry takes one path", () => {
  test("an entry's target is its names and its vars; an entry with copyOf adds its source, and nothing else differs", () => {
    const config = { instances: [primary, staging] };
    const p = entryTarget(config, primary as CloudflareEntry),
      s = entryTarget(config, staging as CloudflareEntry);
    const { copyOf, ...rest } = s;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(p).sort());
    expect(p.copyOf).toBeUndefined();
    expect(p.vars).toEqual((primary as CloudflareEntry).vars);
    // The one fact a server on a copy gets: its source's address. No flag says "production" or "staging".
    expect(s.vars).toEqual({ ...(staging as CloudflareEntry).vars, SNAPSHOT_FROM: "https://example.com" });
    expect(copyOf).toEqual({
      accountId: p.accountId,
      worker: "erga",
      database: "erga",
      host: "example.com",
      pages: "example-pages.com",
      origin: "https://example.com",
    });
    // The same steps for both; the copy of the source's data adds its three.
    expect(stepsFor(p)).toEqual([...STEPS]);
    expect(stepsFor(s)).toEqual([...STEPS]);
    expect(stepsFor(entryTarget(config, staging as CloudflareEntry, { token: "t".repeat(32), fresh: true }))).toEqual([...ALL_STEPS]);
  });

  test("a commit from before SNAPSHOT_FROM alone made a server admins only does not deploy to an instance on a copy", () => {
    expect(readsOldSetting('DEPLOY_TARGET: bindings.text(""),')).toBe(true);
    expect(readsOldSetting('SNAPSHOT_FROM: bindings.text(""),')).toBe(false);
    // This commit's own config has no such setting; a clone with no Worker config says nothing (the build stops it).
    expect(copyCommitRefusal(ROOT, HEAD, "staging.example.com")).toBeNull();
    expect(copyCommitRefusal(tmpdir(), HEAD, "staging.example.com")).toBeNull();
  });
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
    const before = primaryOf(mock.state);
    const copy = stagingDbOf(mock.state).name;
    mock.state.docs["erga-staging"].docs
      .get(PRIMARY_DOCS[0])!
      .entries.set("file:index.html", new TextEncoder().encode("edited on staging"));
    fresh(primary, staging);

    // Without --fresh: the copy stays, with what an admin changed on it, and nothing is exported. No token is needed.
    const mark = mock.state.calls.length;
    await deploy(mock);
    expect(stagingDbOf(mock.state).name).toBe(copy);
    expect(words(mock, PRIMARY_DOCS[0])).toBe("edited on staging");
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
    for (const id of PRIMARY_DOCS) expect(words(mock, id)).toContain("the primary's words");
    expect(records().at(-1)).toContainEqual({ copy: "fresh" });
    expect(bindingsOf(mock.state, "erga-staging").SNAPSHOT_FROM.text).toBe("https://example.com");
    expect(primaryOf(mock.state)).toBe(before);
    expect(writesToPrimary(mock.state)).toEqual([]);
  }, 60_000);

  test("an instance with no copy yet gets one without --fresh; an instance on its own data refuses --fresh", async () => {
    const mock = mockCloudflare({ fleet: true });
    // The staging Worker isn't there yet, but its secrets are (as setup gives them): the deploy sends none.
    mock.state.secrets["erga-staging"] = { SESSION_SECRET: "mock-staging-session-secret", SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN };
    fresh(primary, staging);
    writeFileSync(secretsPath(dir), JSON.stringify({ "example.com": { SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN } }));
    await deploy(mock);
    expect(stagingDbOf(mock.state).name.startsWith("erga-staging-")).toBe(true);
    expect(exported(mock, 0)).toBe(true);
    for (const id of PRIMARY_DOCS) expect(words(mock, id)).toContain("the primary's words");
    expect(records().at(-1)).toContainEqual({ copy: "no copy yet" });

    await expect(deployInstance({ dir, host: "example.com", commit: "HEAD", fresh: true, net: mock.fetch })).rejects.toThrow(
      "--fresh is only for an instance on a copy of another's data"
    );
  }, 60_000);
});

describe("bun erga snapshot-secret", () => {
  test("a new secret on the instance and each copy of it, and in the secrets file; the old one opens nothing", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    fresh(primary, staging);
    writeFileSync(secretsPath(dir), JSON.stringify({ "example.com": { SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN, FACTORY_KEY: "kept" } }));
    const lines: string[] = [];
    const hosts = await replaceSnapshotSecret({ dir, host: "example.com", net: mock.fetch, print: (l) => lines.push(l) });
    expect(hosts).toEqual(["example.com", "staging.example.com"]);
    const file = JSON.parse(readFileSync(secretsPath(dir), "utf8"));
    const now = file["example.com"].SNAPSHOT_TOKEN as string;
    expect(now).toMatch(/^[0-9a-f]{64}$/);
    expect(now).not.toBe(MOCK_SNAPSHOT_TOKEN);
    expect(file["example.com"].FACTORY_KEY).toBe("kept");
    expect([mock.state.secrets.erga.SNAPSHOT_TOKEN, mock.state.secrets["erga-staging"].SNAPSHOT_TOKEN]).toEqual([now, now]);
    // The output names the servers, never the secret.
    expect(lines.join("\n")).not.toContain(now);
    // The primary answers a request signed with the new secret, and refuses the old one's.
    const ask = async (secret: string) => {
      const url = "https://example.com/api/snapshot/docs",
        body = JSON.stringify({ ids: [PRIMARY_DOCS[0]] });
      return (await mock.fetch(url, { method: "POST", headers: { Authorization: await snapshotAuth(secret, "POST", url, body) }, body }))
        .status;
    };
    expect([await ask(now), await ask(MOCK_SNAPSHOT_TOKEN)]).toEqual([200, 403]);
    // A fresh copy of the documents works with the new secret.
    await deployInstance({ dir, host: "staging.example.com", commit: "HEAD", fresh: true, net: mock.fetch, print: () => {} });
    expect(records().at(-1)).toContainEqual({ copy: "fresh" });
  }, 60_000);

  test("it names the source: a copy, and a host with no entry, are refused before any change", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    fresh(primary, staging);
    const calls = mock.state.calls.length;
    await expect(replaceSnapshotSecret({ dir, host: "staging.example.com", net: mock.fetch })).rejects.toThrow(
      "staging.example.com runs on a copy of example.com's data: name the source (bun erga snapshot-secret example.com)."
    );
    await expect(replaceSnapshotSecret({ dir, host: "nope.example.com", net: mock.fetch })).rejects.toThrow("has no entry");
    expect(mock.state.calls.length).toBe(calls);
    expect(mock.state.secrets.erga.SNAPSHOT_TOKEN).toBe(MOCK_SNAPSHOT_TOKEN);
  });
});

describe("bun erga deploy --domain", () => {
  test("registers each custom domain on the instance; the server keeps them, and the entry copies them from the server", async () => {
    const mock = mockCloudflare({ fleet: true });
    mock.state.zones.push({ id: "zone00000000000000000000000e7ga4", name: "example.org", status: "active" });
    fresh(primary, staging);
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

  test("only a name on the account's zones, never for an instance on a copy, never the app's own address", async () => {
    const mock = mockCloudflare({ fleet: true });
    fresh(primary, staging);
    const deploy = (host: string, domain: string, commit = "HEAD") =>
      deployInstance({ dir, host, commit, domains: [domain], net: mock.fetch, print: () => {} });
    await expect(deploy("example.com", "nowhere.test")).rejects.toThrow("nowhere.test is on none of this Cloudflare account's zones");
    await expect(deploy("example.com", "not a domain")).rejects.toThrow("give a domain name");
    await expect(deploy("example.com", "example.com")).rejects.toThrow("is the app's address");
    await expect(deploy("staging.example.com", "example.org")).rejects.toThrow("on a copy of another's data serves no custom domain");
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

      // Each entry tracks a branch of the origin: example.com main, staging.example.com staging.
      const prod = { ...primary, repo: origin };
      const stage = { ...staging, repo: origin };
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
      expect(await deployInstance({ dir, host: "staging.example.com", clone, net: mock.fetch, print })).toBe(c2);
      expect(lines).toContain(`staging on ${origin} is at ${c2.slice(0, 12)}: that commit deploys.`);
      expect(await deployInstance({ dir, host: "example.com", clone, net: mock.fetch, print })).toBe(c1);
      expect([versionOf("erga-staging"), versionOf("erga")]).toEqual([c2.slice(0, 12), c1.slice(0, 12)]);
      expect([remote("staging"), remote("main")]).toEqual([c2, c1]);
      expect(records().some((r) => r.some((x) => "main" in x))).toBe(false);

      // A commit that its branch does not have does not deploy: nothing is built or uploaded.
      const calls = mock.state.calls.length;
      await expect(deployInstance({ dir, host: "example.com", commit: c2, clone, net: mock.fetch, print })).rejects.toThrow(
        `${c2.slice(0, 12)} is not a commit of main on ${origin} (its head: ${c1.slice(0, 12)}). example.com deploys only a commit of the branch it tracks.`
      );
      expect(mock.state.calls.length).toBe(calls);
      // An older commit of its branch deploys.
      expect(await deployInstance({ dir, host: "staging.example.com", commit: c1, clone, net: mock.fetch, print })).toBe(c1);
      expect(await deployInstance({ dir, host: "staging.example.com", clone, net: mock.fetch, print })).toBe(c2);

      // A plain git push to main still stops.
      const plain = run("git", "push", "origin", `${c2}:refs/heads/main`);
      expect(plain.code).not.toBe(0);
      expect(plain.err).toContain("erga: Don't push to main directly");

      // promote: main moves to staging's head when the instance that tracks staging runs it, healthy. It deploys nothing.
      let runs = c1;
      const site = async (url: string) =>
        Response.json(url.endsWith("/api/ops") ? { version: runs.slice(0, 12), host: "x", deploy: null } : { ok: true });
      await expect(promote({ dir, clone, site, print })).rejects.toThrow(
        `staging.example.com (runs ${c1.slice(0, 12)}) tracks staging, and does not run ${c2.slice(0, 12)}, healthy.`
      );
      expect(remote("main")).toBe(c1);
      runs = c2;
      const uploads = mock.state.calls.length;
      expect(await promote({ dir, clone, site, print })).toBe(c2);
      expect([remote("staging"), remote("main")]).toEqual([c2, c2]);
      expect(lines).toContain(`main is at ${c2.slice(0, 12)} on origin.`);
      expect(lines).toContain("NEXT  example.com tracks main. Deploy the commit to it: bun erga deploy example.com");
      expect(mock.state.calls.length).toBe(uploads);
      expect(versionOf("erga")).toBe(c1.slice(0, 12));
      expect(records().at(-1)?.[0]).toMatchObject({ command: "bun erga promote", host: "main" });
      // Again: main has it.
      expect(await promote({ dir, clone, site, print })).toBeNull();
      // The instance that tracks main gets the commit with its own deploy.
      expect(await deployInstance({ dir, host: "example.com", clone, net: mock.fetch, print })).toBe(c2);
      expect(versionOf("erga")).toBe(c2.slice(0, 12));

      // A commit whose tests did not pass does not reach main.
      const c3 = (run("git", "checkout", "-q", "--detach", c2), commit("C3: its tests fail"));
      Bun.spawnSync(["git", "push", "-q", "origin", `${c3}:refs/heads/staging`], { cwd: clone, env: { ...env, ERGA_CLI_PUSH: "1" } });
      const failing: Suite = (_, log) => (writeFileSync(log, "FAILED (1 s)\n"), null);
      await expect(promote({ dir, clone, site, print, suite: failing })).rejects.toThrow("main stays.");
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
