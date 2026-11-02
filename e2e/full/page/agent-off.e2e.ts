// With no agent key, Send never refuses silently: it says why ("Agent off"). The panel says how to turn it on, with
// links (agent-key-in-panel.e2e.ts); Send's title has the server's reason.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

test("with no key, the panel says the agent is off and why, Send carries the same reason, and sending still explains", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.openAgent();
  const state = () =>
    ed.eval<{ hint: string; hidden: boolean; disabled: string | null; title: string }>(
      `(() => { const h = document.getElementById("agent-hint"), b = document.getElementById("agent-send"); return { hint: h.innerText, hidden: h.hidden, disabled: b.getAttribute("aria-disabled"), title: b.title }; })()`
    );
  await expect.poll(async () => (await state()).hidden).toBe(false);
  let st = await state();
  expect(st.hint).toBe("To enable the agent, add an LLM provider key. Or connect your own agent.");
  expect(st.disabled).toBe("true");
  expect(st.title).toMatch(/agent is off.*ANTHROPIC_API_KEY/);
  await ed.type("hello");
  await ed.press("Enter");
  await ed.settle();
  st = await state();
  expect(st.hidden).toBe(false);
  expect(st.hint).toBe("To enable the agent, add an LLM provider key. Or connect your own agent.");
  expect(await ed.eval<string>(`document.getElementById("agent-input").value`)).toBe("hello");
});
