// The multiplayer suite in real tabs: the room loses its history (a new epoch) while a tab edits offline. The tab can't
// merge its replica any more: it loads again by itself, and its edits go in as edits of the text (collab.ts, adopt),
// once.
import { expect } from "./harness";
import { until } from "../../helpers/fixtures";
import { browserTest, openAs } from "./suite";

browserTest(
  "e2e/full/suite/browser-stale.e2e.ts",
  "the room loses its history while a tab edits offline: the tab loads again, and its edits go in once",
  { needs: ["kill"] },
  async (ctx, tab) => {
    const d = await ctx.doc();
    const a = await openAs(tab, ctx, d, "Ada");
    await d.restart!("lose-state", async () => {
      await until(() => a.eval<boolean>("!ergaPage.collab.connected"), 5000, "Ada's tab notices the server is gone");
      await a.clickEnd("h1");
      await a.type(" offline");
    });
    const b = await openAs(tab, ctx, d, "Bo");
    await until(async () => (await b.textOf("h1")).endsWith(" offline"), 15_000, "Bo gets Ada's offline typing, from the new history");
    await until(async () => (await a.textOf("h1").catch(() => "")).endsWith(" offline"), 15_000, "Ada's tab, loaded again, has it");
    const source = await b.source();
    expect(source.split("<h1>").length == 2 && source.split(" offline").length == 2, "nothing is doubled");
    expect(await a.eval<boolean>(`document.getElementById("welcome").hidden`), "no notice");
  }
);

browserTest(
  "e2e/full/suite/browser-stale.e2e.ts",
  "the socket dies with no close, the room loses its history: every character typed meanwhile arrives once",
  { needs: ["kill"] },
  async (ctx, tab) => {
    const d = await ctx.doc();
    const a = await openAs(tab, ctx, d, "Ada");
    // The page's socket goes silent: nothing it sends arrives, and nothing says so (the ping hasn't caught it yet).
    await a.frame(`(WebSocket.prototype.send = function () {}, true)`);
    await a.clickEnd("h1");
    await a.type(" unsent");
    await d.restart!("lose-state");
    const b = await openAs(tab, ctx, d, "Bo");
    await until(async () => (await b.textOf("h1")).endsWith(" unsent"), 15_000, "Bo gets the characters the room never had");
    const source = await b.source();
    expect(source.split("<h1>").length == 2 && source.split("unsent").length == 2, "nothing is doubled");
  }
);
