// The admin agent's conversation survives the server restarting, even mid-reply (worker/factory.ts,
// factory/chat-store.ts; tests/admin-agent-chat.ts). Each test restarts a server of its own.
import { expect, test, until } from "../fixtures";
import { panel } from "./admin";

// A server of its own, started and restarted (a few seconds each; more on a loaded machine).
const OWN_SERVER = { timeout: 60_000 };

test("the conversation is there after the server restarts (a deploy, say): it is in the Factory object's storage", OWN_SERVER, async ({ tab }) => {
  const s = await tab.own({ env: { ERGA_AGENT_MODEL: "script" } });
  const p = panel(tab.page, s);
  await p.open();
  await p.say("", [], "Kept: the first reply.");
  await s.restart();
  await p.open("/admin/users");
  await expect.poll(() => p.times("Kept: the first reply.")).toBe(2);
});

test("a reply cut off when the server stops keeps what arrived, invents nothing, and the next message works", OWN_SERVER, async ({ tab }) => {
  const s = await tab.own({ env: { ERGA_AGENT_MODEL: "script" } });
  const p = panel(tab.page, s);
  await p.open();
  await p.send(`@script [{"tool":"factory_status"},{"delay":20000,"text":"never arrives"}]`);
  await expect.poll(() => p.chat()).toContain("Checked the factory");
  // The tool's result is stored, the reply still to come.
  await until(async () => { const l = await p.conversation(); return l.busy && l.items.some((i) => i.kind == "tool" && i.name == "factory_status" && i.status == "done"); }, 5000, "the tool call stored, the turn still going");
  await s.restart();
  await p.open("/admin/factory");
  await expect.poll(() => p.chat()).toContain("factory_status");
  await p.say("", [], "Still working after the crash.");
  const chat = await p.chat();
  expect(chat.split("never arrives").length - 1, chat).toBe(1);
  expect(chat.split("Checked the factory").length - 1, chat).toBe(1);
  expect(chat.split("The server restarted before the agent finished").length - 1, chat).toBe(1);
});
