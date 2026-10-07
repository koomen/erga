// The factory's agent, with the scripted model.
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS, type Board } from "./factory";

await servers.factory();

const sayTo = (b: Board, text: string) => b.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); document.getElementById("agent-send").click(); return true; })()`);
const panel = (b: Board) => b.eval<string>(`document.getElementById("agent-log").innerText`);
/** What the agent said (its replies only, not the messages sent to it). */
const replies = (b: Board) => b.eval<string>(`[...document.querySelectorAll("#agent-log .msg-assistant")].map((e) => e.innerText).join(" | ")`);
async function agentBoard(tab: { page: Board["page"] }, root: string) {
  const b = await board(tab.page, root);
  await until(async () => (await b.eval<string>(`document.getElementById("agent-model").textContent`)).includes("script"), 10_000, "the agent panel connects");
  return b;
}

test("a screenshot pasted into its box goes to the agent as an image, and the conversation shows it", async ({ tab }) => {
  const s = await servers.factory();
  const b = await agentBoard(tab, s.root);
  await b.eval(`(async () => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 200; const g = c.getContext("2d"); g.fillStyle = "#3a6ff0"; g.fillRect(0, 0, 320, 200);
    const dt = new DataTransfer(); dt.items.add(new File([await new Promise((r) => c.toBlob(r, "image/png"))], "image.png", { type: "image/png" }));
    document.getElementById("agent-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await until(() => b.eval(`!!document.querySelector(".agent-attachments .file-chip.image img")`), 5000, "a pasted screenshot waits above the box");
  const before = (await b.eval<number>(`document.querySelectorAll("#agent-log .msg-user .msg-files .file-chip.image img").length`));
  await sayTo(b, `What's this? @script [{"inputs": true}]`);
  await expect.poll(() => replies(b), { timeout: 15_000 }).toContain(`{"images":["image/png"],"files":[]}`);
  expect(await b.eval<number>(`document.querySelectorAll("#agent-log .msg-user .msg-files .file-chip.image img").length`)).toBe(before + 1);
});
