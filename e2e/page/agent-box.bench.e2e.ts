// The agent box's height easing, frame by frame ("Agent, empty message"): timing, so a bench.
import { expect, servers, test } from "../fixtures";
import { openEditor } from "../editor";

await servers.agent();

test("the agent box grows with its text, easing through the heights between", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.agent(), "page");
  await ed.openAgent();
  const grow = await ed.eval<number[]>(`new Promise((res) => { const f = document.getElementById("agent-field"), t = document.getElementById("agent-input"); const out = [f.getBoundingClientRect().height]; t.value += "\\ntwo\\nthree"; t.dispatchEvent(new Event("input")); let n = 0; const tick = () => { out.push(f.getBoundingClientRect().height); if (++n < 20) requestAnimationFrame(tick); else res(out); }; requestAnimationFrame(tick); })`);
  const [h0, hEnd] = [grow[0], grow[grow.length - 1]];
  expect(hEnd).toBeGreaterThan(h0 + 30);
  expect(grow.some((h) => h > h0 + 2 && h < hEnd - 2)).toBe(true);
});
