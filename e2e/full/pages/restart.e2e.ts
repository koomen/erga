// Folders last across a restart.
import { expect, test } from "../../helpers/fixtures";
import { paths, site } from "./tree";
import { runTool } from "../../helpers/tools";

// A server of its own, as the test stops it, and a second on the first's state: two starts (a few seconds each; more on a loaded machine).
const TWO_SERVERS = { timeout: 90_000 };

test("an empty folder, and every page, are still there after a restart", TWO_SERVERS, async ({ tab }) => {
  const first = await tab.own({ env: { ERGA_AGENT_MODEL: "script" } });
  const s = await site(first, { pages: true });
  await s.treeOp({ op: "new_folder", path: "empty" });
  // Stored first: stopping the dev server loses what the room hasn't written to storage yet (only documents linked to
  // disk are flushed on the way out, dev/start.ts).
  await expect.poll(async () => (await s.get(`/d/${s.id}/api/stored/blog/post.html`)).text()).toContain("<h1>A post</h1>");
  first.stop();
  const again = await tab.own({ env: { ERGA_AGENT_MODEL: "script" }, state: first.state });
  const t = (await runTool(again.root, "list_pages", { document: s.id })).result as { entries: [] };
  expect(paths(t.entries)).toContain("empty/");
  expect(paths(t.entries)).toContain("blog/post.html");
});
