// view_page's capture, done in the tab: the page as it is, or one element ("Styling and views").
import { expect, servers, test } from "../../fixtures";
import { openEditor } from "../../editor";

await servers.main();

test("the page can be captured in the browser for the agent, and so can one element; a selector that matches nothing says so", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const shot = await ed.eval<{ png: number; width: number; height: number; error?: string }>(`ergaPage.captureView({}).then((r) => ({ ...r, png: (r.png || "").length }))`);
  expect(shot.error).toBeUndefined();
  expect(shot.png).toBeGreaterThan(1000);
  expect(shot.width).toBeGreaterThan(300);
  expect(shot.height).toBeGreaterThan(300);
  const fig = await ed.eval<{ png: number; width: number; error?: string }>(`ergaPage.captureView({ selector: "figure" }).then((r) => ({ ...r, png: (r.png || "").length }))`);
  expect(fig.error).toBeUndefined();
  expect(fig.png).toBeGreaterThan(200);
  expect(fig.width).toBeGreaterThan(100);
  expect(fig.width).toBeLessThan(900);
  const none = await ed.eval<{ error?: string }>(`ergaPage.captureView({ selector: "#nope" })`);
  expect(none.error ?? "").toMatch(/Nothing on the page matches #nope/);
});
