// The production gate (deploy/gate.ts, factory/vm/gate.ts, worker/gate.ts):
// the shard split, a run's life (green, red, running, flaky, rerun, a newer
// commit), the verdict, every path that moves main (a merge, an override, a
// push), the VM's own job against a real git repository, and the VM runner.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeRunner, RERUN_MAX, SILENT_MS, TestGate, verdictOf, vmName, type GateRunner, type ShardReport } from "../deploy/gate.ts";
import { namesByFile, planShards, reportLines, testItems, TYPECHECK_SECS } from "../factory/vm/gate.ts";
import { parseStatus, vmRunner } from "../worker/gate.ts";
import { git, must, startFixture, type Fixture } from "./source-fixture.ts";

setDefaultTimeout(60_000);
const ROOT = new URL("../", import.meta.url).pathname;
const TEST_SH = readFileSync(join(ROOT, "test.sh"), "utf8");
const UNITS = ["tests/a.test.ts", "tests/b.test.ts"];

describe("the shard split", () => {
  test("every test file of test.sh runs in exactly one shard, the typecheck in one, the unit tests as one item", () => {
    const items = testItems(TEST_SH, UNITS);
    const plan = planShards(TEST_SH, UNITS, 6);
    expect(plan.length).toBe(6);
    const names = plan.flatMap((s) => s.items.map((i) => i.name));
    expect(names.sort()).toEqual(items.map((i) => i.name).sort());
    expect(new Set(names).size).toBe(names.length);
    expect(plan.filter((s) => s.typecheck).length).toBe(1);
    expect(plan.flatMap((s) => s.items).find((i) => i.name == "unit")?.files).toEqual(UNITS);
    // The multiplayer suite runs twice in test.sh (and its latency part): one item, its seconds added.
    const suite = items.find((i) => i.name == "tests/suite/run.ts")!;
    expect(suite.secs).toBe(28);
    expect(items.find((i) => i.name == "tests/worker.ts")).toBeTruthy();
  });

  test("balanced: no shard is far over its share, and the same input gives the same split", () => {
    const plan = planShards(TEST_SH, UNITS, 6);
    const items = testItems(TEST_SH, UNITS);
    const longest = Math.max(...items.map((i) => i.secs));
    const total = items.reduce((s, i) => s + (i.secs * Math.min(i.weight, 2)) / 2, 0) + TYPECHECK_SECS / 2;
    const ests = plan.map((s) => s.est);
    // Each shard ends by its fair share plus one item, or by the longest file alone.
    expect(Math.max(...ests)).toBeLessThanOrEqual(Math.max(longest, total / 6 + 40));
    expect(JSON.stringify(planShards(TEST_SH, UNITS, 6))).toBe(JSON.stringify(plan));
    // One shard is the whole run.
    expect(planShards(TEST_SH, UNITS, 1)[0].items.length).toBe(items.length);
  });

  test("test.sh's report is read by name, and names map back to files", () => {
    const said = reportLines("=== tree ok (36s)\nnoise\n=== front FAILED (19s)\n");
    expect(said.get("tree")).toEqual({ ok: true, secs: 36 });
    expect(said.get("front")).toEqual({ ok: false, secs: 19 });
    const names = namesByFile(TEST_SH);
    expect(names.get("tests/worker.ts")).toEqual(["front"]);
    expect(names.get("tests/suite/run.ts")).toEqual(["suite", "latency"]);
    expect(names.get("unit")).toEqual(["unit"]);
  });
});

/** A gate on a pretend clock, its storage in memory, with the fake runner (or another). */
function makeGate(o: { runner?: GateRunner | string; subjects?: Record<string, string>; shards?: number } = {}) {
  let t = 1_000_000;
  const store = new Map<string, unknown>();
  const events: string[] = [];
  const gate = new TestGate({
    storage: { get: async <T>(k: string) => store.get(k) as T | undefined, put: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async (k) => store.delete(k) },
    runner: o.runner ?? fakeRunner({ delayMs: 1000, now: () => t, subject: async (c) => o.subjects?.[c] ?? "a change" }),
    schedule: () => {},
    changed: (c) => events.push(c),
    now: () => t,
    shards: o.shards ?? 3,
    timer: () => {},
  });
  /** Moves the clock on and polls until nothing changes (each launch settles first). */
  const step = async (ms: number) => { t += ms; await new Promise((r) => setTimeout(r, 5)); await gate.alarm(); await new Promise((r) => setTimeout(r, 5)); await gate.alarm(); };
  return { gate, store, events, step, at: () => t };
}
const sha = (c: string) => c.repeat(40).slice(0, 40);

describe("a run", () => {
  test("green: every shard passes, and main may move to it", async () => {
    const { gate, step } = makeGate();
    const run = await gate.start(sha("a"), "staging moved (push by ada)");
    expect(run.shards.length).toBe(3);
    expect((await gate.verdict(sha("a"))).ok).toBe(false);
    await step(10);
    const v = await gate.verdict(sha("a"));
    expect(v.state).toBe("running");
    expect(v.reason).toContain("still running");
    await step(1500);
    const done = await gate.get(sha("a"));
    expect(done?.state).toBe("passed");
    expect(done?.shards.every((s) => s.state == "passed")).toBe(true);
    expect(done?.shards.flatMap((s) => s.results.map((r) => r.name))).toContain("typecheck");
    expect((await gate.verdict(sha("a"))).ok).toBe(true);
    expect(await gate.log(sha("a"), 1)).toContain("=== ");
  });

  test("red: a file fails twice, the run fails, and the verdict names it", async () => {
    const { gate, step } = makeGate({ subjects: { [sha("b")]: "Break it [gate-fail]" } });
    await gate.start(sha("b"), "push");
    await step(10); await step(1500);
    // One rerun VM for the failed file, then the end.
    let run = await gate.get(sha("b"));
    expect(run?.shards.filter((s) => s.rerun).length).toBe(1);
    expect(run?.shards.find((s) => s.rerun)?.files).toEqual(["tests/fake-fail.ts"]);
    await step(10); await step(1500);
    run = await gate.get(sha("b"));
    expect(run?.state).toBe("failed");
    expect(run?.failed).toEqual(["tests/fake-fail.ts"]);
    expect(run?.flaky).toEqual([]);
    const v = await gate.verdict(sha("b"));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("tests/fake-fail.ts failed");
  });

  test("flaky: it fails once and passes when run again; the run passes and says which were flaky", async () => {
    const { gate, step } = makeGate({ subjects: { [sha("c")]: "Wobble [gate-flaky]" } });
    await gate.start(sha("c"), "push");
    await step(10); await step(1500); await step(10); await step(1500);
    const run = await gate.get(sha("c"));
    expect(run?.state).toBe("passed");
    expect(run?.flaky).toEqual(["tests/fake-fail.ts"]);
    expect(run?.shards.filter((s) => s.rerun).length).toBe(1);
    expect((await gate.verdict(sha("c"))).ok).toBe(true);
  });

  test("rerun: a failed run runs again (a new attempt), and a passed one only when asked", async () => {
    const subjects: Record<string, string> = { [sha("d")]: "[gate-fail]" };
    const { gate, step } = makeGate({ subjects });
    await gate.start(sha("d"), "push");
    for (let i = 0; i < 2; i++) { await step(10); await step(1500); }
    expect((await gate.get(sha("d")))?.state).toBe("failed");
    subjects[sha("d")] = "fixed now";
    const again = await gate.start(sha("d"), "run by ada", { again: true });
    expect(again.attempt).toBe(2);
    expect(again.state).toBe("running");
    expect(again.shards[0].vm).toBe(vmName(sha("d"), 2, 1));
    // While it runs, starting it again is the same run.
    expect((await gate.start(sha("d"), "run by bo", { again: true })).attempt).toBe(2);
    await step(10); await step(1500);
    expect((await gate.get(sha("d")))?.state).toBe("passed");
    // A passed run stays unless asked again.
    expect((await gate.start(sha("d"), "staging moved", {})).attempt).toBe(2);
  });

  test("a newer staging commit cancels the run still going, and says by which", async () => {
    const { gate, step } = makeGate({ subjects: { [sha("e")]: "slow [gate-hang]" } });
    await gate.start(sha("e"), "push", { supersede: true });
    await step(10);
    await gate.start(sha("f"), "push", { supersede: true });
    const old = await gate.get(sha("e"));
    expect(old?.state).toBe("cancelled");
    expect(old?.supersededBy).toBe(sha("f"));
    expect((await gate.verdict(sha("e"))).reason).toContain("cancelled");
    expect((await gate.list()).map((r) => r.commit)).toEqual([sha("f"), sha("e")]);
  });

  test("no runner (a server without VMs): the run fails at once, and says why", async () => {
    const { gate } = makeGate({ runner: "it has no VMs" });
    const run = await gate.start(sha("1"), "push");
    expect(run.state).toBe("failed");
    expect(run.error).toContain("it has no VMs");
    expect((await gate.verdict(sha("1"))).ok).toBe(false);
  });

  test("a VM that goes away fails its shard; so many failures are no flake: no rerun", async () => {
    const gone: GateRunner = { kind: "test", start: async () => {}, poll: async () => "gone", stop: async () => {} };
    const { gate, step } = makeGate({ runner: gone, shards: RERUN_MAX + 1 });
    await gate.start(sha("2"), "push");
    await step(10);
    expect((await gate.get(sha("2")))?.state).toBe("running");
    await step(SILENT_MS + 1000);
    const run = await gate.get(sha("2"));
    expect(run?.state).toBe("failed");
    expect(run?.shards.some((s) => s.rerun)).toBe(false);
    expect(run?.error).toContain("The VM stopped");
  });

  test("the verdict for a commit with no run tells what to do", () => {
    const v = verdictOf(sha("9"), null);
    expect(v).toMatchObject({ ok: false, state: "none" });
    expect(v.reason).toContain("Run tests");
  });
});

describe("every path that moves main asks the gate", () => {
  let f: Fixture, src: string;
  const green = new Set<string>();
  const asked: string[] = [];
  const gate = async (commit: string) => { asked.push(commit); return green.has(commit) ? null : `The tests of ${commit.slice(0, 7)} are still running.`; };
  const ada = { login: "ada", name: "Ada" };
  beforeAll(async () => {
    f = startFixture({ gate, mirror: false });
    src = mkdtempSync(join(tmpdir(), "erga-gate-"));
    await must(src, "init", "-q", "-b", "main");
    writeFileSync(join(src, "a.txt"), "a\n");
    await must(src, "add", "."); await must(src, "commit", "-qm", "First");
    green.add(await must(src, "rev-parse", "HEAD"));
    await must(src, "remote", "add", "erga", f.erga);
    expect((await git(src, "push", "erga", "main:main", "main:staging")).ok).toBe(true);
  });
  afterAll(() => { f.stop(); rmSync(src, { recursive: true, force: true }); });

  const commit = async (name: string) => {
    writeFileSync(join(src, name), name);
    await must(src, "add", "."); await must(src, "commit", "-qm", name);
    return must(src, "rev-parse", "HEAD");
  };

  test("a merge to a commit that isn't green is refused with the reason; a green one moves main", async () => {
    const second = await commit("Second");
    expect((await git(src, "push", "erga", "HEAD:staging")).ok).toBe(true);
    await expect(f.repo.merge(ada)).rejects.toThrow("still running");
    expect(asked.at(-1)).toBe(second);
    green.add(second);
    const r = await f.repo.merge(ada);
    expect(r).toMatchObject({ commit: second, fastForward: true });
    expect(f.moves.at(-1)).toMatchObject({ branch: "main", new: second, how: "merge" });
    expect(f.moves.at(-1)?.override).toBeUndefined();
  });

  test("main may move to an earlier green commit when staging's head isn't green", async () => {
    const third = await commit("Third");
    const fourth = await commit("Fourth");
    expect((await git(src, "push", "erga", "HEAD:staging")).ok).toBe(true);
    green.add(third);
    await expect(f.repo.merge(ada)).rejects.toThrow(fourth.slice(0, 7));
    expect((await f.repo.merge(ada, third)).commit).toBe(third);
  });

  test("an override moves main past the gate, with its reason, and needs a real reason", async () => {
    await expect(f.repo.merge(ada, undefined, "too short")).rejects.toThrow("at least 10 characters");
    const r = await f.repo.merge(ada, undefined, "Hotfix for the outage, tests broken by infra");
    expect(r.override).toBe(true);
    expect(f.moves.at(-1)?.override).toMatchObject({ reason: "Hotfix for the outage, tests broken by infra" });
    expect(f.moves.at(-1)?.override?.gate).toContain("still running");
  });

  test("a push to main is gated too, with no override: staging lands, main doesn't", async () => {
    const fifth = await commit("Fifth");
    const both = await git(src, "push", "erga", "HEAD:staging", "HEAD:main");
    expect(both.ok).toBe(false);
    expect(both.err).toContain("still running");
    const heads = await must(src, "ls-remote", f.erga);
    expect(heads).toContain(`${fifth}\trefs/heads/staging`);
    expect(heads).not.toContain(`${fifth}\trefs/heads/main`);
    green.add(fifth);
    expect((await git(src, "push", "erga", "HEAD:main")).ok).toBe(true);
  });
});

describe("the shard's job in a VM (factory/vm/gate.ts)", () => {
  test("clones the commit, runs its share with test.sh, and reports each file; status says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "erga-gate-vm-"));
    try {
      const repo = join(dir, "repo");
      const run = (cwd: string, ...a: string[]) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
      spawnSync("mkdir", ["-p", join(repo, "tests")]);
      run(repo, "init", "-q", "-b", "staging");
      // A test.sh like Erga's: it notes each file's seconds, and reports each file as test.sh does. b fails.
      writeFileSync(join(repo, "test.sh"), [
        "#!/usr/bin/env bash",
        'for f in "$@"; do n=$(basename "$f" .ts); if [[ $n == b ]]; then echo "=== $n FAILED (1s)"; else echo "=== $n ok (1s)"; fi; done',
        "exit 0",
        ": <<'PLAN'",
        "run 1 a bun tests/a.ts                # [30]",
        "run 1 b bun tests/b.ts                # [20]",
        "run 1 c bun tests/c.ts                # [10]",
        "PLAN",
      ].join("\n") + "\n");
      chmodSync(join(repo, "test.sh"), 0o755);
      for (const f of ["a", "b", "c"]) writeFileSync(join(repo, "tests", `${f}.ts`), "");
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", private: true, scripts: { typecheck: "true" } }));
      run(repo, "add", ".");
      run(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");
      const head = run(repo, "rev-parse", "HEAD");
      const work = join(dir, "work");
      const job = (...a: string[]) => spawnSync("bun", [join(ROOT, "factory/vm/run.ts"), "gate", ...a], { cwd: dir, encoding: "utf8", env: { ...process.env, REPO_URL: repo, FACTORY_WORK: work }, timeout: 60_000 });
      const status = () => parseStatus(job("status").stdout);
      expect(status().state).toBe("none");
      // Shard 2 of 2, as the split has it (the typecheck alone is the other); b fails in it.
      const plan = planShards(readFileSync(join(repo, "test.sh"), "utf8"), [], 2);
      expect(plan[1].items.map((i) => i.name)).toContain("tests/b.ts");
      const r = job("run", head, "2", "2");
      expect(r.status).toBe(1);
      const s: ShardReport = status();
      expect(s.state).toBe("done");
      expect(s.code).toBe(1);
      expect(s.items?.map((i) => i.name)).toEqual([...(plan[1].typecheck ? ["typecheck"] : []), ...plan[1].items.map((i) => i.name)]);
      expect(s.results?.find((x) => x.name == "tests/b.ts")?.ok ?? true).toBe(!plan[1].items.some((i) => i.name == "tests/b.ts"));
      expect(s.log).toContain("=== ");
      // A rerun of named files only.
      expect(job("run", head, "3", "2", "--files", "tests/a.ts,tests/c.ts").status).toBe(0);
      expect(status()).toMatchObject({ state: "done", code: 0 });
      expect(status().results?.map((x) => x.name)).toEqual(["tests/a.ts", "tests/c.ts"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the VM runner (worker/gate.ts)", () => {
  test("boots the VM, starts the job with the repository, polls its status, and stops it", async () => {
    const calls: string[] = [];
    let alive = true;
    const ns = { getByName: (name: string) => ({
      boot: async () => { calls.push(`boot ${name}`); },
      job: async (script: string, args: string[], env: Record<string, string>, wait: boolean) => {
        calls.push(`job ${script} ${args.join(" ")} ${env.REPO_URL ?? ""} ${wait}`);
        return wait ? { code: 0, output: `noise\nGATE-STATUS ${JSON.stringify({ state: "running", phase: "install" })}\n` } : null;
      },
      alive: async () => alive,
      stop: async () => { calls.push(`stop ${name}`); },
    }) };
    const r = vmRunner(ns, "https://staging.erga.dev/git/erga.git");
    await r.start({ commit: sha("a"), vm: "gate-x-1-1", shard: 1, of: 6 });
    await r.start({ commit: sha("a"), vm: "gate-x-1-7", shard: 7, of: 6, files: ["tests/a.ts", "tests/b.ts"] });
    expect(await r.poll("gate-x-1-1")).toEqual({ state: "running", phase: "install" });
    alive = false;
    expect(await r.poll("gate-x-1-1")).toBe("gone");
    await r.stop("gate-x-1-1");
    expect(calls).toEqual([
      "boot gate-x-1-1", `job run.ts gate run ${sha("a")} 1 6 https://staging.erga.dev/git/erga.git false`,
      "boot gate-x-1-7", `job run.ts gate run ${sha("a")} 7 6 --files tests/a.ts,tests/b.ts https://staging.erga.dev/git/erga.git false`,
      "job run.ts gate status  true", "stop gate-x-1-1",
    ]);
    expect(() => parseStatus("no status here")).toThrow("no status");
  });
});
