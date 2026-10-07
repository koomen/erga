// The admin agent's panel, as the admin left it, follows them to a fresh browser (GET|PUT /api/admin/agent/prefs,
// src/page/factory-agent.ts, src/page/layout.ts). On a server of its own: the layout is
// the admin's, and would follow them into the other tests on a shared one.
import { expect, test, until } from "../fixtures";
import { panel } from "./admin";

// A server of its own (a few seconds to start; more on a loaded machine).
const OWN_SERVER = { timeout: 60_000 };

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
