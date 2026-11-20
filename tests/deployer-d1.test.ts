// The deployer on Cloudflare reaches the instance's database through its Worker's D1 binding
// (deploy/deployer/d1-binding.ts): its token holds no permission for D1. Against a real D1 binding, in the Workers
// runtime on this machine (Miniflare), and the mock Cloudflare for the rest of the API. Nothing real is touched.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { DeployError } from "../deploy/deployer/cloudflare-api";
import { readControl } from "../deploy/deployer/control";
import { bindingDatabase, bindingSql, type D1, statementsOf } from "../deploy/deployer/d1-binding";
import { NoTable, openJob, readJobs, readLog, readSpec, writeSpec } from "../deploy/deployer/instance";
import type { Spec } from "../deploy/deployer/spec";
import { deployer } from "../deploy/deployer/worker";
import { FLEET_ACCOUNT } from "../dev/mock-cloudflare";
import { bindingsOf, prepareRelease, ROOT, SHA1, SHA2 } from "./helpers/deploys.ts";
import { instanceOn, record, SPEC } from "./helpers/binding.ts";

const run = Effect.runPromise;
const short = (sha: string) => sha.slice(0, 12);
const MIGRATIONS = join(ROOT, "server/migrations");
const files = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith(".sql"))
  .sort();
/** A database's tables and indexes, as SQLite keeps them. */
const SCHEMA =
  "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name";

/** The Workers runtime, with databases that the tests take one by one. */
const NAMES = ["DB1", "DB2", "DB3", "DB4"];
let runtime: Miniflare;
let next = 0;
const fresh = async () => (await runtime.getD1Database(NAMES[next++])) as unknown as D1;

beforeAll(async () => {
  await prepareRelease();
  runtime = new Miniflare(
    convertV4MiniflareOptions({ modules: true, script: "export default {}", compatibilityDate: "2026-09-01", d1Databases: NAMES })
  );
  await runtime.ready;
}, 120_000);
afterAll(() => runtime?.dispose());

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
});

describe("the binding", () => {
  test("applies each migration as one transaction, and makes the database that SQLite makes of the files", async () => {
    const db = bindingDatabase(await fresh());
    await db.query("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)", [], "set up the database");
    for (const name of files) await db.apply(readFileSync(join(MIGRATIONS, name), "utf8"), record(name), `apply ${name}`);
    const whole = new Database(":memory:");
    for (const name of files) whole.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    const names = (rows: unknown[]) => rows.map((r) => (r as { name: string }).name);
    expect(names(await db.query(SCHEMA, [], "read the schema"))).toEqual(names(whole.query(SCHEMA).all()));
    expect((await db.query("SELECT name FROM d1_migrations ORDER BY id", [], "read")).map((r) => r.name)).toEqual(files);

    // A migration whose second statement fails leaves nothing: not its first table, and not its record.
    const bad = "CREATE TABLE half (x TEXT);\nINSERT INTO no_such_table VALUES (1);";
    const failed = await db.apply(bad, record("9999_bad.sql"), "apply 9999_bad.sql").catch((e: Error) => e);
    expect(failed).toBeInstanceOf(DeployError);
    expect(failed?.message).toContain("The instance's database refused to apply 9999_bad.sql:");
    expect(failed?.message).toContain("no such table: no_such_table");
    expect(await db.query("SELECT name FROM sqlite_master WHERE name = 'half'", [], "read")).toEqual([]);
    expect(await db.query("SELECT name FROM d1_migrations WHERE name = ?", ["9999_bad.sql"], "read")).toEqual([]);
    // It gives no Time Travel bookmark.
    expect(await db.bookmark()).toBeNull();
  }, 30_000);

  test("holds the instance's spec, lock and job log, as D1's API does; a database with no tables says so", async () => {
    const d1 = await fresh();
    const sql = bindingSql(d1);
    expect(await run(Effect.flip(readSpec(sql)))).toBeInstanceOf(NoTable);
    const db = bindingDatabase(d1);
    for (const name of ["0470_deploys.sql", "0480_deploy_control.sql"])
      await db.apply(readFileSync(join(MIGRATIONS, name), "utf8"), "SELECT 1", `apply ${name}`);
    expect(await run(readSpec(sql))).toBeNull();
    await run(writeSpec(sql, SPEC));
    expect(await run(readSpec(sql))).toEqual(SPEC);
    const job = await run(openJob(sql, { kind: "deploy", command: "deploy", source: "auto-deploy" }));
    // The lock: a second job is refused while the first one runs.
    expect((await run(Effect.flip(openJob(sql, { kind: "rollback", command: "rollback", source: "app, by ada" })))).message).toContain(
      "Another job runs on the instance: deploy (from auto-deploy)"
    );
    job.commit(SHA2);
    job.line("one line, with ü and 'quotes'");
    expect(await job.end({ at: "done" })).toBeNull();
    const [row] = await run(readJobs(sql));
    expect(row).toMatchObject({ kind: "deploy", source: "auto-deploy", sha: SHA2, state: { at: "done" } });
    expect(new TextDecoder().decode(await run(readLog(sql, row.id, 0)))).toBe("one line, with ü and 'quotes'\n");
    expect(await run(readControl(sql))).toBeNull();
  });
});

describe("the deployer's Worker", () => {
  /** The instance, with a new database of the runtime as the deployer's binding. */
  async function instance() {
    const d1 = await fresh();
    const made = await instanceOn(d1);
    return { ...made, env: { CLOUDFLARE_API_TOKEN: "mock-only-erga-next", ACCOUNT: FLEET_ACCOUNT, WORKER: "erga-next", DB: d1 } };
  }

  test("its schedule deploys the head's release with no call of D1's API: the database is its binding", async () => {
    const { mock, sql, fetch, env, calls } = await instance();
    await run(sql("INSERT INTO deploy_control (id, auto) VALUES (1, 1)", []));
    const worker = deployer(fetch);
    expect(Object.keys(worker)).toEqual(["scheduled"]);
    await worker.scheduled(null, env);
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(short(SHA2));
    const [job] = await run(readJobs(sql));
    expect(job).toMatchObject({ kind: "deploy", source: "auto-deploy", sha: SHA2, state: { at: "done" } });
    const log = new TextDecoder().decode(await run(readLog(sql, job.id, 0)));
    expect(log).toContain("Set up the database's tables: done, already up to date; restore point: version ");
    expect(log).toContain(`(release ${short(SHA1)}), no database bookmark`);
    expect(log).toContain(`Wait for its health: done, release ${short(SHA2)}, healthy`);
    expect(await run(readControl(sql))).toMatchObject({ auto: true, head: SHA2 });
    // What its token did at Cloudflare: the instance's Worker only. No database, no other Worker, no account.
    const kinds = [
      ...new Set(
        calls().map((c) =>
          c
            .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "*")
            .replace(/upload\/[0-9a-f]{32}/, "upload/*")
            .replace(/\?.*$/, "")
        )
      ),
    ];
    const acc = `/accounts/${FLEET_ACCOUNT}`;
    expect(kinds.sort()).toEqual(
      [
        `GET ${acc}/workers/scripts/erga-next/deployments`,
        `GET ${acc}/workers/scripts/erga-next/settings`,
        `GET ${acc}/workers/scripts/erga-next/versions/*`,
        `POST ${acc}/workers/scripts/erga-next/assets-upload-session`,
        `PUT ${acc}/workers/scripts/erga-next`,
        `PUT ${acc}/workers/scripts/erga-next/schedules`,
      ].sort()
    );
  }, 30_000);

  test("it deploys to its own instance only: a spec for another Worker is an error on the instance", async () => {
    const { mock, sql, fetch, env, calls } = await instance();
    await run(sql("INSERT INTO deploy_control (id, auto) VALUES (1, 1)", []));
    await run(writeSpec(sql, { ...SPEC, target: { ...SPEC.target, worker: "erga" } as Spec["target"] }));
    await deployer(fetch).scheduled(null, env);
    expect(await run(sql("SELECT error FROM deploy_control", []))).toEqual([
      "The instance's spec names another instance than the one that this deployer is for.",
    ]);
    expect(await run(readJobs(sql))).toEqual([]);
    expect(calls()).toEqual([]);
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(short(SHA1));
  }, 30_000);
});
