// A person edits alone, and the network drops for a moment (a laptop that sleeps, a Wi-Fi that goes): the sockets come
// back by themselves, and the editor stays as it is. Before, live.js asked the server for the page's build after the
// connection came back, and the viewer's page carried the document's version in an inline script: after any edit the
// build was another, and the page reloaded itself at the next quiet moment (client/live/live.ts, server/pages/viewer.ts).
import { expect, servers, test, until } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

test("an edit, then a short network drop: the editor does not reload itself", { timeout: 40_000 }, async ({ tab }) => {
  const page = tab.page;
  // Each socket the tab opens, so the test can drop them as a network that goes away does (the tab's own, not the page's).
  await page.addInitScript(() => {
    if (window.top != window) return;
    const all: WebSocket[] = ((window as any).__sockets = []);
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, p?: string | string[]) {
        super(url, p);
        all.push(this);
      }
    } as typeof WebSocket;
  });
  const ed = await openEditor(tab, await servers.main(), "empty");
  const said: string[] = [];
  page.on("console", (m) => said.push(m.text()));
  await page.evaluate(`window.__before = true`);
  await ed.clickEnd("p");
  await ed.type("Milk");
  await expect.poll(() => ed.source()).toContain("Milk");

  // The network goes for a moment: the tab's sockets close, and come back by themselves.
  const checked = page.waitForResponse((r) => r.request().headers()["x-erga-check"] == "build", { timeout: 30_000 });
  const open = await page.evaluate<number>(`__sockets.filter((s) => s.readyState == 1).length`);
  expect(open).toBeGreaterThan(0);
  await page.evaluate(`for (const s of __sockets) s.close()`);
  await checked;
  // (Its answer is in: live.js decides at once.)
  await page.evaluate(`new Promise((r) => setTimeout(r, 0))`);

  expect(said.filter((s) => s.includes("a new release"))).toEqual([]);
  expect(await page.evaluate<boolean>(`window.__before === true`)).toBe(true);
  expect(await ed.source()).toContain("Milk");
});
