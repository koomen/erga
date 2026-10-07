// The admin agent's conversation, kept on the server (worker/factory.ts, factory/chat-store.ts;
// GET|DELETE /api/admin/agent/conversation), on the scripted model (tests/admin-agent-chat.ts). A restart is in
// chat-restart.e2e.ts, the panel's layout in chat-prefs.e2e.ts.
import { expect, servers, test } from "../fixtures";
import { fresh, panel } from "./admin";

await servers.script();

test("a conversation on /admin/factory is there on /admin (Settings), and from GET /api/admin/agent/conversation", async ({ tab }) => {
  const s = await servers.script();
  await fresh(s);
  const p = panel(tab.page, s);
  await p.open();
  await p.say("", [], "Kept: the first reply.");
  await p.open("/admin");
  await expect.poll(() => p.times("Kept: the first reply.")).toBe(2);
  expect((await p.conversation()).items.map((i) => i.kind)).toEqual(["user", "assistant"]);
});

test("New conversation empties it, here and after a reload", async ({ tab }) => {
  const s = await servers.script();
  await fresh(s);
  const p = panel(tab.page, s);
  await p.open();
  await p.say("", [], "Kept until a new conversation.");
  await p.eval(`document.getElementById("agent-reset").click()`);
  await expect.poll(() => p.chat()).not.toContain("Kept until");
  await p.open("/admin");
  expect((await p.conversation()).items).toEqual([]);
  expect(await p.chat()).not.toContain("Kept until");
});
