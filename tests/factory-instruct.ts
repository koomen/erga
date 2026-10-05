#!/usr/bin/env bun
// The factory (experimental): instructions sent to a task while it works, end
// to end, against a dev server of its own, with simulated VMs and the scripted
// stand-in (factory/vm/fake-claude.ts), as tests/factory.ts does.
//
//   bun tests/factory-instruct.ts
//
// 1. On the board: a working task's detail view takes instructions. The
//    stand-in gets them when its current command ends (no command stopped),
//    works them into its change, and the task is ready to merge.
// 2. A command that runs on: it is stopped a while after the instructions
//    came (a test hook: 3 s), and the stand-in gets them with why.
// 3. A run that says done before it got them: the factory gives them to a
//    new run on the same branch, and the task is ready to merge again.
// The log shows each sent instruction, and when Claude Code got it.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const host = await startHost(null, { env: { ERGA_AGENT_MODEL: "script" }, processEnv: { ERGA_FACTORY_RUNNER: "sim", ERGA_LINK_SECRET: `factory-test-${crypto.randomUUID()}`, ERGA_FACTORY_SIM_NO_SCRIPTS: "1" } });
const browser = await Browser.launch();
const root = host.root;
const api = async (path: string, init: { method?: string; json?: unknown } = {}) => {
  const r = await fetch(`${root}/api/factory${path}`, { method: init.method ?? (init.json ? "POST" : "GET"), headers: { Origin: root, ...(init.json ? { "Content-Type": "application/json" } : {}) }, body: init.json ? JSON.stringify(init.json) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const task = async (id: number) => (await api(`/tasks/${id}`)).body;
const logged = async (id: number, part: string) => (await task(id)).log.some((l: any) => l.message.includes(part));
const logOf = async (id: number) => JSON.stringify((await task(id)).log.map((l: any) => l.message).slice(-14), null, 1);
const STEP = 90_000;

try {
  expect((await fetch(`${root}/admin/settings`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "factory", value: JSON.stringify("on") }) })).ok, "the factory turns on");
  const add = async (title: string, hooks: string) => (await api("/tasks", { json: { title, description: `Put a note on the front page. ${hooks}` } })).body.id as number;
  const a = await add("Note while it works", "[factory-test: long command 15]");
  const b = await add("Stop a long command", "[factory-test: long command 600] [factory-test: instructions wait 3]");
  const c = await add("Done before it heard", "[factory-test: long command 600] [factory-test: instructions wait 3] [factory-test: deaf]");
  for (const id of [a, b, c]) await until(() => logged(id, "The stand-in runs a long command"), STEP, `task #${id}'s stand-in runs its command`, () => logOf(id));

  // ---------------------------------------------------------------- 1. on the board, while it works
  const p = await browser.page(await browser.context());
  await p.open(`${root}/admin/source`, { width: 1400, height: 900, scale: 2 });
  await until(() => p.eval(`!!document.querySelector('[data-open="${a}"]')`), 15_000, "the card is on the board");
  await p.eval(`document.querySelector('[data-open="${a}"]').click()`);
  await until(() => p.eval(`!!document.getElementById("instructions")`), 5000, "the working task's detail view has a box for instructions");
  expect((await p.eval<string>(`document.getElementById("dlg").innerText`)).includes("when its current step ends"), "it says when Claude Code gets them");
  expect((await api(`/tasks/${a}/revise`, { json: { instructions: " " } })).status == 409, "empty instructions are refused");
  await p.eval(`(() => { const t = document.getElementById("instructions"); t.value = "Make it blue."; t.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector('[data-act="revise"]').click(); })()`);
  await until(async () => (await p.eval<string>(`document.getElementById("revise-why")?.textContent || ""`)).startsWith("Sent"), 5000, "the board says they're sent");
  expect((await task(a)).status == "working" && (await task(a)).waiting == 1 && await logged(a, "tester asked, while it works: Make it blue."), "the task works on, and its log shows the instructions", await logOf(a));
  await until(async () => (await p.eval<string>(`document.getElementById("dlg").innerText`)).includes("1 instruction waits"), 5000, "the detail view says one waits");
  await p.screenshot(join(SHOTS, "factory-instruct-working.png"));
  await until(async () => (await task(a)).status == "complete", STEP, "task A is ready to merge", () => logOf(a));
  const ta = await task(a);
  expect(ta.log.some((l: any) => /Claude Code got the instructions from tester after a step \(Bash\)/.test(l.message)) && ta.log.some((l: any) => l.message.includes("The stand-in got the instructions: Make it blue.")), "the log says when Claude Code got them", await logOf(a));
  expect(!ta.log.some((l: any) => l.message.includes("stopped, so they reach")) && ta.log.some((l: any) => l.message.includes("sleep 15: 0")), "its command ran to its end", await logOf(a));
  expect(!ta.waiting, "nothing waits any more");
  const note = await (await fetch(ta.url.replace("//localhost:", "//127.0.0.1:"))).text();
  expect(note.includes("instructed task #") && note.includes("asked while it worked: Make it blue."), "the change has them, in the same run", note.slice(0, 600));
  await p.eval(`document.querySelector('[data-act="close"]')?.click()`);
  ok("on the board: a working task takes instructions; its Claude Code gets them when its current step ends, and the log shows both");

  // ---------------------------------------------------------------- 2. a command that runs on
  expect((await api(`/tasks/${b}/revise`, { json: { instructions: "Say it in French." } })).status == 200, "instructions for a task whose command runs on");
  await until(async () => (await task(b)).status == "complete", STEP, "task B is ready to merge", () => logOf(b));
  const tb = await task(b);
  expect(tb.log.some((l: any) => /Claude Code's command ran for \d+s while instructions waited: stopped, so they reach Claude Code \(Bash: sleep 600\)/.test(l.message)), "the command is stopped", await logOf(b));
  expect(tb.log.some((l: any) => l.message.includes("The stand-in got the instructions: Say it in French. (its command was stopped for them)")), "Claude Code gets them, with why its command stopped", await logOf(b));
  ok("a command that runs on is stopped a while after the instructions came, so they reach Claude Code");

  // ---------------------------------------------------------------- 3. done before it got them
  const before = (await task(c)).commit;
  expect((await api(`/tasks/${c}/revise`, { json: { instructions: "Shorter, please." } })).status == 200, "instructions for a task that won't hear them");
  await until(() => logged(c, "said it was done before it got the instructions from tester: it works on them now"), STEP, "the factory sees the run end first", () => logOf(c));
  await until(async () => { const t = await task(c); const m = t.log.map((l: any) => l.message); return t.status == "complete" && m.lastIndexOf("Ready to merge") > m.findIndex((l: string) => l.includes("it works on them now")); }, STEP, "task C is ready to merge again", () => logOf(c));
  const branch = (await task(c)).branch;
  const commits = spawnSync("git", ["-C", join(host.state, "factory", "erga.git"), "log", "--format=%s", `staging..${branch}`], { encoding: "utf8" }).stdout;
  expect(commits.includes("Revise task #") && commits.includes("Factory task #") && (await task(c)).commit != before, "a new run worked on them, on the same branch", commits);
  ok("a run that says done before it got the instructions: a new run gets them, on the same branch");

  console.log("all factory instruction checks pass");
} catch (e) {
  const vms = join(host.state, "factory", "vms");
  if (existsSync(vms)) for (const n of readdirSync(vms)) {
    const f = join(vms, n, "vm.log");
    if (existsSync(f)) console.error(`--- ${n}/vm.log (tail)\n${readFileSync(f, "utf8").slice(-1500)}`);
  }
  console.error(`--- the dev server (tail)\n${host.output().slice(-3000)}`);
  throw e;
} finally {
  browser.close();
  spawnSync("pkill", ["-f", join(host.state, "factory", "vms")], { stdio: "ignore" });
  await host.dispose();
}
