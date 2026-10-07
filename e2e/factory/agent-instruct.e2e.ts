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

// A task done, then done again after the agent's instructions.
test("it looks at a task's screenshot, sends it instructions and drops its dependency, and merges nothing it isn't asked to; a reload keeps the conversation", { timeout: 2 * TASK_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const dep = await f.make("Another dependency");
  const id = await f.make("A note for the agent to see", "A note.", { mergeAfter: [dep] });
  await f.until(id, "complete");
  const b = await agentBoard(tab, s.root);
  await sayTo(b, "Look at it, ask for a shorter note, and drop the dependency @script " + JSON.stringify([
    { tool: "view_screenshot", args: { id } },
    { tool: "instruct_task", args: { id, instructions: "Make the note shorter." } },
    { tool: "set_dependencies", args: { id, mergeAfter: null } },
    { text: `Asked #${id} for a shorter note.` },
  ]));
  await expect.poll(() => replies(b), { timeout: 15_000 }).toContain(`Asked #${id} for a shorter note.`);
  const t = await f.task(id);
  expect(t.log.some((l) => l.message.startsWith("tester’s agent asked: Make the note shorter."))).toBe(true);
  expect(t.mergeAfter).toEqual([]);
  expect(await b.eval<boolean>(`!!document.querySelector("#agent-log .msg-tool.done img.shot")`)).toBe(true);
  await f.until(id, "complete", TASK_MS, (x) => x.commit != t.commit);
  // It merges only when asked (merge_task and discard_task: tests/admin-agent-actions.ts); here it only reads.
  await sayTo(b, "Is it ready? @script " + JSON.stringify([{ tool: "get_task", args: { id } }, { text: `#${id} is ready for you to merge.` }]));
  await expect.poll(() => replies(b), { timeout: 15_000 }).toContain(`#${id} is ready for you to merge.`);
  expect(await f.status(id)).toBe("complete");
  await tab.page.reload();
  await expect.poll(() => replies(b), { timeout: 10_000 }).toContain(`#${id} is ready for you to merge.`);
});
