// The start of the editor (the pencil, or ?edit) does its steps at the same time, not one after the other. The shell
// asks for the edit key while it connects, not after its first sync. The page's editor takes the room's text from one
// answer (GET /api/start, with its edit key), so it takes keys before its own socket is open.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

test("the page's editor takes keys while its socket still connects; the text reaches the room when it opens", async ({ tab }) => {
  const page = tab.page;
  // The page's own socket (it opens with the edit key) waits here.
  const held: (() => void)[] = [];
  await page.routeWebSocket(/\/api\/room\?key=/, (ws) => {
    held.push(() => ws.connectToServer());
  });
  const ed = await openEditor(tab, await servers.main(), "empty");
  expect(held.length).toBe(1);
  await ed.press("End");
  await page.keyboard.type("Milk");
  await ed.shows("Milk|");
  // The socket opens: the shell's replica, which only the room feeds, gets the text.
  held[0]();
  await until(async () => (await ed.source()).includes("Milk"), 10_000, "the text reaches the room");
});

test("the edit key is asked for while the document's start is on its way", async ({ tab }) => {
  const page = tab.page;
  let key = false;
  const seen: { keyFirst?: boolean } = {};
  await page.route("**/api/key*", (r) => {
    key = true;
    return r.continue();
  });
  // The shell's start (the page's own has the key in its address) is held until the key is asked for, or a while passes.
  await page.route(/\/api\/start(\?user=[^&]*)?$/, async (r) => {
    await until(async () => key, 3000, "the key is asked for").catch(() => {});
    seen.keyFirst ??= key;
    return r.continue();
  });
  await openEditor(tab, await servers.main(), "empty");
  expect(seen.keyFirst).toBe(true);
});
