#!/usr/bin/env bun
// The factory's local tasks, end to end, against a dev server of its own (simulated VMs, the scripted stand-in, as
// tests/factory.ts). A "local agent" is `bun factory/task.ts` run in a temporary clone of the dev server's
// repository, with an admin token (ERGA_TOKEN), as Claude Code on a laptop runs it.
//
//   bun tests/factory-local.ts
//
// 1. Register: `task new` makes a local task (no VM), its branch from staging, pushed with a git token for it.
// 2. Report: a log line, a screenshot, done (pushed; ready to merge).
// 3. The board: the card's "local" chip with the machine, and the detail's "Runs locally", Hand to a VM.
// 4. Instructions from the board reach it: done is refused while they wait, `task inbox` takes them once.
// 5. Merge: a VM started for the merge job only; staging gets "Merge task/<id>-<slug>: title" (--no-ff), the branch
//    goes; the agent's reports are refused after.
// 6. Dependencies: a local task that starts after another waits (task start refused), and works once it merges.
// 7. A conflict: needs agent, the merge VM stopped, the agent's inbox says how; task pull --staging, resolve,
//    task done, and the merge goes on to merged.
// 8. A stale local task (stalled after 5 quiet minutes, factory/stall.ts) handed to a VM: the stand-in goes on from
//    what the agent pushed, and the agent's reports are refused.
// covers: factory/task.ts factory/prompt.ts factory/page.ts factory/agent.ts worker/factory.ts factory/vm/task.ts factory/vm/common.ts factory/vm/merge.ts factory/stall.ts

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branches, mintGitToken } from "../dev/factory";
import { stalledOf } from "../factory/stall";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const secret = `factory-test-${crypto.randomUUID()}`;
const host = await startHost(null, { env: { ERGA_AGENT_MODEL: "script" }, processEnv: { ERGA_FACTORY_RUNNER: "sim", ERGA_LINK_SECRET: secret, ERGA_FACTORY_SIM_NO_SCRIPTS: "1" } });
const browser = await Browser.launch();
const root = host.root;
const api = async (path: string, init: { method?: string; json?: unknown } = {}) => {
  const r = await fetch(`${root}/api/factory${path}`, { method: init.method ?? (init.json ? "POST" : "GET"), headers: { Origin: root, ...(init.json ? { "Content-Type": "application/json" } : {}) }, body: init.json ? JSON.stringify(init.json) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const task = async (id: number) => (await api(`/tasks/${id}`)).body;
const logOf = async (id: number) => JSON.stringify((await task(id)).log.map((l: any) => l.message).slice(-12), null, 1);
const logged = async (id: number, part: string) => (await task(id)).log.some((l: any) => l.message.includes(part));
const repo = join(host.state, "factory", "erga.git");
const inRepo = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout.trim();
const STEP = 90_000;
const dirs: string[] = [];

/** A checkout of the dev server's repository, as a laptop has one (the dev server's needs a token to read: any task's). */
function checkout(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `factory-local-${name}-`));
  dirs.push(dir);
  const read = mintGitToken(secret, { scope: "task", branch: "task/999999-read", exp: Math.floor(Date.now() / 1000) + 3600 });
  const r = spawnSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${read}`, "clone", "-q", `${root}/__factory/git/erga.git`, dir], { encoding: "utf8", timeout: 120_000 });
  expect(r.status == 0, `a checkout (${name})`, r.stderr);
  for (const [k, v] of [["user.name", "Local Agent"], ["user.email", "local@example.com"]]) spawnSync("git", ["-C", dir, "config", k, v]);
  return dir;
}
const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
const commit = (dir: string, file: string, text: string, message: string) => { writeFileSync(join(dir, file), text); git(dir, "add", file); expect(git(dir, "commit", "-q", "-m", message).status == 0, `a commit: ${message}`); };

/** The local agent: `bun factory/task.ts ...` in its checkout, with its admin token. */
let token = "";
const CLI = join(import.meta.dir, "..", "factory", "task.ts");
function local(dir: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync("bun", [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 150_000, env: { ...process.env, ERGA_TOKEN: token, ERGA_MACHINE: "test-laptop", GIT_TERMINAL_PROMPT: "0", FACTORY_TASK: "" } });
  return { code: r.status ?? 124, out: `${r.stdout}${r.stderr}` };
}
const idOf = (out: string) => Number(/Registered task #(\d+)/.exec(out)?.[1]);

try {
  expect((await fetch(`${root}/admin/settings`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "factory", value: JSON.stringify("on") }) })).ok, "the factory turns on");
  // An admin token, as Claude Code on a laptop has one (README, Tokens).
  const made = await (await fetch(`${root}/tokens/new`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ label: "Laptop agent", scope: "admin" }) })).text();
  token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(made)?.[1] ?? "";
  expect(token, "an admin token", made.slice(0, 300));

  // ---------------------------------------------------------------- 1. register
  const dirA = checkout("a");
  const reg = local(dirA, "new", "Local hello", "Add a note file, from a local agent.");
  const a = idOf(reg.out);
  expect(reg.code == 0 && a > 0, "task new registers a local task", reg.out);
  const ta = await task(a);
  const staging0 = branches(host.state).staging;
  expect(ta.status == "working" && !ta.vm && ta.local?.machine == "test-laptop" && ta.local?.by == "tester, via a shared agent (Laptop agent)", "it works, with no VM, run by the agent on its machine", ta);
  expect(ta.branch == `task/${a}-local-hello` && ta.base == staging0 && branches(host.state)[ta.branch] == staging0, "its branch is made from staging and pushed", { ta, b: branches(host.state) });
  expect(git(dirA, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim() == ta.branch, "the checkout is on the task's branch");
  expect(reg.out.includes("task inbox") && reg.out.includes("task done"), "it tells the agent how to report", reg.out);
  const mine = await fetch(`${root}/api/factory/tasks/${a}/log`, { method: "POST", headers: { Origin: root, "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
  expect(mine.ok, "the admin may report on a local task over the API", mine.status);
  ok("register: a local task, no VM, its branch from staging pushed with its own git token");

  // ---------------------------------------------------------------- 2. log, screenshot, done
  commit(dirA, "local-a.txt", "A note from a local agent.\n", "Add a local note");
  expect(local(dirA, "log", "Wrote the note").code == 0, "task log");
  const p = await browser.page(await browser.context());
  await p.open(`${root}/admin/factory`, { width: 1400, height: 900, scale: 1 });
  const png = join(dirs[0], "..", `factory-local-${a}.png`);
  await p.screenshot(png);
  const shot = local(dirA, "shot", png, "The board, from the local agent");
  rmSync(png, { force: true });
  expect(shot.code == 0, "task shot", shot.out);
  const done = local(dirA, "done", "This task adds a note file.");
  expect(done.code == 0, "task done", done.out);
  const ta2 = await task(a);
  const head = git(dirA, "rev-parse", "HEAD").stdout.trim();
  expect(ta2.status == "complete" && ta2.commit == head && branches(host.state)[ta2.branch] == head && ta2.summary == "This task adds a note file.", "ready to merge: pushed, with its summary", ta2);
  expect(ta2.screenshots.length == 1 && await logged(a, "Wrote the note"), "the log line and the screenshot are on the task", await logOf(a));
  ok("report: a log line, a screenshot, done (the branch pushed, ready to merge)");

  // ---------------------------------------------------------------- 3. the board
  await until(() => p.eval(`!!document.querySelector('[data-open="${a}"] .chip.local')`), 10_000, "the card has a local chip");
  const chip = await p.eval<string>(`document.querySelector('[data-open="${a}"] .chip.local').textContent`);
  expect(chip.includes("local") && chip.includes("test-laptop"), "the chip says local, and the machine", chip);
  await p.screenshot(join(SHOTS, "factory-local-board.png"));
  await p.eval(`document.querySelector('[data-open="${a}"]').click()`);
  await until(() => p.eval(`document.getElementById("dlg").open`), 5000, "the detail opens");
  const detail = await p.eval<string>(`document.getElementById("dlg").innerText`);
  expect(detail.includes("Runs locally: tester, via a shared agent (Laptop agent) on test-laptop") && detail.includes("Hand to a VM") && detail.includes("Send to the local agent"), "the detail: who runs it where, Hand to a VM, Send to the local agent", detail.slice(0, 900));
  await p.screenshot(join(SHOTS, "factory-local-detail.png"));
  await p.eval(`document.querySelector('[data-act="close"]').click()`);
  ok("the board: a local chip with the machine; the detail says who runs it, with Hand to a VM");

  // ---------------------------------------------------------------- 4. instructions
  expect((await api(`/tasks/${a}/revise`, { json: { instructions: "Add a second line." } })).status == 200, "instructions sent from the board");
  const ta3 = await task(a);
  expect(ta3.status == "working" && ta3.waiting == 1 && !ta3.vm, "the task works again, with no VM, and one instruction waits", ta3);
  const early = local(dirA, "done", "Done already?");
  expect(early.code != 0 && early.out.includes("task inbox"), "done is refused while instructions wait", early.out);
  const inbox = local(dirA, "inbox");
  expect(inbox.code == 0 && inbox.out.includes("tester asks: Add a second line."), "task inbox shows them", inbox.out);
  expect(local(dirA, "inbox").out.includes("No instructions wait."), "each one once");
  expect(await logged(a, "The local agent got the instructions from tester"), "the log says the agent got them", await logOf(a));
  commit(dirA, "local-a.txt", "A note from a local agent.\nA second line.\n", "A second line");
  expect(local(dirA, "done", "This task adds a note file, with two lines.").code == 0, "done again");
  expect((await task(a)).status == "complete", "ready to merge again");
  ok("instructions from the board reach the local agent (task inbox), once; done waits for them");

  // ---------------------------------------------------------------- 5. merge
  // Two more local tasks first, for the conflict (7) and a dependency (6), from staging as it is now.
  const dirB = checkout("b"), dirC = checkout("c"), dirE = checkout("e");
  const b = idOf(local(dirB, "new", "Shared line one", "Write the shared file.").out);
  const c = idOf(local(dirC, "new", "Shared line two", "Write the shared file too.").out);
  const regE = local(dirE, "new", "After line one", "Builds on the shared file.", "--start-after", String(b));
  const e = idOf(regE.out);
  expect(b && c && e && regE.out.includes("It waits"), "three more local tasks, one waiting for another", regE.out);

  expect((await api(`/tasks/${a}/merge`, { method: "POST" })).status == 202, "Merge, on a local task");
  await until(async () => (await task(a)).status == "merged", STEP, "the local task is merged", () => logOf(a));
  const merged = await task(a);
  const [subject, parents] = inRepo("log", "-1", "--format=%s%n%P", "staging").split("\n");
  expect(subject == `Merge ${ta.branch}: Local hello` && parents.split(" ").length == 2 && merged.mergeCommit == branches(host.state).staging, "staging: a --no-ff merge commit named after the task", { subject, parents });
  expect(inRepo("show", "staging:local-a.txt").includes("A second line.") && !branches(host.state)[ta.branch], "its work is on staging, and the branch is gone", branches(host.state));
  expect(!merged.vm && await logged(a, "started for the job"), "the merge ran in a VM started for it, now stopped", await logOf(a));
  const after = local(dirA, "log", "Still here");
  expect(after.code != 0 && after.out.includes("merged"), "a merged task takes no more reports", after.out);
  ok("merge: a VM for the merge job only; staging gets \"Merge task/<id>-<slug>: title\" (--no-ff), the branch is deleted");

  // ---------------------------------------------------------------- 6. a dependency, and 7. a conflict
  commit(dirB, "local-shared.txt", "line from B\n", "B's line");
  expect(local(dirB, "done", "B writes the shared file.").code == 0, "B is done");
  commit(dirC, "local-shared.txt", "line from C\n", "C's line");
  expect(local(dirC, "done", "C writes the shared file.").code == 0, "C is done");
  const te = await task(e);
  expect(te.status == "queued" && te.blockedBy?.start?.includes(b), "E waits for B", te);
  const blocked = local(dirE, "start", String(e));
  expect(blocked.code != 0 && blocked.out.includes("waits"), "task start is refused while it waits", blocked.out);
  expect((await api(`/tasks/${b}/merge`, { method: "POST" })).status == 202, "Merge B");
  await until(async () => (await task(b)).status == "merged", STEP, "B is merged", () => logOf(b));
  await until(async () => (await task(e)).status == "working", 10_000, "E works once B merges, with no VM", () => logOf(e));
  expect(!(await task(e)).vm && local(dirE, "start", String(e)).code == 0 && branches(host.state)[(await task(e)).branch] == branches(host.state).staging, "task start makes E's branch from the new staging");
  ok("a dependency: a local task waits (task start refused), and works when the task it waits for merges");

  expect((await api(`/tasks/${c}/merge`, { method: "POST" })).status == 202, "Merge C");
  await until(async () => (await task(c)).status == "needs agent", STEP, "C needs its agent: it conflicts", () => logOf(c));
  const tc = await task(c);
  expect(/conflicts with staging in local-shared\.txt/.test(tc.error) && !tc.vm && tc.local && tc.waiting == 1, "the reason, the merge VM stopped, and word for the local agent", tc);
  await until(() => p.eval(`!!document.querySelector('[data-open="${c}"] .flag')`), 10_000, "the card says needs agent");
  const told = local(dirC, "inbox");
  expect(told.out.includes("task pull --staging") && told.out.includes("local-shared.txt"), "the agent's inbox says how to finish the merge", told.out);
  const pulled = local(dirC, "pull", "--staging");
  expect(pulled.code != 0 && pulled.out.includes("conflicts in: local-shared.txt"), "task pull --staging stops at the conflict", pulled.out);
  writeFileSync(join(dirC, "local-shared.txt"), "line from B\nline from C\n");
  git(dirC, "add", "local-shared.txt");
  expect(git(dirC, "commit", "-q", "--no-edit").status == 0, "the agent commits the resolution");
  const resolved = local(dirC, "done", "Kept both lines.");
  expect(resolved.code == 0, "task done after the resolution", resolved.out);
  await until(async () => (await task(c)).status == "merged", STEP, "the merge goes on, to merged", () => logOf(c));
  expect(inRepo("log", "-1", "--format=%s", "staging") == `Merge ${tc.branch}: Shared line two` && inRepo("show", "staging:local-shared.txt") == "line from B\nline from C", "staging has C's merge, with both lines");
  ok("a conflict: needs agent, the local agent is told, resolves with task pull --staging, says done, and the merge goes on to merged");

  // ---------------------------------------------------------------- 8. stale: handed to a VM
  commit(dirE, "local-e.txt", "E's unfinished work\n", "E: work in progress");
  expect(local(dirE, "push").code == 0, "the agent pushes its work, then goes quiet");
  const te2 = await task(e);
  expect(!te2.stalled && stalledOf(te2, Date.now() + 6 * 60_000), "a quiet local task is stalled after 5 minutes, as a VM's is", te2.stalled);
  expect((await api(`/tasks/${e}/restart`, { method: "POST" })).status == 200, "Hand to a VM (Restart)");
  const te3 = await task(e);
  expect(!te3.local && te3.handedFrom == "tester, via a shared agent (Laptop agent) on test-laptop" && await logged(e, "Handed to a VM by tester"), "it is a VM's task now, and the log says from whom", te3);
  const refused = local(dirE, "log", "I'm back");
  expect(refused.code != 0 && refused.out.includes("handed to a VM"), "the old local agent's reports are refused", refused.out);
  await until(async () => (await task(e)).status == "complete", STEP, "the VM's stand-in finishes it", () => logOf(e));
  const te4 = await task(e);
  const onBranch = inRepo("log", "--format=%s", `staging..${te4.branch}`);
  expect(onBranch.includes("E: work in progress") && onBranch.includes(`Factory task #${e}`), "the VM went on from what the agent pushed", onBranch);
  expect(await logged(e, "handed this task to you"), "the VM's Claude Code was told it was a local task", await logOf(e));
  expect((await api(`/tasks/${e}/discard`, { method: "POST" })).status == 200, "and it is discarded");
  ok("a stale local task handed to a VM: a fresh VM goes on from the pushed branch; the old agent is refused");
  console.log("all local task checks pass");
} catch (err) {
  const vms = join(host.state, "factory", "vms");
  if (existsSync(vms)) for (const n of readdirSync(vms)) {
    const f = join(vms, n, "vm.log");
    if (existsSync(f)) console.error(`--- ${n}/vm.log (tail)\n${readFileSync(f, "utf8").slice(-1500)}`);
  }
  console.error(`--- the dev server (tail)\n${host.output().slice(-3000)}`);
  throw err;
} finally {
  browser.close();
  spawnSync("pkill", ["-f", join(host.state, "factory", "vms")], { stdio: "ignore" });
  await host.dispose();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
