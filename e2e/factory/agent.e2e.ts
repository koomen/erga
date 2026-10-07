// The factory's agent, with the scripted model (tests/factory.ts, 10).
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS, type Board } from "./factory";

test.beforeAll(async () => { await servers.factory(); });

const sayTo = (b: Board, text: string) => b.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); document.getElementById("agent-send").click(); return true; })()`);
const panel = (b: Board) => b.eval<string>(`document.getElementById("agent-log").innerText`);
/** What the agent said (its replies only, not the messages sent to it). */
const replies = (b: Board) => b.eval<string>(`[...document.querySelectorAll("#agent-log .msg-assistant")].map((e) => e.innerText).join(" | ")`);
async function agentBoard(tab: { page: Board["page"] }, root: string) {
  const b = await board(tab.page, root);
  await until(async () => (await b.eval<string>(`document.getElementById("agent-model").textContent`)).includes("script"), 10_000, "the agent panel connects");
  return b;
}

test("it reads the board, queues a task with a dependency as the admin's agent, and reads it; the panel shows each call; the card shows; the change log credits the admin, via the agent", { timeout: TASK_MS }, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const dep = await f.make("A dependency for the agent's task");
  const b = await agentBoard(tab, s.root);
  const next = await f.nextId();
  await sayTo(b, `Queue a footer note that merges after #${dep} @script ` + JSON.stringify([
    { tool: "list_tasks", args: {} },
    { tool: "create_task", args: { title: "Add a footer note", description: "Put a short note in the front page's footer.", mergeAfter: [dep] } },
    { tool: "get_task", args: { id: next } },
    { text: `Queued #${next}: it merges after #${dep}.` },
  ]));
  await expect.poll(() => replies(b), { timeout: 15_000 }).toContain(`Queued #${next}: it merges after #${dep}.`);
  const t = await f.task(next);
  expect(t.title).toBe("Add a footer note");
  expect(t.mergeAfter).toEqual([dep]);
  expect(t.by).toBe("tester, via their admin agent");
  expect(t.log[0].message.startsWith("Added by tester, via their admin agent")).toBe(true);
  const said = await panel(b);
  for (const call of ["Read the board", "Queued Add a footer note", `Read #${next}`]) expect(said).toContain(call);
  await expect.poll(async () => (await b.column("queued")) + (await b.column("working")) + (await b.column("ready-to-merge"))).toContain("Add a footer note");
  await tab.page.goto(`${s.root}/admin/changes`);
  await until(() => b.eval(`!!document.querySelector("li.change")`), 10_000, "the change log");
  const line = await b.eval<{ by: string; via: string | null; what: string } | undefined>(`[...document.querySelectorAll("li.change")].map((li) => ({ by: li.querySelector(".by").textContent, via: li.querySelector(".via")?.dataset.via ?? null, what: li.querySelector(".what").textContent.replace(/\\s+/g, " ").trim() })).find((l) => l.what.startsWith("task #${next} added: Add a footer note"))`);
  expect(line?.by).toBe("tester");
  expect(line?.via).toBe("their admin agent");
});
