// The deployer on Cloudflare (deploy/deployer/worker.ts): one run is one deploy. Against a real D1 binding, in the
// Workers runtime on this machine (Miniflare), the mock Cloudflare for the API, a pretend GitHub, the instance's own
// /api/health as the test says it, and a clock of the test's own. Nothing real is touched, and no test waits.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { assetHash, servedAssets } from "../deploy/deployer/cloudflare";
import { readControl } from "../deploy/deployer/control";
import { type D1, statementsOf } from "../deploy/deployer/d1-binding";
import { readJobs, readLog, type Sql, writeSpec } from "../deploy/deployer/instance";
import { decodeSpec, type Spec } from "../deploy/deployer/spec";
import { CALLS, deployer, HEALTH_MS, LOCK_MS, type State, specOf } from "../deploy/deployer/worker";
import { deployerModule } from "../deploy/pipeline/deployer";
import { FLEET_ACCOUNT } from "../dev/mock-cloudflare";
import { instanceOn, SPEC } from "./helpers/binding.ts";
import { bindingsOf, prepareRelease, release, ROOT, SHA1, SHA2, SHA3 } from "./helpers/deploys.ts";
import { builtBundle } from "./helpers/github.ts";

const run = Effect.runPromise;
const short = (sha: string) => sha.slice(0, 12);
const MIGRATIONS = join(ROOT, "server/migrations");
const files = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith(".sql"))
  .sort();
const AT = `main on github.com/example/erga is at ${short(SHA2)}`;

/** The Workers runtime, with databases that the tests take one by one. */
const NAMES = Array.from({ length: 12 }, (_, i) => `DB${i}`);
let runtime: Miniflare;
let next = 0;

beforeAll(async () => {
  await prepareRelease();
  runtime = new Miniflare(
    convertV4MiniflareOptions({ modules: true, script: "export default {}", compatibilityDate: "2026-09-01", d1Databases: NAMES })
  );
  await runtime.ready;
}, 120_000);
afterAll(() => runtime?.dispose());

/** The instance, with a new database of the runtime as the deployer's binding. `once`: one run of the deployer, and the line that it said. */
async function instance(o: { auto?: boolean } = {}) {
  const d1 = (await runtime.getD1Database(NAMES[next++])) as unknown as D1;
  const made = await instanceOn(d1);
  if (o.auto !== false) await run(made.sql("INSERT INTO deploy_control (id, auto) VALUES (1, 1)", []));
  const once = async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      await deployer(made.io).scheduled(null, made.env);
    } finally {
      console.log = log;
    }
    return lines.join("\n");
  };
  const runs = () => bindingsOf(made.mock.state, "erga-next").ERGA_VERSION.text as string;
  const stored = () => JSON.parse(made.store.cell.get("state") ?? "{}") as State;
  return { ...made, d1, once, runs, stored };
}

const logOf = async (sql: Sql, id: number) => new TextDecoder().decode(await run(readLog(sql, id, 0)));
/** An admin's ask, as the app writes it on the instance's row. */
const asks = (sql: Sql, ask: string, by = "ada") =>
  run(sql("UPDATE deploy_control SET ask = ?, ask_by = ?, ask_at = 1 WHERE id = 1", [ask, by]));
/** A call of Cloudflare's, with each id as *. */
const kind = (call: string) =>
  call
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "*")
    .replace(/upload\/[0-9a-f]{32}/, "upload/*")
    .replace(/\?.*$/, "");

describe("a run of the deployer", () => {
  test("auto-deploy: the head's release goes on the instance in one run, with its job's copy on the instance", async () => {
    const { mock, sql, hub, state, once, runs, stored, calls } = await instance();
    expect(runs()).toBe(short(SHA1));
    const line = await once();
    expect(line).toMatch(new RegExp(`^${AT}\\. Its deploy is done\\. \\((\\d+) calls\\)$`));
    expect(runs()).toBe(short(SHA2));
    // Its calls: far under Cloudflare's 50 for one run.
    expect(Number(/\((\d+) calls\)/.exec(line)![1])).toBeLessThan(20);
    const [job, ...more] = await run(readJobs(sql));
    expect(more).toEqual([]);
    expect(job).toMatchObject({ kind: "deploy", command: `deploy ${SHA2}`, source: "auto-deploy", sha: SHA2, state: { at: "done" } });
    expect((await logOf(sql, job.id)).split("\n").map((l) => l.replace(/: done.*$/, ": done"))).toEqual([
      `${AT}: auto-deploy deploys its release.`,
      "Fetch the release from GitHub...",
      "Fetch the release from GitHub: done",
      "Set up the database's tables...",
      "Set up the database's tables: done",
      "Upload the editor's files...",
      "Upload the editor's files: done",
      "Upload the Worker, with its settings...",
      "Upload the Worker, with its settings: done",
      "Wait for its health...",
      "Wait for its health: done",
      "",
    ]);
    expect(await logOf(sql, job.id)).toContain(
      `Wait for its health: done, release ${short(SHA2)}, healthy (db ok 1 ms, documents ok 2 ms)`
    );
    // The health is the instance's own answer at its public address: asked one time, and it was the new release's.
    expect(state.asked).toEqual(["public", "public"]);
    expect(await run(readControl(sql))).toMatchObject({
      auto: true,
      head: SHA2,
      commits: [
        { sha: SHA2, release: "released" },
        { sha: SHA1, release: "none" },
      ],
    });
    // At Cloudflare: the instance's Worker only, and no call for a database.
    const acc = `/accounts/${FLEET_ACCOUNT}`;
    expect([...new Set(calls().map(kind))].sort()).toEqual(
      [
        `GET ${acc}/workers/scripts/erga-next/deployments`,
        `POST ${acc}/workers/scripts/erga-next/assets-upload-session`,
        `PUT ${acc}/workers/scripts/erga-next`,
      ].sort()
    );
    // The files' hashes are the ones that a deploy from a machine sends (cloudflare.ts, assetHash).
    for (const [path, bytes] of Object.entries(servedAssets(release)))
      expect(mock.state.assets.manifest[path].hash).toBe(await assetHash(path, bytes));
    // The store: the commit that it tried, no job, and no lock.
    expect(stored()).toMatchObject({ tried: { sha: SHA2, ok: true, up: true }, auto: true, head: SHA2 });
    expect(stored().job).toBeUndefined();
    expect(stored().lock).toBeUndefined();

    // The next run: nothing to deploy, and nothing fetched.
    const from = hub.state.calls.length;
    const before = calls().length;
    expect(await once()).toBe(`${AT}. The instance has ${short(SHA2)}: nothing to deploy. (1 calls)`);
    expect(hub.state.calls.slice(from)).toEqual(["refs"]);
    expect(calls().length).toBe(before);
    expect(await run(readJobs(sql))).toHaveLength(1);
  }, 30_000);

  test("an unhealthy release goes back to the version before with one call, in the same run; it is not tried again", async () => {
    const { mock, sql, state, once, runs, calls } = await instance();
    mock.state.unhealthy = [short(SHA2)];
    const from = state.now;
    const line = await once();
    expect(line).toMatch(
      new RegExp(
        `^${AT}\\. Its deploy failed: Release ${short(SHA2)} is deployed to erga-next, but it is not healthy after 30 seconds: documents: a document didn't open\\. It is rolled back to [0-9a-f-]{36}, which ran before\\. \\(\\d+ calls\\)$`
      )
    );
    expect(runs()).toBe(short(SHA1));
    // It asked for the health for 30 seconds of the clock's time, and no longer.
    expect(state.now - from).toBe(HEALTH_MS);
    expect(calls().map(kind).at(-1)).toBe(`POST /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-next/deployments`);
    const [job] = await run(readJobs(sql));
    expect(job.state).toMatchObject({ at: "failed" });
    expect(await logOf(sql, job.id)).toContain("It goes back to ");
    // The head stays: the deployer waits for a new commit, or for an ask.
    expect(await once()).toBe(`${AT}. Its deploy failed: the deployer waits for a new commit, or for an admin's ask. (1 calls)`);
    expect(await run(readJobs(sql))).toHaveLength(1);
  }, 30_000);

  test("a release that fails as it starts gives no report: it goes back too. Behind Cloudflare Access, the instance's Worker answers", async () => {
    const broken = await instance();
    broken.mock.state.silent = [short(SHA2)];
    expect(await broken.once()).toContain(
      "is not healthy after 30 seconds: it answered 500, and not the server's own report. It is rolled back to "
    );
    expect(broken.runs()).toBe(short(SHA1));

    const gated = await instance();
    gated.state.access = true;
    expect(await gated.once()).toContain("Its deploy is done.");
    expect(gated.runs()).toBe(short(SHA2));
    // The public address gave Access's page: the same request then goes to the Worker itself (the look's, then the deploy's).
    expect(gated.state.asked).toEqual(["public", "direct", "public", "direct"]);
  }, 30_000);

  test("asks: a rollback goes to the version before; a commit must be on the branch; an ask runs one time", async () => {
    const { sql, hub, once, runs } = await instance();
    await once();
    expect(runs()).toBe(short(SHA2));

    await asks(sql, "rollback");
    expect(await once()).toMatch(new RegExp(`^${AT}\\. The rollback that ada asked for is done\\.`));
    expect(runs()).toBe(short(SHA1));
    const [job] = await run(readJobs(sql));
    expect(job).toMatchObject({ kind: "rollback", command: "rollback", source: "app, by ada", sha: null, state: { at: "done" } });
    const log = await logOf(sql, job.id);
    expect(log).toContain(`(release ${short(SHA1)}). The database stays as it is.`);
    expect(log).toContain(`Release ${short(SHA1)} runs again, healthy`);
    // The ask is gone, and auto-deploy leaves the rollback: the head was tried.
    expect(await once()).toContain(`The instance has ${short(SHA2)}: nothing to deploy.`);
    expect(runs()).toBe(short(SHA1));

    // A commit that the branch does not have (as GitHub's API says) is refused, though GitHub has a release of it.
    hub.state.releases.set(SHA3, builtBundle(SHA3));
    await asks(sql, `deploy ${SHA3}`);
    const from = hub.state.calls.length;
    expect(await once()).toContain(
      `The deploy that ada asked for failed: Release ${short(SHA3)} is not a commit of main on github.com/example/erga: the instance deploys only a commit of that branch.`
    );
    expect(hub.state.calls.slice(from)).toEqual(["refs", `compare ${short(SHA3)}`]);
    expect(runs()).toBe(short(SHA1));

    // An older commit of the branch, from before the commits that the look saw.
    hub.state.older.push(SHA3);
    await asks(sql, `deploy ${SHA3}`);
    expect(await once()).toContain("The deploy that ada asked for is done.");
    expect(runs()).toBe(short(SHA3));
    expect((await run(readJobs(sql))).map((j) => `${j.kind} ${j.source} ${j.state.at}`)).toEqual([
      "deploy app, by ada done",
      "deploy app, by ada failed",
      "rollback app, by ada done",
      "deploy auto-deploy done",
    ]);
    // An ask that is no ask is not run.
    await run(sql("UPDATE deploy_control SET ask = 'deploy main; rm', ask_by = 'ada', ask_at = 1 WHERE id = 1", []));
    expect(await once()).toContain("The ask on the instance is not one that the deployer reads.");
  }, 30_000);

  test("it deploys to its own instance only, and waits while a job of a machine runs", async () => {
    const other = await instance();
    await run(writeSpec(other.sql, { ...SPEC, target: { ...SPEC.target, worker: "erga" } as Spec["target"] }));
    const refused = "The instance's spec names another instance than the one that this deployer is for.";
    expect(await other.once()).toBe(`${refused} (0 calls)`);
    expect(await run(other.sql("SELECT error FROM deploy_control", []))).toEqual([refused]);
    expect(other.calls()).toEqual([]);
    expect(other.runs()).toBe(short(SHA1));

    const busy = await instance();
    await run(
      busy.sql(
        "INSERT INTO deploy_jobs (kind, command, source, started, alive, state) VALUES ('deploy', 'bun erga deploy', 'terminal', ?, ?, 'running')",
        [busy.state.now, busy.state.now]
      )
    );
    expect(await busy.once()).toContain("A job runs on the instance: the deployer waits.");
    expect(busy.runs()).toBe(short(SHA1));
    expect(busy.calls()).toEqual([]);
  }, 30_000);

  test("a database that gives no answer does not stop it: it looks with the spec that it read before", async () => {
    const { env, once, hub } = await instance({ auto: false });
    expect(await once()).toBe(`${AT}. Auto-deploy is off. (5 calls)`);
    const down = {
      ...env.DB,
      prepare: () => {
        throw new Error("D1 is down");
      },
    } as unknown as D1;
    env.DB = down;
    const from = hub.state.calls.length;
    expect(await once()).toBe(`${AT}. Auto-deploy is off. (1 calls)`);
    expect(hub.state.calls.slice(from)).toEqual(["refs"]);
  }, 30_000);

  test("a run that stopped after the upload: the next run puts the version before back, and ends the job", async () => {
    const { mock, sql, io, env, state, once, runs, stored } = await instance();
    mock.state.unhealthy = [short(SHA2)];
    // Cloudflare ends the run while it waits between two health checks: nothing after that runs.
    const log = console.log;
    console.log = () => {};
    void deployer({ ...io, sleep: () => new Promise<void>(() => {}) }).scheduled(null, env);
    for (let i = 0; i < 500 && state.asked.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    console.log = log;
    expect(runs()).toBe(short(SHA2));
    expect(stored().job).toMatchObject({ sha: SHA2, before: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect((await run(readJobs(sql)))[0].state).toEqual({ at: "running" });
    // While its lock holds, a run does nothing. After it: the release is not healthy, so the instance goes back.
    expect(await once()).toBe("Another run of the deployer holds its lock: this one does nothing.");
    state.now += LOCK_MS;
    expect(await once()).toContain("Its deploy failed: the deployer waits for a new commit, or for an admin's ask.");
    expect(runs()).toBe(short(SHA1));
    const [job, ...more] = await run(readJobs(sql));
    expect(more).toEqual([]);
    expect(job.state).toMatchObject({
      at: "failed",
      why: expect.stringMatching(
        /^The deployer's run stopped before the job's end\. The release is not healthy \(documents: a document didn't open\)\. It is rolled back to [0-9a-f-]{36}, which ran before\.$/
      ),
    });
    expect(stored().job).toBeUndefined();
  }, 30_000);

  test("the lock: a second run does nothing while the first one holds it, and takes it when the first one stopped long ago", async () => {
    const { store, state, once } = await instance({ auto: false });
    const stub = store.get(store.idFromName("state"));
    const take = async (now: number) =>
      (await stub.fetch("https://state/", { method: "POST", body: JSON.stringify({ take: now }) })).json();
    expect(await take(state.now)).toMatchObject({ lock: state.now });
    expect(await once()).toBe("Another run of the deployer holds its lock: this one does nothing.");
    state.now += LOCK_MS;
    expect(await once()).toContain("Auto-deploy is off.");
  }, 30_000);
});

describe("the deployer's spec", () => {
  const ENV = { ACCOUNT: FLEET_ACCOUNT, WORKER: "erga-next" };
  test("it takes what spec.ts takes for its instance, and refuses a name that could leave an address", () => {
    expect(specOf(SPEC, ENV)).toEqual({ repo: SPEC.repo, branch: SPEC.branch, settings: SPEC.settings, target: SPEC.target as never });
    const bad: [string, unknown][] = [
      ["a repository with a path", { ...SPEC, repo: "github.com/example/erga/../x" }],
      ["a branch with ..", { ...SPEC, branch: "a..b" }],
      ["a branch that starts with -", { ...SPEC, branch: "-x" }],
      [
        "a host with a slash",
        { ...SPEC, target: { ...SPEC.target, app: { kind: "domain", zoneName: "example.com", hostname: "a.example.com/x" } } },
      ],
      ["a setting of the deploy's own", { ...SPEC, settings: { ERGA_VERSION: "x" } }],
      ["a database with a slash", { ...SPEC, target: { ...SPEC.target, database: "a/b" } }],
    ];
    for (const [what, value] of bad) {
      expect(() => specOf(value, ENV), what).toThrow("The spec on the instance is not one that this deployer reads.");
      expect(Result.isFailure(Effect.runSync(Effect.result(decodeSpec(value)))), what).toBe(true);
    }
    expect(() => specOf({ ...SPEC, target: { ...SPEC.target, account: "0".repeat(32) } }, ENV)).toThrow("names another instance");
    expect(() => specOf(null, ENV)).toThrow("names another instance");
  });
});

describe("the deployer's size", () => {
  test("one small module with no Effect and no Node; its source and its calls have a budget", async () => {
    const code = await deployerModule();
    expect(code).not.toMatch(/from\s*"node:|require\(/);
    expect(code).not.toContain("effect");
    expect(code).toContain("scheduled");
    expect(code).toContain("DeployerState");
    // The budget: a module that a person can read in one sitting. (With Effect in it, the module had 600,000 characters.)
    expect(code.length).toBeLessThan(30_000);
    const source = readFileSync(join(ROOT, "deploy/deployer/worker.ts"), "utf8").split("\n");
    expect(source.length).toBeLessThan(800);
    // Cloudflare's free plan stops a run at 50 calls.
    expect(CALLS).toBeLessThan(50);
  });
});

describe("a migration's statements", () => {
  test("a ; ends a statement, but not in a text, a quoted name, a comment or a trigger's body", () => {
    expect(
      statementsOf(`-- A comment; with a semicolon.
CREATE TABLE a (
  x TEXT DEFAULT 'one; two', -- the default; of x
  "y;z" TEXT DEFAULT 'it''s; here'
);
/* a block; comment */
INSERT INTO a (x) VALUES ('-- no comment');;
CREATE TRIGGER t AFTER INSERT ON a BEGIN
  UPDATE a SET x = 'b; c';
  DELETE FROM a WHERE x = 'd';
END;
SELECT 1`)
    ).toEqual([
      `CREATE TABLE a (\n  x TEXT DEFAULT 'one; two', \n  "y;z" TEXT DEFAULT 'it''s; here'\n)`,
      "INSERT INTO a (x) VALUES ('-- no comment')",
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN\n  UPDATE a SET x = 'b; c';\n  DELETE FROM a WHERE x = 'd';\nEND",
      "SELECT 1",
    ]);
    expect(statementsOf("  \n-- only a comment\n")).toEqual([]);
  });

  test("each migration of this repository, statement by statement, makes the same database as the file does", () => {
    const SCHEMA = "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
    const whole = new Database(":memory:");
    const cut = new Database(":memory:");
    for (const name of files) {
      const file = readFileSync(join(MIGRATIONS, name), "utf8");
      whole.exec(file);
      for (const statement of statementsOf(file)) cut.run(statement);
    }
    expect(files.length).toBeGreaterThan(40);
    expect(cut.query(SCHEMA).all()).toEqual(whole.query(SCHEMA).all());
  });

  test("the deployer applies a migration that the database does not have, through its binding, and records it", async () => {
    const { d1, sql, once } = await instance();
    await d1.batch([
      d1.prepare("DROP TABLE removed_domains"),
      d1.prepare("DELETE FROM d1_migrations WHERE name = '0500_removed_domains.sql'"),
    ]);
    expect(await once()).toContain("Its deploy is done.");
    const [job] = await run(readJobs(sql));
    expect(await logOf(sql, job.id)).toContain(
      "Set up the database's tables: done, applied 0500_removed_domains.sql; restore point: version "
    );
    expect((await d1.prepare("SELECT name FROM sqlite_master WHERE name = 'removed_domains'").all()).results).toHaveLength(1);
    expect((await d1.prepare("SELECT name FROM d1_migrations WHERE name = '0500_removed_domains.sql'").all()).results).toHaveLength(1);
  }, 30_000);
});
