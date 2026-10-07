#!/usr/bin/env bun
// The agents do what their person does on the page, in the real Worker, on the scripted test model, in a real
// browser (agent-actions.ts has the rule):
//
//   - the admin agent on /admin/factory turns the factory on, queues a task and discards it, reads staging and
//     main, deploys production (main to staging), and reads the deploys, the admin keys, its admin's agent
//     tokens (Share with agent's among them). The task's log and the change log name the admin, as when they click;
//   - the editor's agent lists its person's documents, makes one, and deletes it, as the documents list does.
//
//   bun tests/admin-agent-actions.ts            the checks
//   bun tests/admin-agent-actions.ts --shots    and screenshots, in tests/cdp.ts's SHOTS
// covers: agent-actions.ts factory/agent.ts server-tools.ts agent.ts worker/factory.ts src/page/factory-agent.ts src/page/agent-chat.ts

import { mkdirSync } from "fs";
import { join } from "path";
import { ensureBare } from "../dev/git-server";
import { Browser, type Page, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const host = await startHost(null, { env: { ERGA_AGENT_MODEL: "script" } });
const browser = await Browser.launch();
const ok = (what: string) => console.log(`ok   ${what}`);
const shots = process.argv.includes("--shots");
const shot = async (p: Page, name: string) => {
  if (!shots) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = join(SHOTS, `admin-agent-actions-${name}.png`);
  await p.screenshot(file);
  console.log(`shot ${file}`);
};

type Item = { kind: string; name?: string; status?: string; path?: string; detail?: string };

let failed = false;
try {
  // This clone's HEAD as staging and main (dev/git-server.ts's pretend Artifacts).
  const bare = join(host.state, "artifacts", "erga", "erga.git");
  ensureBare(bare);
  const push = Bun.spawnSync(["git", "push", "-q", bare, "HEAD:refs/heads/staging", "HEAD:refs/heads/main"], { cwd: join(import.meta.dir, "..") });
  expect(push.exitCode == 0, "pushed this clone as staging and main", push.stderr.toString());

  // ---- the admin agent
  const p = await browser.page(await browser.context());
  await p.open(`${host.root}/admin/factory`, { width: 1440, height: 900 });
  await until(() => p.eval<boolean>(`document.getElementById("agent-send").title == "Type a message to send it."`), 20_000, "the admin agent is on");
  await Bun.sleep(500);
  const say = async (text: string, steps: unknown[], done: string) => {
    await p.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify(`${text} @script ${JSON.stringify([...steps, { text: done }])}`)}; i.dispatchEvent(new Event("input")); document.getElementById("agent-send").click(); })()`);
    await until(async () => (await p.eval<string>(`document.getElementById("agent-log").textContent`)).split(done).length == 3, 30_000, done);
    const r = await p.eval<{ log: { items: Item[] } }>(`fetch("/api/admin/agent/conversation").then((r) => r.json())`);
    return r.log.items.filter((i) => i.kind == "tool");
  };
  let tools = await say("Turn the factory on and queue a task.", [
    { tool: "set_setting", args: { key: "factory", value: "on" } },
    { tool: "create_task", args: { title: "Try the agent's buttons", description: "A task to discard." } },
  ], "Queued #1.");
  expect(tools.map((t) => `${t.name} ${t.status}`).join() == "set_setting done,create_task done", "the factory is on, a task queued", tools);
  tools = await say("Discard it.", [{ tool: "discard_task", args: { id: 1 } }], "Discarded #1.");
  expect(tools.at(-1)?.status == "done", "discard_task answered", tools.at(-1));
  const task = await p.eval<{ status: string; log: { message: string }[] }>(`fetch("/api/factory/tasks/1").then((r) => r.json())`);
  expect(task.status == "discarded" && task.log.some((l) => l.message == "Discarded by tester, via their admin agent"), "the task is discarded, and its log names the admin, via their agent", task);
  ok("discard_task discards a task, under the admin's name, as the board's Discard does");

  tools = await say("Deploy production, then show me where things are.", [
    { tool: "list_branches" },
    { tool: "deploy_production" },
    { tool: "list_deploys", args: { history: 2 } },
    { tool: "list_agent_tokens" },
    { tool: "merge_task", args: { id: 1 } },
  ], "Production is at staging.");
  const last = tools.slice(-5);
  expect(last.map((t) => `${t.name} ${t.status}`).join() == "list_branches done,deploy_production done,list_deploys done,list_agent_tokens done,merge_task error", "each dashboard tool answered", last);
  expect(/discarded/.test(last[4].detail ?? ""), "a discarded task can't merge: the error says why", last[4]);
  ok("list_branches, deploy_production, list_deploys and list_agent_tokens answer in the Worker");
  const changes = await p.eval<string>(`fetch("/admin/changes").then((r) => r.text())`);
  expect(/factory/.test(changes) && /tester/.test(changes), "the change log names the admin for the setting");
  await shot(p, "admin");

  // ---- the editor's agent
  const e = await browser.page(await browser.context());
  await e.open(`${host.root}/new`, { width: 1440, height: 900 });
  await until(() => e.eval<boolean>(`location.hash == "#edit" || !!document.getElementById("agent-input")`), 20_000, "the editor opens on a new document");
  const here = await e.eval<string>(`location.pathname`);
  await e.openAgent();
  const steps = [
    { tool: "list_documents" },
    { tool: "create_document", args: { title: "Made by the agent", template: "design-doc" } },
    { tool: "delete_document", args: { document: "/tester/made-by-the-agent" } },
    { tool: "delete_document", args: { document: here } },
    { text: "Made and deleted it." },
  ];
  await e.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify(`Make a document and delete it @script ${JSON.stringify(steps)}`)}; i.dispatchEvent(new Event("input")); })()`);
  await e.key("Enter");
  await until(() => e.eval<boolean>(`[...document.querySelectorAll(".msg-assistant")].some((m) => m.textContent == "Made and deleted it.")`), 30_000, "the editor's agent answers");
  const rows = await e.eval<string[]>(`[...document.querySelectorAll(".msg-tool")].map((m) => m.className + " " + m.textContent)`);
  expect(rows.length == 4 && !rows.slice(0, 3).some((r) => /error/.test(r)) && /error/.test(rows[3]), "list, make, delete answered; deleting the document it's in is refused", rows);
  const docs = await e.eval<string>(`fetch("/docs").then((r) => r.text())`);
  expect(!docs.includes("Made by the agent"), "the document it made is gone from the list");
  ok("the editor's agent lists, makes and deletes documents, as the documents list does; never the one it's in");
  await shot(e, "editor");
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  browser.close();
  await host.dispose();
}
process.exit(failed ? 1 : 0);
