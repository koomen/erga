// The admin agent's conversation and panel, kept on the server (worker/factory.ts, factory/chat-store.ts;
// GET|DELETE /api/admin/agent/conversation, GET|PUT /api/admin/agent/prefs), on the scripted model
// (tests/admin-agent-chat.ts). The tests that restart the server, or change how the panel is laid out for the admin,
// have a server of their own.
import { expect, servers, test, until } from "../fixtures";
import { fresh, panel } from "./admin";

// A test with a server of its own starts it (a few seconds; more on a loaded machine), and may restart it.
const OWN_SERVER = { timeout: 60_000 };

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

test("the panel's open or closed state, its side and its width follow the admin to a fresh browser, with the conversation", OWN_SERVER, async ({ tab }) => {
  const s = await tab.own({ env: { ERGA_AGENT_MODEL: "script" } });
  const p = panel(tab.page, s);
  await p.open();
  await p.say("", [], "Here in the fresh browser too.");
  const put = await fetch(`${s.root}/api/admin/agent/prefs`, { method: "PUT", headers: { Origin: s.root, "Content-Type": "application/json" }, body: JSON.stringify({ side: "right", width: 520 }) });
  expect(put.ok).toBe(true);
  await p.eval(`document.getElementById("agent-close").click()`);
  const prefs = async () => (await (await fetch(`${s.root}/api/admin/agent/prefs`)).json()) as { side?: string; width?: number; open?: boolean };
  await expect.poll(prefs).toEqual(expect.objectContaining({ side: "right", width: 520, open: false }));
  // A fresh browser: no cookies, no localStorage (the dev server signs it in as the same admin).
  const context = await tab.page.context().browser()!.newContext();
  try {
    const q = panel(await context.newPage(), s);
    await q.page.setViewportSize({ width: 1440, height: 900 });
    await q.page.goto(`${s.root}/admin`);
    await until(() => q.eval<boolean>(`document.documentElement.classList.contains("agent-closed") && document.getElementById("workspace").classList.contains("agent-right")`), 10_000, "closed, on the right, in a fresh browser");
    await q.eval(`document.getElementById("agent-fab").click()`);
    await expect.poll(() => q.eval<number>(`Math.round(document.getElementById("agent").getBoundingClientRect().width)`)).toBe(520);
    await expect.poll(async () => (await prefs()).open).toBe(true);
    await expect.poll(() => q.times("Here in the fresh browser too.")).toBe(2);
  } finally { await context.close(); }
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
