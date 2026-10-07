// With no agent key, Send never refuses silently: it says why (tests/page.ts, "Agent off").
import { expect, servers, test } from "../fixtures";
import { openEditor } from "../editor";

test.beforeAll(async () => { await servers.main(); });

test("with no key, the panel says the agent is off and why, Send carries the same reason, and sending still explains", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.openAgent();
  const state = () => ed.eval<{ hint: string; hidden: boolean; disabled: string | null; title: string }>(`(() => { const h = document.getElementById("agent-hint"), b = document.getElementById("agent-send"); return { hint: h.textContent, hidden: h.hidden, disabled: b.getAttribute("aria-disabled"), title: b.title }; })()`);
  await expect.poll(async () => (await state()).hidden).toBe(false);
  let st = await state();
  expect(st.hint).toMatch(/agent is off/);
  expect(st.hint).toMatch(/ANTHROPIC_API_KEY/);
  expect(st.disabled).toBe("true");
  expect(st.title).toBe(st.hint);
  await ed.type("hello");
  await ed.press("Enter");
  await ed.settle();
  st = await state();
  expect(st.hidden).toBe(false);
  expect(st.hint).toMatch(/ANTHROPIC_API_KEY/);
  expect(await ed.eval<string>(`document.getElementById("agent-input").value`)).toBe("hello");
});
