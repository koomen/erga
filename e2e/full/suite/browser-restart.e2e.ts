// The multiplayer suite in real tabs: a tab rides out a restart of its own server.
import { expect, until } from "./harness";
import { browserTest, openAs } from "./suite";

browserTest("e2e/full/suite/browser-restart.e2e.ts", "a tab rides out a server restart, keeping what was typed while it was down", { needs: ["restart"] }, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada"), b = await openAs(tab, ctx, d, "Bo");
  await d.restart!("graceful", async () => {
    await until(() => a.eval<boolean>("!ergaPage.collab.provider.wsconnected"), 5000, "Ada's tab notices the server is gone");
    await a.clickEnd("h1");
    await a.type(" offline");
  });
  await until(async () => (await b.textOf("h1")).endsWith(" offline"), 10_000, "Bo gets Ada's offline typing once the server is back");
  expect((await a.source()) == (await b.source()) && (await a.source()).split("<h1>").length == 2, "the tabs agree and nothing is doubled");
  expect(await a.eval<boolean>(`document.getElementById("welcome").hidden`), "no 'out of date' notice");
});
