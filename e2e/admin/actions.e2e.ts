// The agents do what their person does on the page, in the Worker, on the scripted model (agent-actions.ts has the
// rule; tests/admin-agent-actions.ts): the admin agent on /admin/factory, and the editor's agent on the documents.
import { expect, servers, test, until } from "../fixtures";
import { fresh, panel, stagingFromHere } from "./admin";

test.beforeAll(async () => { stagingFromHere(await servers.script()); });

const nextTask = async (root: string) => Math.max(0, ...((await (await fetch(`${root}/api/factory/tasks`)).json()) as { id: number }[]).map((t) => t.id)) + 1;
/** The factory off again, as the server started (the agent turns it on). */
const factoryOff = (root: string) => fetch(`${root}/admin/settings`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "factory", reset: "1" }) });

test("the admin agent turns the factory on, queues a task and discards it, under the admin's name, as the board's Discard does; the change log names the admin", async ({ tab }) => {
  const s = await servers.script();
  await fresh(s);
  const p = panel(tab.page, s);
  await p.open();
  try {
    const id = await nextTask(s.root);
    let tools = await p.say("Turn the factory on and queue a task.", [
      { tool: "set_setting", args: { key: "factory", value: "on" } },
      { tool: "create_task", args: { title: "Try the agent's buttons", description: "A task to discard." } },
    ], `Queued #${id}.`);
    expect(tools.map((t) => `${t.name} ${t.status}`)).toEqual(["set_setting done", "create_task done"]);
    tools = await p.say("Discard it.", [{ tool: "discard_task", args: { id } }], `Discarded #${id}.`);
    expect(tools.map((t) => `${t.name} ${t.status}`)).toEqual(["discard_task done"]);
    const task = await (await fetch(`${s.root}/api/factory/tasks/${id}`)).json() as { status: string; log: { message: string }[] };
    expect(task.status).toBe("discarded");
    expect(task.log.map((l) => l.message)).toContain("Discarded by tester, via their admin agent");
    const changes = await (await fetch(`${s.root}/admin/changes`)).text();
    expect(changes).toMatch(/factory/);
    expect(changes).toMatch(/tester/);
  } finally { await factoryOff(s.root); }
});

test("list_branches, deploy_production, list_deploys and list_agent_tokens answer in the Worker; merge_task on a discarded task says why it can't", async ({ tab }) => {
  const s = await servers.script();
  expect((await fetch(`${s.root}/admin/settings`, { method: "POST", headers: { Origin: s.root }, body: new URLSearchParams({ key: "factory", value: '"on"' }) })).ok).toBe(true);
  try {
    const made = await fetch(`${s.root}/api/factory/tasks`, { method: "POST", headers: { Origin: s.root, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Discarded before the agent looks", description: "A task to discard." }) });
    expect(made.status).toBe(201);
    const { id } = await made.json() as { id: number };
    expect((await fetch(`${s.root}/api/factory/tasks/${id}/discard`, { method: "POST", headers: { Origin: s.root } })).ok).toBe(true);
    await fresh(s);
    const p = panel(tab.page, s);
    await p.open();
    const tools = await p.say("Deploy production, then show me where things are.", [
      { tool: "list_branches" },
      { tool: "deploy_production" },
      { tool: "list_deploys", args: { history: 2 } },
      { tool: "list_agent_tokens" },
      { tool: "merge_task", args: { id } },
    ], "Production is at staging.");
    expect(tools.map((t) => `${t.name} ${t.status}`)).toEqual(["list_branches done", "deploy_production done", "list_deploys done", "list_agent_tokens done", "merge_task error"]);
    expect(tools[4].detail).toMatch(/discarded/);
  } finally { await factoryOff(s.root); }
});

test("the editor's agent lists, makes and deletes documents, as the documents list does; never the one it's in", async ({ tab }) => {
  const s = await servers.script();
  const page = tab.page;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${s.root}/new`);
  await until(() => page.evaluate(`location.hash == "#edit" && !!window.ergaPage && !!document.getElementById("agent-model")?.textContent`), 10_000, "the editor opens on a new document");
  const here = await page.evaluate("location.pathname") as string;
  const title = `Made by the agent ${crypto.randomUUID().slice(0, 6)}`;
  const slug = title.toLowerCase().replace(/ /g, "-");
  await page.evaluate(`document.body.classList.contains("agent-open") || document.getElementById("agent-fab").click()`);
  await until(() => page.evaluate(`document.body.classList.contains("agent-open")`), 5000, "the agent pane opens");
  const steps = [
    { tool: "list_documents" },
    { tool: "create_document", args: { title, template: "design-doc" } },
    { tool: "delete_document", args: { document: `/tester/${slug}` } },
    { tool: "delete_document", args: { document: here } },
    { text: "Made and deleted it." },
  ];
  await page.evaluate(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify(`Make a document and delete it @script ${JSON.stringify(steps)}`)}; i.dispatchEvent(new Event("input")); i.focus(); })()`);
  await page.keyboard.press("Enter");
  await until(() => page.evaluate(`[...document.querySelectorAll(".msg-assistant")].some((m) => m.textContent == "Made and deleted it.")`), 15_000, "the editor's agent answers");
  const rows = await page.evaluate(`[...document.querySelectorAll(".msg-tool")].map((m) => m.className + " " + m.textContent)`) as string[];
  expect(rows).toHaveLength(4);
  expect(rows.slice(0, 3).filter((r) => /error/.test(r))).toEqual([]);
  expect(rows[3]).toMatch(/error/);
  expect(await (await fetch(`${s.root}/docs`)).text()).not.toContain(title);
});
