#!/usr/bin/env bun
// The factory (experimental) when its Durable Object resets (any deploy of
// the server that hosts it does), and at Claude Code's limits, end to end,
// against a dev server of its own, with simulated VMs and the scripted
// stand-in (factory/vm/fake-claude.ts), as tests/factory.ts does. The reset
// is the dev server stopping and starting again, on the same state.
//
//   bun tests/factory-reset.ts
//
// 1. --max-turns: a stand-in that stops at its turn limit without reporting is
//    woken once to finish, and the task is ready to merge (it failed before).
// 2. A merge that goes on right after a resolve: the stand-in said done and
//    lingers 25 s; the merge stops it after 10 s (LIMITS.stopReported), not 30.
// 3. The server restarts while a merge waits for its answer, after the VM
//    moved staging and deleted the branch (a test hook pauses the job there):
//    the task is merged, with the merge commit, and the task that starts after
//    it starts by itself. Claude Code isn't woken.
// 4. The server restarts in the middle of a restart (a test hook pauses the old
//    VM's save): the task starts again by itself, the old VM saves the work, and
//    a fresh VM finishes it from the pushed branch.
// covers: factory/vm/ factory/recover.ts worker/factory.ts dev/factory.ts

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { branches } from "../dev/factory";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const host = await startHost(null, { env: { ERGA_AGENT_MODEL: "script" }, processEnv: { ERGA_FACTORY_RUNNER: "sim", ERGA_LINK_SECRET: `factory-test-${crypto.randomUUID()}`, ERGA_FACTORY_SIM_NO_SCRIPTS: "1" } });
const root = host.root;
const api = async (path: string, init: { method?: string; json?: unknown } = {}) => {
  const r = await fetch(`${root}/api/factory${path}`, { method: init.method ?? (init.json ? "POST" : "GET"), headers: { Origin: root, ...(init.json ? { "Content-Type": "application/json" } : {}) }, body: init.json ? JSON.stringify(init.json) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const task = async (id: number) => (await api(`/tasks/${id}`)).body;
const msgs = async (id: number): Promise<string[]> => (await task(id)).log.map((l: any) => l.message);
const logged = async (id: number, part: string) => (await msgs(id)).some((m) => m.includes(part));
const logOf = async (id: number) => JSON.stringify({ status: (await task(id)).status, error: (await task(id)).error, log: (await msgs(id)).slice(-14) }, null, 1);
const add = async (title: string, description: string, extra: Record<string, unknown> = {}) => {
  const r = await api("/tasks", { json: { title, description, ...extra } });
  expect(r.status == 201, `task "${title}" is added`, r);
  return r.body.id as number;
};
const repo = join(host.state, "factory", "erga.git");
const STEP = 90_000;

try {
  expect((await fetch(`${root}/admin/settings`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "factory", value: JSON.stringify("on") }) })).ok, "the factory turns on");

  // ---------------------------------------------------------------- 1. --max-turns
  const turns = await add("Stop at the turn limit", "Put a note on the front page. [factory-test: max turns]");
  // A and B both put a note under the front page's heading: merging staging into B, after A, conflicts.
  const a = await add("Note A", "Put a note on the front page.");
  const b = await add("Note B, lingers", "Another note on the front page. [factory-test: linger 25]");
  await until(async () => (await task(turns)).status == "complete", STEP, "the task that hit its turn limit is ready to merge", () => logOf(turns));
  const t = await task(turns);
  expect((await msgs(turns)).some((m) => m.startsWith("Claude Code used all its 300 turns (--max-turns) without saying done or failed. Waking it to finish.")), "the log says it used its turns, and was woken", await logOf(turns));
  expect(t.summary.includes("woken") && !t.error && !(await msgs(turns)).includes("Failed"), "the woken run finished it: no failure", t);
  ok("--max-turns: Claude Code is woken once to finish, and the task is ready to merge");

  // ---------------------------------------------------------------- 2. the merge after a resolve waits 10 s, not 30
  await until(async () => (await task(a)).status == "complete" && (await task(b)).status == "complete", STEP, "A and B are ready", async () => [await logOf(a), await logOf(b)]);
  expect((await api(`/tasks/${a}/merge`, { method: "POST" })).status == 202, "A's merge starts");
  await until(async () => (await task(a)).status == "merged", STEP, "A is merged", () => logOf(a));
  expect((await api(`/tasks/${b}/merge`, { method: "POST" })).status == 202, "B's merge starts");
  await until(async () => (await task(b)).status == "merged", STEP * 2, "B is merged, after its stand-in resolved the conflict", () => logOf(b));
  const bLog = (await task(b)).log as { at: string; message: string }[];
  const goesOn = bLog.find((l) => l.message == "The merge goes on"), merged = bLog.find((l) => l.message.startsWith("Merged into staging"));
  expect(bLog.some((l) => l.message.startsWith("Needs agent: The branch conflicts with staging")) && goesOn && merged, "B needed its agent, then the merge went on", bLog.slice(-14));
  const waited = (Date.parse(merged!.at) - Date.parse(goesOn!.at)) / 1000;
  expect(bLog.some((l) => l.message == "The merge stopped the task's Claude Code: it still ran 10s after the merge started"), "the merge stopped the lingering stand-in after 10 s", bLog.slice(-14));
  expect(waited < 22, `the merge ended ${waited.toFixed(1)} s after the stand-in said done (it lingers 25 s)`, bLog.slice(-14));
  ok(`the merge after a resolve: the stand-in that lingers is stopped after 10 s, and the merge ends ${waited.toFixed(1)} s after it said done`);

  // ---------------------------------------------------------------- 3 and 4. the server restarts mid-merge and mid-restart
  const c = await add("Note C, merged across a restart", "Put a note on the front page. [factory-test: pause after merge 120]");
  const e = await add("Restarted across a restart", "Put a note on the front page. [factory-test: keep working] [factory-test: pause in save 120]");
  const d = await add("After C", "Put a note on the front page.", { startAfter: [c] });
  await until(async () => (await task(c)).status == "complete", STEP, "C is ready", () => logOf(c));
  await until(() => logged(e, "keeps working"), STEP, "E works, with work not committed", () => logOf(e));
  expect((await task(d)).status == "queued" && !(await task(d)).vm, "D waits for C, with no VM");
  const cBranch = (await task(c)).branch, eVm = (await task(e)).vm;

  expect((await api(`/tasks/${c}/merge`, { method: "POST" })).status == 202, "C's merge starts");
  await until(() => logged(c, "it answers in 120s"), STEP, "C's job moved staging and deleted the branch, and waits before it answers", () => logOf(c));
  expect(!branches(host.state)[cBranch] && (await task(c)).status == "merging", "C's branch is gone, and the factory still waits for the answer");
  const stagingAfterC = branches(host.state).staging;
  expect((await api(`/tasks/${e}/restart`, { method: "POST" })).status == 200, "E restarts");
  await until(() => logged(e, "The save stopped Claude Code; it goes on in 120s"), STEP, "E's old VM saves the work, and waits", () => logOf(e));

  // The reset: the server is killed at once, as a deploy cuts a Durable Object off (nothing of the old one runs on:
  // a gentle stop let its workerd finish a step against the new server), and starts again on the same state. The
  // simulated VMs' jobs go with it.
  await host.stop("SIGKILL");
  await host.start();

  await until(async () => (await task(c)).status == "merged", STEP, "C is merged after the restart", () => logOf(c));
  const tc = await task(c);
  expect(tc.mergeCommit == stagingAfterC && branches(host.state).staging == stagingAfterC, "C's merge commit is staging's, which no new merge moved", { tc: tc.mergeCommit, stagingAfterC, now: branches(host.state).staging });
  const subject = spawnSync("git", ["-C", repo, "log", "-1", "--format=%s", tc.mergeCommit], { encoding: "utf8" }).stdout.trim();
  expect(subject.startsWith(`Merge ${cBranch}:`), "and it is C's merge", subject);
  expect((await msgs(c)).some((m) => m.startsWith("The factory restarted during the merge, but staging has it: merged as")), "C's log says how", await logOf(c));
  expect(!(await msgs(c)).some((m) => /Needs agent|Merge failed|Merge again/.test(m)) && !tc.vm, "C never went to needs agent or back to ready, and its VM is stopped", await logOf(c));
  await until(async () => !!(await task(d)).vm, 30_000, "D, which starts after C, starts by itself", () => logOf(d));
  expect((await msgs(d)).some((m) => m.startsWith(`#${c} merged: unblocked`)), "D's log says why", await logOf(d));
  ok("the server restarts while a merge waits for its answer, after staging moved: the task is merged, and its dependent starts");

  await until(() => logged(e, "Starting again: the factory restarted before the task's run of Claude Code started"), 30_000, "E starts again by itself", () => logOf(e));
  await until(async () => { const te = await task(e); return te.status == "complete" && !!te.vm && te.vm != eVm; }, STEP, "E is ready to merge, from a fresh VM", () => logOf(e));
  const eLog = await msgs(e);
  expect(eLog.some((m) => /^Saved before the restart: .*1 uncommitted file committed/.test(m)) && eLog.some((m) => m == `VM ${eVm} stopped`), "the old VM saved the work, then stopped", eLog.slice(-16));
  expect(eLog.filter((m) => m.startsWith("Starting again:")).length == 1 && eLog.filter((m) => m.startsWith("The stand-in was restarted.")).length == 1, "it started again once, with the restart brief", eLog.slice(-16));
  const branchLog = spawnSync("git", ["-C", repo, "log", "--format=%s", "--name-only", `staging..${(await task(e)).branch}`], { encoding: "utf8" }).stdout;
  expect(/saved by the factory before a restart\n+factory-wip\.txt/.test(branchLog) && branchLog.includes(`Factory task #${e}`), "the uncommitted work is on the branch, and the fresh run went on from it", branchLog);
  ok("the server restarts in the middle of a restart: the task starts again by itself, its work saved, in a fresh VM");

  await until(async () => (await task(d)).status == "complete", STEP, "D is ready too", () => logOf(d));
  console.log("all factory reset checks pass");
} catch (err) {
  const vms = join(host.state, "factory", "vms");
  if (existsSync(vms)) for (const n of readdirSync(vms)) {
    const f = join(vms, n, "vm.log");
    if (existsSync(f)) console.error(`--- ${n}/vm.log (tail)\n${readFileSync(f, "utf8").slice(-1500)}`);
  }
  console.error(`--- the dev server (tail)\n${host.output().slice(-3000)}`);
  throw err;
} finally {
  // The simulated VMs' previews run detached, as in a VM (task.ts, daemon): stopped by their folder, under this server's state.
  spawnSync("pkill", ["-f", join(host.state, "factory", "vms")], { stdio: "ignore" });
  await host.dispose();
}
