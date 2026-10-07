// How soon the prompt shows after the broken paragraph's Fix button (tests/suite/suites/browser.ts, "at once":
// within a second). A bench: it measures time, which a busy machine moves.
import { expect, until } from "../../tests/suite/harness";
import { browserTest, openAs } from "./suite";

browserTest("e2e/suite/browser-broken.bench.e2e.ts", "the Fix button's prompt shows in the agent panel at once", { needs: ["scriptedAgent"] }, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada");
  const s = (await d.stored(d.path))!;
  expect((await d.push(d.path, s.text.replace("Where the leads go.", "Where the</h2> leads go."), s.etag)).ok, "the broken markup is published");
  await until(() => a.frame<boolean>(`!!${a.F}.querySelector("figcaption.erga-locked")`), 5000, "the paragraph locks");
  const r = await a.rectOf("figcaption", 0.2);
  await a.click(r.x, r.y);
  await until(() => a.eval<boolean>(`!!document.querySelector("#toast.show .toast-fix")`), 3000, "the note offers a fix");
  const ms = await a.eval<number>(`new Promise((done) => { const t0 = performance.now(); document.querySelector("#toast .toast-fix").click();
    (function look() { if ([...document.querySelectorAll("#agent-log .msg-user")].some((e) => e.textContent.includes("stray </h2>"))) done(performance.now() - t0); else requestAnimationFrame(look); })(); })`);
  ctx.metric("prompt visible after", ms);
  expect(ms < 1000, `the prompt shows within a second (${Math.round(ms)} ms)`);
});
