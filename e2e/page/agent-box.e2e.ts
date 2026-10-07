// The agent's message box (tests/page.ts, "Agent, empty message").
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test } from "../fixtures";
import { F, openEditor } from "../editor";

test.beforeAll(async () => { await servers.agent(); });

test("an empty message: Send says to type one, pressing it says so in the panel, and typing enables it and clears the hint", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.agent(), "page");
  await ed.openAgent();
  await expect.poll(() => ed.eval<string>(`document.getElementById("agent-send").title`)).toMatch(/Type a message/);
  expect(await ed.eval<string>(`document.getElementById("agent-send").getAttribute("aria-disabled")`)).toBe("true");
  await ed.press("Enter");
  await expect.poll(() => ed.eval<boolean>(`(() => { const h = document.getElementById("agent-hint"); return !h.hidden && /Type a message/.test(h.textContent); })()`)).toBe(true);
  await ed.type("x");
  await expect.poll(() => ed.eval<boolean>(`document.getElementById("agent-send").getAttribute("aria-disabled") == "false" && document.getElementById("agent-hint").hidden`)).toBe(true);
});

test("a re-render of the page (its stylesheet changed) leaves focus in the agent's input", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.agent(), "page");
  await ed.openAgent();
  await ed.eval(`document.getElementById("agent-input").focus()`);
  writeFileSync(join(ed.dir, "style.css"), readFileSync(join(ed.dir, "style.css"), "utf8") + "\nh1 { color: rgb(1, 2, 3); }\n");
  await expect.poll(() => ed.frame<string>(`getComputedStyle(${F}.querySelector("h1")).color`)).toBe("rgb(1, 2, 3)");
  await ed.settle();
  expect(await ed.eval<string>(`document.activeElement.id`)).toBe("agent-input");
});

test("the box grows with its text, and its height eases rather than snapping", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.agent(), "page");
  await ed.openAgent();
  const h0 = await ed.eval<number>(`document.getElementById("agent-field").getBoundingClientRect().height`);
  // Eases: a transition on its height (the frames in between are measured by the bench, agent-box.bench.e2e.ts).
  expect(await ed.eval<boolean>(`(() => { const s = getComputedStyle(document.getElementById("agent-field")); const props = s.transitionProperty.split(", "), times = s.transitionDuration.split(", "); return props.some((p, i) => (p == "height" || p == "all") && parseFloat(times[i % times.length]) > 0); })()`)).toBe(true);
  await ed.eval(`(() => { const t = document.getElementById("agent-input"); t.value += "\\ntwo\\nthree"; t.dispatchEvent(new Event("input")); })()`);
  await expect.poll(() => ed.eval<number>(`document.getElementById("agent-field").getBoundingClientRect().height`)).toBeGreaterThan(h0 + 30);
});
