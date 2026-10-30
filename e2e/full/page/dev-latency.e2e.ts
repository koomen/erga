// The dev server's delay on the room's sockets (dev/latency.ts, ERGA_DEV_LATENCY_MS): the editor works with it, and
// an edit takes the delay twice to reach another tab (one tab to the room, the room to the other). A range gives each
// chunk its own delay: the frames must still arrive whole and in order (the tab's strict check fails on a broken one).
import { expect, servers, test, until } from "../../helpers/fixtures";
import { editor, openEditor } from "../../helpers/editor";

const LATENCY = "300-500";
await servers.of("latency", { latency: LATENCY });

test("with a delay on the room's sockets, the editor works and another tab sees edits two delays later", async ({ tab }) => {
  const a = await openEditor(tab, await servers.of("latency", { latency: LATENCY }), "long");
  const page = await tab.page.context().newPage();
  await page.goto(`${a.address}?edit`);
  const b = editor(page, a);
  await b.loaded();
  // Each load sends the whole page over the socket in large frames, the ones a reorder breaks.
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await b.loaded();
  }
  await a.clickEnd("h1");
  await a.idle();
  const start = Date.now();
  await a.type("Zebra crossing");
  await until(async () => (await b.textOf("h1")).endsWith("Zebra crossing"), 10_000, "the other tab shows the edits");
  expect(Date.now() - start).toBeGreaterThanOrEqual(600);
  await until(async () => a.disk().includes("Zebra crossing"), 15_000, "the edits reach the disk");
});
