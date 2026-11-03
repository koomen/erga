// view_page with no editor open anywhere: the server's browser renders the page, or one element ("Styling and views").
import { expect, servers, test } from "../../helpers/fixtures";
import { agentTools } from "./view-page";

await servers.main();

test("with no tab open, the agent sees the page and one element; a selector that matches nothing says so", async () => {
  const s = await servers.main();
  const { address } = await s.fixture("page");
  const { tool, fails } = await agentTools(s, address);
  const page = await tool("view_page", {});
  expect(page.images).toHaveLength(1);
  expect(page.images[0].length).toBeGreaterThan(1000);
  expect(page.text).toContain("Screenshot: 1280×800px, top of the page, of index.html.");
  const fig = await tool("view_page", { selector: "figure" });
  const [, w] = /Screenshot: (\d+)×(\d+)px of figure/.exec(fig.text) ?? [];
  expect(Number(w)).toBeGreaterThan(100);
  expect(Number(w)).toBeLessThan(900);
  expect(await fails("view_page", { selector: "#nope" })).toMatch(/Nothing on the page matches #nope/);
});
