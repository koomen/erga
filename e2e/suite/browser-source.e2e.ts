// The multiplayer suite in real tabs (e2e/suite/suites/browser.ts): the source view follows others' typing.
import { until } from "./harness";
import { browserTest, noErrors, openAs, peerNames } from "./suite";

browserTest("e2e/suite/browser-source.e2e.ts", "the source view follows others' typing and shows their caret; the page redraws it after", {}, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada"), b = await openAs(tab, ctx, d, "Bo");
  const sourceOpen = () => b.eval<boolean>(`document.body.classList.contains("source")`);
  await b.press("ControlOrMeta+Shift+p");
  await until(sourceOpen, 5000, "Bo's source view opens");
  await a.clickEnd("h1");
  await a.type("!");
  await until(async () => (await b.eval<string>(`document.querySelector("#source .cm-content").textContent`)).includes("Launch notes!"), 5000, "Bo's source view has Ada's typing");
  await until(async () => (await b.eval<string>(`[...document.querySelectorAll("#source .cm-peer-name")].map((e) => e.textContent).join("|")`)) == "Ada", 5000, "and her caret");
  await b.press("ControlOrMeta+Shift+p");
  await until(async () => (await peerNames(b)) == "Ada", 5000, "back on the page, her caret is drawn again");
  noErrors(b, "Bo");
});
