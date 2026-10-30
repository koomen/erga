// view_page and evaluate_page at a presentation's step and a time, as an agent calls them (POST /api/tools/<name>,
// with the document): "3.2" shows that part, frames catch a transition partway, and the render waits for the page's
// scripts, so window.ergaSteps is there every time. The person's own view doesn't move.
import { expect, servers, test } from "../../helpers/fixtures";
import { deck, differ } from "./view-page";

await servers.main();

test('view_page and evaluate_page at step "3.2" show that part; the person\'s view stays on the first slide', { timeout: 30_000 }, async ({
  tab,
}) => {
  const { ed, tool, fails } = await deck(tab);
  const text = `document.querySelector(".slide.current").innerText.replace(/\\s+/g, " ").trim()`;
  const at = await tool("evaluate_page", { expression: text, step: "3.2" });
  expect(at.text).toMatch(/^"Third slide Red\. Green\."/);
  expect(at.text).toContain("at step 3.2 (index 5 of 7: Third slide)");
  expect((await tool("evaluate_page", { expression: text, step: 3 })).text).toMatch(/^"Second slide No parts here\."/);
  expect((await tool("evaluate_page", { expression: text, step: "#1.2" })).text).toMatch(/^"First slide One\. Two\."/);
  const two = await tool("view_page", { step: "3.2" });
  expect(two.images).toHaveLength(1);
  expect(two.text).toContain("at step 3.2 (index 5 of 7: Third slide)");
  // Rule 14's replaceState("#3.2") runs in the render with no error (the deck calls it at each step).
  expect(two.text).toContain("No script errors.");
  const three = await tool("view_page", { step: "3.3" });
  expect(await differ(ed, two.images[0], three.images[0]), "3.3 shows Blue, 3.2 doesn't").toBeGreaterThan(50);
  expect(await fails("view_page", { step: "3.4" })).toMatch(/Slide 3 has 3 parts, so there's no "3\.4"/);
  // The person's own view: still the first slide, the address unchanged.
  expect(await ed.frame<string>(`document.querySelector(".slide.current h1").textContent`)).toBe("First slide");
  expect(await ed.eval<string>(`location.hash`)).not.toContain("3");
});

test("frames [100, 600] catch the bar partway through its transition; evaluate_page's frames read its width at each time", {
  timeout: 30_000,
}, async ({ tab }) => {
  const { ed, tool, fails } = await deck(tab);
  const v = await tool("view_page", { step: "3.2", frames: [100, 600] });
  expect(v.images).toHaveLength(2);
  expect(v.text).toMatch(/At \d+ ms:[\s\S]*At \d+ ms:/);
  expect(await differ(ed, v.images[0], v.images[1]), "the bar grew between 100 and 600 ms").toBeGreaterThan(100);
  // From 1/7 of the width to 6/7 in 1.5 s, linear: at 300 ms it is a fifth of the way, at 900 ms three fifths.
  const e = await tool("evaluate_page", {
    expression: `document.getElementById("progress").getBoundingClientRect().width / innerWidth`,
    step: "3.2",
    frames: [300, 900, 2000],
  });
  const runs = JSON.parse(e.text.split("\n\n")[0]) as { at_ms: number; value: number }[];
  [300, 900, 2000].forEach((t, i) =>
    expect(runs[i].at_ms >= t - 5 && runs[i].at_ms < t + 150, `run ${i} at ${runs[i].at_ms} ms`).toBe(true)
  );
  const want = (t: number) => 1 / 7 + (5 / 7) * Math.min(1, t / 1500);
  for (const r of runs)
    expect(Math.abs(r.value - want(r.at_ms)), `width at ${r.at_ms} ms: ${r.value}, not ${want(r.at_ms)}`).toBeLessThan(0.06);
  expect(await fails("view_page", { step: "3.2", frames: [100], at_ms: 100 })).toMatch(/at_ms or frames, not both/);
});

test("evaluate_page sees the deck's window.ergaSteps every time, 10 times in a row", { timeout: 60_000 }, async ({ tab }) => {
  const { tool } = await deck(tab);
  const seen: string[] = [];
  for (let i = 0; i < 10; i++)
    seen.push(
      (await tool("evaluate_page", { expression: `typeof window.ergaSteps?.go + " " + window.ergaSteps?.count()` })).text.split("\n")[0]
    );
  expect(seen).toEqual(Array(10).fill('"function 7"'));
});
