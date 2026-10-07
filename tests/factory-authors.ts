#!/usr/bin/env bun
// The factory (experimental): who its commits are by (#68, factory/author.ts),
// end to end, against a dev server of its own, with simulated VMs and the
// scripted stand-in (factory/vm/fake-claude.ts), as tests/factory.ts does.
//
//   bun tests/factory-authors.ts
//
// Three admins each add a task: tester on the board's API (their session),
// Ada through the factory's agent, and Grace with a factory token (an outside
// agent). Each task records its person, and the stand-in's commits on its
// branch are authored by that person (their GitHub name and noreply address)
// and committed by Erga factory. Then tester merges Grace's task, and Ada
// merges tester's: the "Merge staging into task/…" commit is by tester (the
// task's person), and the merge into staging by Ada (who pressed Merge), both
// committed by Erga factory.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const host = await startHost(null, { env: { ERGA_AGENT_MODEL: "script" }, processEnv: { ERGA_FACTORY_RUNNER: "sim", ERGA_LINK_SECRET: `factory-test-${crypto.randomUUID()}`, ERGA_FACTORY_SIM_NO_SCRIPTS: "1" } });
const root = host.root;
const ADA = "Ada Lovelace", GRACE = "Grace Hopper";
/** A request as `who` (a dev session: ?user=Name; tester when not given), or with a token. */
const api = async (path: string, init: { method?: string; json?: unknown; who?: string; token?: string } = {}) => {
  const url = new URL(`${root}/api/factory${path}`);
  if (init.who) url.searchParams.set("user", init.who);
  const headers: Record<string, string> = init.token ? { Authorization: `Bearer ${init.token}` } : { Origin: root };
  if (init.json) headers["Content-Type"] = "application/json";
  const r = await fetch(url, { method: init.method ?? (init.json ? "POST" : "GET"), headers, body: init.json ? JSON.stringify(init.json) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const task = async (id: number) => (await api(`/tasks/${id}`)).body;
const repo = join(host.state, "factory", "erga.git");
const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout.trim();
/** Each commit in `range`: author, committer and subject. */
const commits = (range: string) => git("log", "--format=%an <%ae>|%cn <%ce>|%s", ...range.split(" ")).split("\n").filter(Boolean).map((l) => { const [author, committer, subject] = l.split("|"); return { author, committer, subject }; });
const FACTORY = "Erga factory <factory@erga.dev>";
const STEP = 60_000;

try {
  const setting = await fetch(`${root}/admin/settings`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "factory", value: JSON.stringify("on") }) });
  expect(setting.ok, "the factory turns on");
  for (const login of ["ada-lovelace", "grace-hopper"]) {
    const r = await fetch(`${root}/admin/users`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ do: "add", login, role: "admin" }) });
    expect(r.ok, `${login} is made an admin`, await r.text());
  }

  // 1. tester, in person (their session).
  const t1 = (await api("/tasks", { json: { title: "Tester's own task", description: "A note on the front page." } })).body;
  expect(t1.by == "tester" && t1.person == "tester", "a task added in a session: its person is the session's", t1);

  // 2. Ada, through the factory's agent (the scripted model).
  const said = await api("/agent", { who: ADA, json: { text: "Queue it @script " + JSON.stringify([{ tool: "create_task", args: { title: "Ada's agent's task", description: "Another note." } }, { text: "Queued." }]) } });
  expect(said.status == 200, "Ada's agent takes the message", said);
  await until(async () => (await api("/tasks")).body.some((t: any) => t.title == "Ada's agent's task"), 20_000, "the agent queues the task");
  const t2 = (await api("/tasks")).body.find((t: any) => t.title == "Ada's agent's task");
  expect(t2.by == "ada-lovelace, via their admin agent" && t2.person == "ada-lovelace", "a task the admin agent added: its person is the admin who prompted it", t2);

  // 3. Grace, with a factory token (an outside agent).
  const minted = await api("/tokens", { who: GRACE, json: { label: "Grace's agent", hours: 1 } });
  expect(minted.status == 200 || minted.status == 201, "Grace makes a factory token", minted);
  const t3 = (await api("/tasks", { token: minted.body.token, json: { title: "Grace's agent's task", description: "A third note." } })).body;
  expect(t3.by == "grace-hopper, via a shared agent (Grace's agent)" && t3.person == "grace-hopper", "a task added with a token: its person is the token's", t3);

  for (const t of [t1, t2, t3]) await until(async () => (await task(t.id)).status == "complete", STEP, `#${t.id} is ready to merge`, async () => (await task(t.id)).log.slice(-4));
  const people: [any, string][] = [[t1, "tester <tester@users.noreply.github.com>"], [t2, `${ADA} <ada-lovelace@users.noreply.github.com>`], [t3, `${GRACE} <grace-hopper@users.noreply.github.com>`]];
  for (const [t, author] of people) {
    const done = await task(t.id);
    const own = commits(`staging..${done.branch}`);
    expect(own.length > 0 && own.every((c) => c.author == author && c.committer == FACTORY), `#${t.id}'s commits are by ${author}, committed by the factory`, own);
  }
  ok("each task's commits are by its person (session, admin agent, token), committed by Erga factory");

  // Grace's task merged by tester: staging moves, so tester's task (merged next, by Ada) needs "Merge staging into ...".
  expect((await api(`/tasks/${t3.id}/merge`, { method: "POST" })).status == 202, "tester merges Grace's task");
  await until(async () => (await task(t3.id)).status == "merged", STEP, "Grace's task is merged", async () => (await task(t3.id)).log.slice(-4));
  const m3 = commits("-1 staging")[0];
  expect(m3.author == "tester <tester@users.noreply.github.com>" && m3.committer == FACTORY && m3.subject.startsWith(`Merge ${t3.branch}:`), "the merge into staging is by whoever pressed Merge", m3);
  const merged = await api(`/tasks/${t1.id}/merge`, { method: "POST", who: ADA });
  expect(merged.status == 202, "Ada merges tester's task", merged);
  await until(async () => (await task(t1.id)).status == "merged", STEP, "tester's task is merged", async () => (await task(t1.id)).log.slice(-4));
  const [m1] = commits("-1 staging");
  expect(m1.author == `${ADA} <ada-lovelace@users.noreply.github.com>` && m1.committer == FACTORY && m1.subject.startsWith(`Merge ${t1.branch}:`), "the merge into staging is by Ada, who pressed Merge", m1);
  const [up] = commits("-1 staging^2");
  expect(up.subject == `Merge staging into ${t1.branch}` && up.author == "tester <tester@users.noreply.github.com>" && up.committer == FACTORY, "Merge staging into the branch is by the task's person", up);
  ok("merges: staging into the branch by the task's person, the branch into staging by who pressed Merge, both committed by the factory");

  // The detail view says who added the task, and who its commits are by.
  const browser = await Browser.launch();
  try {
    const p = await browser.page(await browser.context());
    await p.open(`${root}/admin/factory`, { width: 1200, height: 800, scale: 2 });
    await until(() => p.eval(`!!document.querySelector('[data-open="${t2.id}"]')`), 15_000, "the board shows the tasks");
    await p.eval(`document.querySelector('[data-open="${t2.id}"]').click()`);
    await until(() => p.eval(`document.getElementById("dlg").open`), 5000, "the detail opens");
    const person = await p.eval<string>(`document.querySelector("#dlg .person")?.innerText ?? ""`);
    expect(person == "Added by ada-lovelace, via their admin agent · commits by ada-lovelace", "the detail names the task's person", person);
    await p.screenshot(join(SHOTS, "factory-authors.png"));
  } finally { browser.close(); }
  ok("the board's detail view names the task's person");
  console.log("all factory author checks pass");
} catch (e) {
  const vms = join(host.state, "factory", "vms");
  if (existsSync(vms)) for (const n of readdirSync(vms)) {
    const f = join(vms, n, "vm.log");
    if (existsSync(f)) console.error(`--- ${n}/vm.log (tail)\n${readFileSync(f, "utf8").slice(-1500)}`);
  }
  console.error(`--- the dev server (tail)\n${host.output().slice(-3000)}`);
  throw e;
} finally {
  spawnSync("pkill", ["-f", join(host.state, "factory", "vms")], { stdio: "ignore" });
  await host.dispose();
}
