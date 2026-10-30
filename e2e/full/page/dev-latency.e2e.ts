// The dev server's delay on the room's sockets (dev/latency.ts, ERGA_DEV_LATENCY_MS): the editor works with it, and
// an edit takes the delay twice to reach another tab (one tab to the room, the room to the other).
import { expect, servers, test, until } from "../../helpers/fixtures";
import { editor, openEditor } from "../../helpers/editor";

const DELAY = 300;
await servers.of("latency", { latency: String(DELAY) });

test("with a delay on the room's sockets, the editor works and another tab sees an edit two delays later", async ({ tab }) => {
  const a = await openEditor(tab, await servers.of("latency", { latency: String(DELAY) }), "one-line");
  const page = await tab.page.context().newPage();
  await page.goto(`${a.address}?edit`);
  const b = editor(page, a);
  await b.loaded();
  await a.clickEnd("p");
  await a.idle();
  const start = Date.now();
  await a.type("Z");
  await until(async () => (await b.textOf("p")).endsWith("Z"), 5000, "the other tab shows the edit");
  expect(Date.now() - start).toBeGreaterThanOrEqual(2 * DELAY);
  await until(async () => a.disk().includes("Z"), 15_000, "the edit reaches the disk");
});
