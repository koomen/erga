#!/usr/bin/env bun
// The production gate end to end, in the real Worker, on a dev server of its own (tests/host.ts) with the local
// fake runner (deploy/gate.ts, fakeRunner: a commit's subject decides its result) and the scripted agent model:
//
//   - each push to staging starts the commit's test run by itself; a newer push cancels the run still going;
//   - a red commit (failed), a running one and one with no run: main refuses it on every path, and says why and
//     where its run is: the dashboard's merge (a browser session), the API (an admin token), the admin agent's
//     deploy_production, and a git push to main;
//   - a green commit moves main; so does an earlier green one while staging's head is red;
//   - a rerun (the API, and the agent's run_tests), and a flaky run (failed once, passed when run again);
//   - the emergency override: refused to a token, needs a reason, and the change log keeps it;
//   - the Factory page: the tests column, Merge off with the reason, Merge to newest green, a run's shards.
//
//   bun tests/gate.ts
// covers: deploy/gate.ts worker/gate.ts worker/pipeline.ts worker/deploys.ts source/repo.ts worker/source-host.ts worker/source.ts source/page.ts factory/agent.ts admin.ts

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBare } from "../dev/git-server";
import { Browser, ROOT, SHOTS, type Page } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const host = await startHost(null, { env: { ERGA_AGENT_MODEL: "script", ERGA_GATE_FAKE_MS: "700" } });
const root = host.root;
let browser: Browser | null = null;
let failed = false;

const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } as Record<string, string>;
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  return { ok: r.status == 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const must = (cwd: string, ...args: string[]) => { const r = git(cwd, ...args); expect(r.ok, `git ${args.join(" ")}`, r.err); return r.out; };

type Run = { commit: string; state: string; attempt: number; failed: string[]; flaky: string[]; shards: { n: number; state: string; rerun?: boolean }[]; supersededBy?: string };

try {
  // This clone's HEAD as staging and main.
  const bare = join(host.state, "artifacts", "erga", "erga.git");
  ensureBare(bare);
  const seeded = Bun.spawnSync(["git", "push", "-q", bare, "HEAD:refs/heads/staging", "HEAD:refs/heads/main"], { cwd: ROOT });
  expect(seeded.exitCode == 0, "pushed this clone as staging and main", seeded.stderr.toString());

  // The admin (DEV_LOGIN, "tester"): a browser session, and an admin token for git and the API.
  const r0 = await fetch(`${root}/auth/github?next=/docs`, { redirect: "manual" });
  const cookie = r0.headers.getSetCookie().map((x) => x.split(";")[0]).find((x) => x.startsWith("erga_session="))!;
  const page = await (await fetch(`${root}/tokens/new`, { method: "POST", headers: { Cookie: cookie, Origin: root }, body: new URLSearchParams({ label: "Git", scope: "admin" }) })).text();
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1] ?? "";
  expect(token, "an admin token", page.slice(0, 300));
  const api = (path: string, init: RequestInit & { as?: "token" | "cookie" } = {}) => fetch(`${root}${path}`, {
    ...init, redirect: "manual",
    headers: { "Content-Type": "application/json", ...(init.as == "cookie" ? { Cookie: cookie, Origin: root } : { Authorization: `Bearer ${token}` }), ...(init.headers as Record<string, string>) },
  });
  const runOf = async (sha: string) => ((await (await api(`/api/gate/${sha}`)).json()) as { run: Run | null; verdict: { ok: boolean; state: string; reason: string | null } });
  const until_ = (sha: string, state: string, what: string) => until(async () => (await runOf(sha)).run?.state == state, 30_000, what, () => runOf(sha));
  const merge = async (as: "token" | "cookie", body: Record<string, unknown> = {}) => {
    const r = await api("/api/source/merge", { method: "POST", as, body: JSON.stringify({ from: "staging", to: "main", ...body }) });
    return { status: r.status, body: await r.json() as { commit?: string; error?: string; override?: boolean } };
  };

  const dir = mkdtempSync(join(tmpdir(), "erga-gate-e2e-"));
  const remote = `http://erga:${encodeURIComponent(token)}@127.0.0.1:${host.port}/git/erga.git`;
  must(tmpdir(), "clone", "-q", "-b", "staging", remote, join(dir, "c"));
  const c = join(dir, "c");
  const push = (subject: string) => {
    writeFileSync(join(c, "gate-test.txt"), `${subject}\n${Math.random()}\n`);
    must(c, "add", "."); must(c, "commit", "-qm", subject);
    must(c, "push", "-q", "origin", "HEAD:staging");
    return must(c, "rev-parse", "HEAD");
  };

  // ---- a green commit, then a red one on top -------------------------------------------------------
  const green = push("A change that passes");
  await until_(green, "passed", "a push to staging runs the commit's tests by itself, and they pass");
  const red = push("A change that breaks a test [gate-fail]");
  await until_(red, "failed", "the next push's run fails");
  let run = (await runOf(red)).run!;
  expect(run.failed.join() == "tests/fake-fail.ts" && run.shards.some((s) => s.rerun), "it names the failed file, after one rerun of it", run);
  ok("each push to staging runs its tests by itself (a few test files that fail run once more)");

  // ---- red refuses main on every path ---------------------------------------------------------------
  let m = await merge("token");
  expect(m.status == 409 && m.body.error!.includes("failed: tests/fake-fail.ts") && m.body.error!.includes(`/admin/factory#tests-${red.slice(0, 12)}`), "the API (an admin token): 409, why, and where its run is", m);
  m = await merge("cookie");
  expect(m.status == 409 && m.body.error!.includes("failed"), "the dashboard's merge (a browser session): 409", m);
  m = await merge("token", { commit: red });
  expect(m.status == 409, "naming the commit: 409 too", m);
  const pushed = git(c, "push", "origin", "HEAD:main");
  expect(!pushed.ok && pushed.err.includes("failed: tests/fake-fail.ts"), "a git push to main: refused, with why", pushed.err);
  // The admin agent: deploy_production is refused with the reason; it reads the runs, and runs the tests again.
  browser = await Browser.launch();
  const p: Page = await browser.page(await browser.context());
  await p.open(`${root}/admin/factory`, { width: 1440, height: 900 });
  await until(() => p.eval<boolean>(`document.getElementById("agent-send").title == "Type a message to send it."`), 20_000, "the admin agent is on");
  await Bun.sleep(500);
  type Item = { kind: string; name?: string; status?: string; detail?: string };
  const say = async (text: string, steps: unknown[], done: string) => {
    await p.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify(`${text} @script ${JSON.stringify([...steps, { text: done }])}`)}; i.dispatchEvent(new Event("input")); document.getElementById("agent-send").click(); })()`);
    await until(async () => (await p.eval<string>(`document.getElementById("agent-log").textContent`)).split(done).length == 3, 30_000, done);
    const r = await p.eval<{ log: { items: Item[] } }>(`fetch("/api/admin/agent/conversation").then((r) => r.json())`);
    return r.log.items.filter((i) => i.kind == "tool");
  };
  let tools = await say("Deploy production.", [{ tool: "deploy_production" }, { tool: "list_test_runs", args: { limit: 3 } }, { tool: "get_test_run", args: { commit: red, shard: 1 } }], "Production stays.");
  let last = tools.slice(-3);
  expect(last[0].status == "error" && /failed: tests\/fake-fail\.ts/.test(last[0].detail ?? ""), "the agent's deploy_production: refused, with why", last[0]);
  expect(last[1].status == "done" && last[2].status == "done", "list_test_runs and get_test_run answer", last);
  expect(must(c, "ls-remote", "origin", "main").split("\t")[0] != red, "and main didn't move");
  ok("a red commit: main refuses it on every path (the dashboard, the API, the admin agent, a git push), and says why and where");

  // An earlier green commit may go out while staging's head is red.
  m = await merge("token", { commit: green });
  expect(m.status == 200 && m.body.commit == green, "main moves to the earlier green commit", m);
  ok("production may move to an earlier green staging commit");

  // ---- rerun ------------------------------------------------------------------------------------------
  let r = await api(`/api/gate/${red}/run`, { method: "POST", body: "{}" });
  run = ((await r.json()) as { run: Run }).run;
  expect(r.status == 200 && run.attempt == 2 && run.state == "running", "Run again: the API starts attempt 2", run);
  await until_(red, "failed", "and it fails again");
  tools = await say("Run its tests again.", [{ tool: "run_tests", args: { commit: red } }], "Started.");
  expect(tools.at(-1)?.status == "done", "the agent's run_tests starts a run", tools.at(-1));
  await until(async () => (await runOf(red)).run?.attempt == 3, 10_000, "attempt 3");
  await until_(red, "failed", "attempt 3 ends");
  ok("a run runs again: the API, and the admin agent's run_tests");

  // ---- running, then a newer push cancels it; flaky ------------------------------------------------------
  const slow = push("A slow change [gate-hang]");
  await until(async () => (await runOf(slow)).run?.state == "running", 10_000, "the slow commit's run is running");
  m = await merge("token");
  expect(m.status == 409 && m.body.error!.includes("still running"), "a running commit: main refuses it, saying it is running", m);
  // The page: the tests column says running, Merge is off with the reason.
  const gateUi = () => p.eval<{ cell: string; merge: boolean; why: string; override: boolean; green: string }>(`({
    cell: document.querySelector('#grid .row[data-sha="${slow}"] .gt')?.textContent ?? "",
    merge: !document.getElementById("merge").disabled, why: document.getElementById("gate-why").textContent,
    override: !document.getElementById("merge-override").hidden, green: document.getElementById("merge-green").hidden ? "" : document.getElementById("merge-green").textContent })`);
  await until(async () => (await gateUi()).cell.startsWith("running"), 15_000, "the page's tests column says running", gateUi);
  let ui = await gateUi();
  expect(!ui.merge && ui.why.includes("still running") && !ui.override, "Merge is off, the reason shows, no override while it runs", ui);
  await p.screenshot(join(SHOTS, "gate-running.png"));
  const flaky = push("A wobbly change [gate-flaky]");
  await until_(flaky, "passed", "the next push's run passes after its rerun");
  run = (await runOf(flaky)).run!;
  expect(run.flaky.join() == "tests/fake-fail.ts", "and records the flaky file", run);
  const cancelled = (await runOf(slow)).run!;
  expect(cancelled.state == "cancelled" && cancelled.supersededBy == flaky, "the slow commit's run was cancelled by the newer push", cancelled);
  ok("a running commit is refused; a newer push cancels its run; a flaky run passes and says so");

  // ---- the page: a red head, Merge to newest green, a run's shards ------------------------------------------------
  const red2 = push("Another broken change [gate-fail]");
  await until_(red2, "failed", "the head is red again");
  await until(async () => (await gateUi()).green.includes(flaky.slice(0, 7)), 15_000, "the page offers Merge to newest green", gateUi);
  ui = await gateUi();
  expect(!ui.merge && ui.why.includes("failed") && ui.override, "Merge is off with why; the override shows", ui);
  await p.eval(`document.querySelector('#grid .row[data-sha="${red2}"] .gt').click()`);
  await until(() => p.eval<boolean>(`document.getElementById("gate-dlg").open && document.querySelectorAll("#gate-shards tr").length >= 3`), 5_000, "a click opens the run: its shards");
  expect((await p.eval<string>(`document.getElementById("gate-verdict").textContent`)).includes("failed"), "and its verdict");
  await p.eval(`document.querySelector("#gate-shards button[data-shard]").click()`);
  await until(async () => (await p.eval<string>(`document.getElementById("gate-log").textContent`)).includes("==="), 5_000, "a shard's log opens");
  await p.screenshot(join(SHOTS, "gate-dialog.png"));
  await p.eval(`document.getElementById("gate-close").click()`);
  await p.eval(`document.getElementById("merge-green").click()`);
  await until(async () => must(c, "ls-remote", "origin", "main").split("\t")[0] == flaky, 10_000, "Merge to newest green moves main to it");
  ok("the Factory page: the tests column, Merge off with the reason, Merge to newest green, a run's shards and logs");

  // ---- the override ------------------------------------------------------------------------------------
  m = await merge("token", { override: "An emergency, honestly" });
  expect(m.status == 403 && m.body.error!.includes("browser"), "an override with a token (an agent's way in): 403", m);
  m = await merge("cookie", { override: "short" });
  expect(m.status == 400, "an override needs a reason", m);
  m = await merge("cookie", { override: "Hotfix: the outage, tests broken by infra" });
  expect(m.status == 200 && m.body.override === true && m.body.commit == red2, "an admin in a browser, with a reason, moves main past the gate", m);
  const changes = await (await fetch(`${root}/admin/changes`, { headers: { Cookie: cookie } })).text();
  expect(changes.includes("tests overridden") && changes.includes("Hotfix: the outage, tests broken by infra"), "the change log keeps the override and its reason");
  ok("the override: never a token; a reason; the change log keeps it");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser?.close();
  await host.stop();
}
process.exit(failed ? 1 : 0);
