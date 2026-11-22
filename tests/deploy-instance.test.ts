// The instance's own record of its deploys (deploy/deployer/instance.ts), on a real SQLite with the migration's own
// tables: the spec, the lock (one job at a time; a job that stopped frees it after its lease), the job log (written in
// parts, one write at a time), a database from before the tables, and the writer's state machine. The row that the app
// and the deployer in the cloud share (deploy/deployer/control.ts): the app's ask and switch, and the deployer's look.
// And AWS's way to the database (deploy/aws/deploy.ts, awsSql): each value as hex in the statement that the machine runs.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import type { Aws } from "../deploy/aws/cli";
import { awsSql } from "../deploy/aws/deploy";
import { DeployError } from "../deploy/deployer/cloudflare-api";
import { type Ask, type Commit, COMMITS, readControl, startOf, takeAsk, writeLook } from "../deploy/deployer/control";
import {
  CHUNK,
  LEASE_MS,
  NoTable,
  openJob,
  readJobs,
  readLog,
  readSpec,
  type Sql,
  settled,
  startWriter,
  stepWriter,
  type Writer,
  type WriterEvent,
  writeSpec,
} from "../deploy/deployer/instance";
import type { Spec } from "../deploy/deployer/spec";

const MIGRATION = ["0470_deploys.sql", "0480_deploy_control.sql", "0540_deploy_auto_mode.sql"]
  .map((name) => readFileSync(new URL(`../server/migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");
const run = Effect.runPromise;

/** A database, and the statements that it ran. `tables: false`: one from before the migration. */
function database(o: { tables?: boolean } = {}) {
  const db = new Database(":memory:");
  if (o.tables !== false) db.exec(MIGRATION);
  const statements: string[] = [];
  /** The text of each write of a job's log. */
  const written: string[] = [];
  let fail: string | null = null;
  const sql: Sql = (text, params) =>
    Effect.try({
      try: () => {
        statements.push(text);
        if (text.startsWith("UPDATE deploy_jobs")) written.push(String(params[0]));
        if (fail) throw new Error(fail);
        return db
          .query(text)
          .all(...params)
          .map((r) => String(Object.values(r as object)[0]));
      },
      catch: (e) => (/no such table/.test((e as Error).message) ? new NoTable() : new DeployError({ message: (e as Error).message })),
    });
  return { db, sql, statements, written, failWith: (why: string | null) => void (fail = why) };
}

/** A job's whole log, read in parts: the text, and the size of each part. */
async function logOf(sql: Sql, id: number) {
  const decoder = new TextDecoder();
  const sizes: number[] = [];
  let text = "";
  const have = () => sizes.reduce((a, b) => a + b, 0);
  for (let part = await run(readLog(sql, id, 0)); part.length; part = await run(readLog(sql, id, have()))) {
    sizes.push(part.length);
    text += decoder.decode(part, { stream: true });
  }
  return { text, sizes };
}

const spec: Spec = {
  repo: "github.com/example/erga",
  branch: "main",
  target: {
    kind: "cloudflare",
    account: "0123456789abcdef0123456789abcdef",
    worker: "erga",
    database: "erga",
    app: { kind: "domain", zoneName: "example.com", hostname: "example.com" },
    pages: { kind: "zone", zoneName: "example-pages.com" },
  },
  settings: { SERVER_CONFIG: '{"name":"Ada\'s é 😀 $(id) `x` \\"q\\""}' },
  secrets: ["SESSION_SECRET"],
};
const deploy = { kind: "deploy", command: "bun erga deploy example.com", source: "terminal" } as const;

describe("the instance's spec", () => {
  test("none, then written, read back the same, and replaced; a value that is no spec is never written", async () => {
    const { db, sql } = database();
    expect(await run(readSpec(sql))).toBeNull();
    await run(writeSpec(sql, spec));
    expect(await run(readSpec(sql))).toEqual(spec);
    await run(writeSpec(sql, { ...spec, branch: "staging" }));
    expect((await run(readSpec(sql)))?.branch).toBe("staging");
    expect(db.query("SELECT count(*) AS n FROM deploy_spec").get()).toEqual({ n: 1 });
    const bad = await run(Effect.flip(writeSpec(sql, { ...spec, repo: "example.com/team/erga" })));
    expect(bad.message).toContain("This is not a spec: Expected a string matching");
    expect((await run(readSpec(sql)))?.repo).toBe(spec.repo);
  });

  test("a row that is not a spec is an error that says so; a database with no table says NoTable", async () => {
    const { db, sql } = database();
    db.run("INSERT INTO deploy_spec (id, spec, at) VALUES (1, ?, 0)", [JSON.stringify({ ...spec, host: "example.com" })]);
    expect((await run(Effect.flip(readSpec(sql)))).message).toContain("The spec on the instance is not one that this code reads");
    const old = database({ tables: false }).sql;
    expect((await run(Effect.flip(readSpec(old))))._tag).toBe("NoTable");
    expect((await run(Effect.flip(writeSpec(old, spec))))._tag).toBe("NoTable");
  });
});

describe("a job on the instance", () => {
  test("its row is the lock: a second job stops with the first one's name, until the first one ends", async () => {
    const { sql } = database();
    const first = await run(openJob(sql, deploy));
    const refused = await run(Effect.flip(openJob(sql, { kind: "rollback", command: "bun erga rollback example.com", source: "page" })));
    expect(refused.message).toContain("Another job runs on the instance: bun erga deploy example.com (from terminal), since 20");
    expect(refused.message).toContain("frees the instance 30 minutes after its last line");
    expect(await first.end({ at: "failed", why: "the health check fails" })).toBeNull();
    const second = await run(openJob(sql, { kind: "rollback", command: "bun erga rollback example.com", source: "page" }));
    expect(await second.end({ at: "done" })).toBeNull();
    expect((await run(readJobs(sql))).map((j) => [j.id, j.kind, j.source, j.state])).toEqual([
      [2, "rollback", "page", { at: "done" }],
      [1, "deploy", "terminal", { at: "failed", why: "the health check fails" }],
    ]);
  });

  test("two jobs that start together: one statement decides, and one of them gets the lock", async () => {
    const { sql } = database();
    const both = await Promise.all([deploy, deploy].map((start) => run(Effect.result(openJob(sql, start)))));
    expect(both.map((r) => r._tag).sort()).toEqual(["Failure", "Success"]);
  });

  test("a job that stopped with no end holds the lock for its lease, counted from its last write", async () => {
    const { db, sql } = database();
    const stopped = await run(openJob(sql, deploy));
    stopped.line("its last line");
    await Bun.sleep(0);
    db.run("UPDATE deploy_jobs SET alive = alive - ?", [LEASE_MS - 60_000]);
    expect((await run(Effect.flip(openJob(sql, deploy)))).message).toContain("Another job runs");
    db.run("UPDATE deploy_jobs SET alive = alive - ?", [60_001]);
    const next = await run(openJob(sql, deploy));
    expect(next.id()).toBe(2);
    expect((await run(readJobs(sql)))[1].state).toEqual({ at: "running" });
  });

  test("its lines, its commit and its end are in its row; a long log goes in parts, and reads back in parts", async () => {
    const { sql, written } = database();
    const job = await run(openJob(sql, deploy));
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}: é 😀 'quote' "double" $(id) \`x\` ${"x".repeat(50)}`);
    job.commit("a".repeat(40));
    for (const line of lines) job.line(line);
    expect(await job.end({ at: "done" })).toBeNull();
    const text = `${lines.join("\n")}\n`;
    const bytes = Buffer.byteLength(text);
    // One write at a time, each with CHUNK bytes at most and whole characters: the first has the commit alone (it
    // came first), the others what waited.
    expect(written[0]).toBe("");
    expect(written.join("")).toBe(text);
    expect(written.length).toBe(1 + Math.ceil(bytes / CHUNK));
    for (const part of written) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(CHUNK);
    const [row] = await run(readJobs(sql));
    expect(row).toMatchObject({ id: 1, sha: "a".repeat(40), state: { at: "done" }, size: bytes });
    // It reads back in parts of CHUNK bytes: a part can end inside a character, and the parts together are the text.
    const read = await logOf(sql, 1);
    expect(read.text).toBe(text);
    expect(read.sizes).toEqual([...Array(Math.floor(bytes / CHUNK)).fill(CHUNK), bytes % CHUNK]);
    expect(new TextDecoder().decode(await run(readLog(sql, 1, 9)))).toStartWith("\ufffd 😀 'quote'");
  });

  test("a database from before the tables: the job runs with no lock, and its row is made when it ends, after the migrations", async () => {
    const { db, sql } = database({ tables: false });
    const job = await run(openJob(sql, deploy));
    expect(job.id()).toBeNull();
    job.line("Set up the database's tables...");
    job.commit("b".repeat(40));
    const started = Date.now();
    // The deploy's own migrations step brings the tables.
    db.exec(MIGRATION);
    job.line("Deployed.");
    expect(await job.end({ at: "done" })).toBeNull();
    const [row] = await run(readJobs(sql));
    expect(row).toMatchObject({ id: 1, kind: "deploy", command: deploy.command, sha: "b".repeat(40), state: { at: "done" } });
    expect(row.started).toBeLessThanOrEqual(started);
    expect((await logOf(sql, 1)).text).toBe("Set up the database's tables...\nDeployed.\n");
    // A job that fails before its migrations has no table at its end either: it says so, and leaves nothing.
    const old = database({ tables: false });
    const failed = await run(openJob(old.sql, deploy));
    failed.line("Test the commit...");
    expect(await failed.end({ at: "failed", why: "1 test failed" })).toBe("the instance's database has no table for its deploys");
  });

  test("another error than a missing table refuses the job", async () => {
    const { sql, failWith } = database();
    failWith("the token doesn't have that permission");
    expect((await run(Effect.flip(openJob(sql, deploy)))).message).toBe("the token doesn't have that permission");
  });

  test("a write that fails keeps what it carried: the next write has it, and the end says when the row lacks something", async () => {
    const { sql, failWith } = database();
    const job = await run(openJob(sql, deploy));
    failWith("D1 is busy");
    job.line("one");
    await Bun.sleep(0);
    failWith(null);
    job.line("two");
    expect(await job.end({ at: "done" })).toBeNull();
    expect((await logOf(sql, 1)).text).toBe("one\ntwo\n");
    const lost = await run(openJob(sql, deploy));
    lost.line("three");
    await Bun.sleep(0);
    failWith("D1 is gone");
    expect(await lost.end({ at: "failed", why: "it broke" })).toBe("D1 is gone");
    failWith(null);
    expect((await run(readJobs(sql)))[0].state).toEqual({ at: "running" });
  });
});

describe("the writer's state machine", () => {
  const steps = (w: Writer, ...events: WriterEvent[]) =>
    events.reduce((s, e) => stepWriter(s.writer, e), { writer: w, effect: null as unknown });

  test("one write at a time: what comes while it runs waits, and goes together in the next one", () => {
    const first = stepWriter(startWriter(7), { type: "line", line: "a" });
    expect(first.effect).toEqual({ do: "write", id: 7, text: "a\n", sha: null, state: { at: "running" } });
    const waiting = steps(first.writer, { type: "line", line: "b" }, { type: "commit", sha: "c0ffee" }, { type: "line", line: "c" });
    expect(waiting.effect).toBeNull();
    const next = stepWriter(waiting.writer, { type: "written" });
    expect(next.effect).toEqual({ do: "write", id: 7, text: "b\nc\n", sha: "c0ffee", state: { at: "running" } });
    const idle = stepWriter(next.writer, { type: "written" });
    expect([idle.effect, settled(idle.writer)]).toEqual([null, true]);
  });

  test("the end goes with the last of the text, never before it; after the end, the state stays", () => {
    const long = "x".repeat(CHUNK + 10);
    const a = steps(startWriter(1), { type: "line", line: long }, { type: "end", state: { at: "failed", why: "no" } });
    expect(a.effect).toBeNull();
    const b = stepWriter(a.writer, { type: "written" });
    expect(b.effect).toMatchObject({ do: "write", text: `${"x".repeat(10)}\n`, state: { at: "failed", why: "no" } });
    const c = steps(b.writer, { type: "written" }, { type: "end", state: { at: "done" } });
    expect([c.effect, settled(c.writer), c.writer.state]).toEqual([null, true, { at: "failed", why: "no" }]);
  });

  test("a failed write starts no write by itself; the next event sends what it carried, in front", () => {
    const a = steps(startWriter(1), { type: "line", line: "a" }, { type: "line", line: "b" }, { type: "failed", why: "busy" });
    expect([a.effect, a.writer.failed, settled(a.writer)]).toEqual([null, "busy", false]);
    expect(stepWriter(a.writer, { type: "end", state: { at: "done" } }).effect).toEqual({
      do: "write",
      id: 1,
      text: "a\nb\n",
      sha: null,
      state: { at: "done" },
    });
  });

  test("with no row yet, nothing is written while the job runs; its end takes the row, and then fills it", () => {
    const a = steps(startWriter(null), { type: "line", line: "a" }, { type: "commit", sha: "c0ffee" });
    expect(a.effect).toBeNull();
    const b = stepWriter(a.writer, { type: "end", state: { at: "done" } });
    expect(b.effect).toEqual({ do: "take" });
    expect(stepWriter(b.writer, { type: "written", id: 3 }).effect).toEqual({
      do: "write",
      id: 3,
      text: "a\n",
      sha: "c0ffee",
      state: { at: "done" },
    });
  });

  test("a log has a most: one line says where it is cut, and no line comes after it", () => {
    let w = startWriter(1);
    const line = "y".repeat(999);
    for (let i = 0; i < 500; i++) w = stepWriter(stepWriter(w, { type: "line", line }).writer, { type: "written" }).writer;
    expect(w.size).toBe(400_000);
    const more = stepWriter(w, { type: "line", line });
    expect(more.effect).toBeNull();
    const cut = stepWriter(startWriter(1), { type: "line", line: "z".repeat(400_001) });
    expect(cut.effect).toMatchObject({ text: "(The log is cut here: the rest is only where the command ran.)\n" });
  });
});

describe("the row that the app and the deployer share", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const commit = (n: number, release: Commit["release"] = "released"): Commit => ({
    sha: `${String(n).padStart(2, "0")}${SHA.slice(2)}`,
    title: `Commit ${n}: é 😀 <b> 'q' $(id)`,
    at: 1_700_000_000_000 + n,
    release,
  });
  /** The app's side, as the migration says it: the switch, and an ask that takes the place of one that waits. */
  const appAuto = (db: Database, on: boolean) =>
    db.run("INSERT INTO deploy_control (id, auto) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET auto = excluded.auto", [on ? 1 : 0]);
  const appAsk = (db: Database, ask: string, by: string | null, at: number | null) =>
    db.run(
      "INSERT INTO deploy_control (id, ask, ask_by, ask_at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET ask = excluded.ask, ask_by = excluded.ask_by, ask_at = excluded.ask_at",
      [ask, by, at]
    );

  test("no row: null. A look makes the row, with its time; the next look takes its place. Neither touches the switch or the ask", async () => {
    const { db, sql } = database();
    expect(await run(readControl(sql))).toBeNull();
    const before = Date.now();
    await run(writeLook(sql, { head: commit(1).sha, error: null, commits: [commit(1), commit(0, "none")] }));
    expect(await run(readControl(sql))).toMatchObject({
      auto: false,
      ask: null,
      head: commit(1).sha,
      commits: [commit(1), commit(0, "none")],
    });
    // The look's time is in the row, and its reader gives it: the ops page of a machine reads who deploys the instance.
    expect((await run(readControl(sql)))?.looked).toBeGreaterThanOrEqual(before);
    const row = db.query("SELECT looked, error FROM deploy_control").get() as { looked: number; error: string | null };
    expect(row.looked).toBeGreaterThanOrEqual(before);
    expect(row.error).toBeNull();
    appAuto(db, true);
    appAsk(db, "rollback", "ada", 5);
    // A look that failed says why, with the head and the commits that the deployer still has.
    await run(writeLook(sql, { head: commit(1).sha, error: "GitHub answered 503.", commits: [commit(1)] }));
    expect(await run(readControl(sql))).toMatchObject({
      auto: true,
      ask: { kind: "rollback", by: "ada", at: 5 },
      head: commit(1).sha,
      commits: [commit(1)],
    });
    expect(db.query("SELECT error, count(*) AS n FROM deploy_control").get()).toEqual({ error: "GitHub answered 503.", n: 1 });
  });

  test("a look that the reader could not read is refused, and the row stays", async () => {
    const { sql } = database();
    const good = { head: commit(1).sha, error: null, commits: [commit(1)] };
    await run(writeLook(sql, good));
    const many = Array.from({ length: COMMITS + 1 }, (_, n) => commit(n));
    for (const bad of [
      { ...good, commits: many },
      { ...good, head: "main" },
      { ...good, commits: [{ ...commit(2), sha: SHA.slice(0, 12) }] },
      { ...good, commits: [{ ...commit(2), release: "ready" as "released" }] },
      { ...good, commits: [{ ...commit(2), title: "x".repeat(201) }] },
      { ...good, commits: [{ ...commit(2), author: "ada" }] },
    ])
      expect((await run(Effect.flip(writeLook(sql, bad)))).message).toStartWith("This is not a look: ");
    expect((await run(readControl(sql)))?.commits).toEqual([commit(1)]);
    await run(writeLook(sql, { ...good, commits: many.slice(0, COMMITS) }));
    expect((await run(readControl(sql)))?.commits.length).toBe(COMMITS);
  });

  test("an ask: read, taken one time, after the job has the lock; one that another ask replaced is not taken", async () => {
    const { db, sql } = database();
    appAsk(db, `deploy ${SHA}`, "ada, via her agent", 1000);
    const ask = (await run(readControl(sql)))!.ask!;
    expect(ask).toEqual({ kind: "deploy", sha: SHA, by: "ada, via her agent", at: 1000 });
    expect(startOf(ask)).toEqual({ kind: "deploy", command: `deploy ${SHA.slice(0, 12)}`, source: "app, by ada, via her agent" });
    // Another job runs: the deployer does not get the lock, so it does not take the ask, which waits.
    const other = await run(openJob(sql, deploy));
    expect((await run(Effect.flip(openJob(sql, startOf(ask))))).message).toContain("Another job runs on the instance");
    expect((await run(readControl(sql)))?.ask).toEqual(ask);
    await other.end({ at: "done" });
    const job = await run(openJob(sql, startOf(ask)));
    expect(await run(takeAsk(sql, ask))).toBe(true);
    expect((await run(readControl(sql)))?.ask).toBeNull();
    expect(await run(takeAsk(sql, ask))).toBe(false);
    await job.end({ at: "done" });
    expect((await run(readJobs(sql)))[0]).toMatchObject({ kind: "deploy", source: "app, by ada, via her agent", state: { at: "done" } });
    // The app asks again while the deployer holds the first ask: the first is gone, and the second stays.
    appAsk(db, "rollback", "ada", 2000);
    const first: Ask = { kind: "rollback", by: "ada", at: 2000 };
    appAsk(db, `deploy ${SHA}`, "bo", 3000);
    expect(await run(takeAsk(sql, first))).toBe(false);
    expect((await run(readControl(sql)))?.ask).toEqual({ kind: "deploy", sha: SHA, by: "bo", at: 3000 });
    expect(startOf(first)).toEqual({ kind: "rollback", command: "rollback", source: "app, by ada" });
  });

  test("a row that this code can't read is an error, never a guess; a database with no table says NoTable", async () => {
    for (const [ask, by, at] of [
      [`deploy ${SHA.slice(0, 12)}`, "ada", 1],
      [`deploy ${SHA}; rm -rf /`, "ada", 1],
      ["restart", "ada", 1],
      ["rollback", "ada\nfailed: no", 1],
      ["rollback", "a".repeat(101), 1],
    ] as const) {
      const { db, sql } = database();
      appAsk(db, ask, by, at);
      expect((await run(Effect.flip(readControl(sql)))).message).toContain("a row of its deploys that this code can't read");
    }
    const { db, sql } = database();
    appAsk(db, "rollback", null, null);
    expect((await run(Effect.flip(readControl(sql)))).message).toBe("The ask on the instance does not say who asked, and when.");
    db.run('UPDATE deploy_control SET ask = NULL, commits = \'[{"sha": "main"}]\'');
    expect((await run(Effect.flip(readControl(sql)))).message).toContain("a row of its deploys that this code can't read");
    const old = database({ tables: false }).sql;
    expect((await run(Effect.flip(readControl(old))))._tag).toBe("NoTable");
    expect((await run(Effect.flip(writeLook(old, { head: null, error: null, commits: [] }))))._tag).toBe("NoTable");
    expect((await run(Effect.flip(takeAsk(old, { kind: "rollback", by: "ada", at: 1 }))))._tag).toBe("NoTable");
  });
});

describe("AWS's way to the instance's database", () => {
  /** A fake AWS CLI: Systems Manager runs the script's one statement on a SQLite, and prints the rows as celld would. */
  function machine(o: { tables?: boolean; deployed?: boolean } = {}) {
    const { db } = database(o);
    const scripts: string[] = [];
    let out = { Status: "Success", StandardOutputContent: "", StandardErrorContent: "" };
    const aws = (async (...args: string[]) => {
      if (args[1] == "get-command-invocation") return out;
      const script = (JSON.parse(args[args.indexOf("--parameters") + 1]) as { commands: string[] }).commands[0];
      scripts.push(script);
      const statement = /--command "([^"]*)"/.exec(script)![1];
      try {
        if (o.deployed === false) throw new Error("no such table: the machine runs no release yet");
        // celld d1 execute --json: one JSON object for each row, and nothing else on its output.
        if (!script.includes(" --json ")) throw new Error("the rows come as a table");
        const rows = db.query(statement).all();
        out = { Status: "Success", StandardOutputContent: rows.map((r) => `${JSON.stringify(r)}\n`).join(""), StandardErrorContent: "" };
      } catch (e) {
        out = { Status: "Failed", StandardOutputContent: "", StandardErrorContent: `error: ${(e as Error).message}: SQLITE_ERROR\n` };
      }
      return { Command: { CommandId: "c1" } };
    }) as Aws;
    return { sql: awsSql(aws, { bucket: "erga-example-bucket", region: "us-west-2", machine: "i-0123456789abcdef0" }), scripts, db };
  }

  test("a job and the spec through the machine: each value is hex in the statement, and the rows come back out of celld's words", async () => {
    const { sql, scripts } = machine();
    await run(writeSpec(sql, spec));
    expect(await run(readSpec(sql))).toEqual(spec);
    const job = await run(openJob(sql, { ...deploy, command: `bun erga deploy "$(id)" 'x'; rm -rf / \`id\`` }));
    job.line("é 😀 'quote' \"double\" $(id) `x` \\ ; --");
    expect(await job.end({ at: "done" })).toBeNull();
    expect((await logOf(sql, 1)).text).toBe("é 😀 'quote' \"double\" $(id) `x` \\ ; --\n");
    // The look and an ask go the same way (control.ts).
    const seen: Commit = {
      sha: "0123456789abcdef0123456789abcdef01234567",
      title: "é 😀 'q' \"d\" $(id) `x`; rm -rf /",
      at: 5,
      release: "released",
    };
    await run(writeLook(sql, { head: seen.sha, error: null, commits: [seen] }));
    expect(await run(readControl(sql))).toMatchObject({ auto: false, ask: null, head: seen.sha, commits: [seen] });
    expect(await run(takeAsk(sql, { kind: "rollback", by: "$(id)", at: 1 }))).toBe(false);
    // What the machine ran: plain characters only. No value's text is in a script.
    for (const script of scripts) {
      const statement = /--command "([^"]*)"/.exec(script)![1];
      expect(statement).toMatch(/^[A-Za-z0-9_ ,()=<>|'*.:]*$/);
      expect(script).not.toContain("rm -rf /");
      expect(script).not.toContain("$(id)");
    }
    expect(scripts[0]).toContain("s3://erga-example-bucket/releases/$version.tgz");
  });

  test("no release on the machine yet, or a database from before the tables: NoTable; another failure is an error in the machine's words", async () => {
    expect((await run(Effect.flip(readSpec(machine({ deployed: false }).sql))))._tag).toBe("NoTable");
    expect((await run(Effect.flip(readSpec(machine({ tables: false }).sql))))._tag).toBe("NoTable");
    const { sql, db } = machine();
    db.exec("DROP TABLE deploy_spec; CREATE TABLE deploy_spec (id INTEGER)");
    expect((await run(Effect.flip(readSpec(sql)))).message).toContain("on the machine (Failed)");
  });
});
