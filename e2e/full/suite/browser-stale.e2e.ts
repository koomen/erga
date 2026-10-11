// The multiplayer suite in real tabs: a tab whose history the room lost says so.
import { expect, until } from "./harness";
import { browserTest, openAs } from "./suite";

browserTest("e2e/full/suite/browser-stale.e2e.ts", "a tab the room can't merge any more says so and offers a reload", { needs: ["kill"] }, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada");
  await d.restart!("lose-state");
  await until(async () => !(await a.eval<boolean>(`document.getElementById("welcome").hidden`)), 10_000, "the notice appears");
  expect(/out of date/.test(await a.eval<string>(`document.getElementById("welcome").textContent`)), "it explains");
  await a.eval(`document.getElementById("stale-reload").click()`);
  await until(async () => a.eval<boolean>(`document.getElementById("welcome").hidden && !!window.ergaPage`).catch(() => false), 10_000, "a reload brings the page back");
});
