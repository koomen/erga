// view_page and evaluate_page from a tab in the background, as Pete's was: Chrome runs a hidden tab's timers late (a
// chain of them once a minute, after five minutes) and draws no frames, so the render, which waited 50 ms at a time,
// ran out of time ("The page didn't send a picture back in time."), and a deck whose camera glides to a step by
// requestAnimationFrame never got there. The tests' browser can't hide a tab, so the page's frames get a hidden tab's
// timers here: each window timer waits at least 60 s, and requestAnimationFrame never calls back.
import { expect, servers, test } from "../../helpers/fixtures";
import { deck } from "./view-page";

await servers.main();

const HIDE = `const st = window.setTimeout.bind(window); window.setTimeout = (f, ms, ...a) => st(f, Math.max(Number(ms) || 0, 60000), ...a); window.requestAnimationFrame = () => 0;`;

test("a tab in the background renders the glide deck at step 2.2, the camera there, in seconds", { timeout: 30_000 }, async ({ tab }) => {
  // The render's own frame (about:srcdoc, on the page's origin) is hidden too, once the test says so.
  await tab.page.addInitScript(`try { if (window.top != window && sessionStorage.getItem("erga-test:hidden")) { ${HIDE} } } catch {}`);
  const { ed, tool } = await deck(tab, "glide");
  await ed.frame(`(() => { ${HIDE} sessionStorage.setItem("erga-test:hidden", "1"); return true; })()`);
  const t0 = Date.now();
  const at = await tool("evaluate_page", {
    step: "2.2",
    expression: `[document.querySelector(".current h2").textContent, document.querySelector(".current").classList.contains("arrived"), getComputedStyle(document.querySelector(".canvas")).transform, getComputedStyle(document.querySelector(".current .build")).visibility]`,
  });
  expect(JSON.parse(at.text.split("\n\n")[0])).toEqual(["Second frame", true, "matrix(1, 0, 0, 1, -1000, 0)", "visible"]);
  const seen = await tool("view_page", { step: "2.2" });
  expect(seen.images).toHaveLength(1);
  expect(seen.text).toContain("at step 2.2 (index 2 of 4: Second frame)");
  expect(Date.now() - t0, "two renders, in seconds, not minutes").toBeLessThan(15_000);
});
