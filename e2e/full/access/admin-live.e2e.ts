// The admin pages' live lists share one socket (client/common/live-rows.ts, news-phase.ts). A link to another admin
// page while that socket waits to reconnect leaves no socket that nothing owns: the new page has one, and only one.
import { expect, servers, test, until } from "../../helpers/fixtures";

await servers.main();

test("the news socket drops, then a link to another admin page: one news socket, not two", { timeout: 60_000 }, async ({ tab }) => {
  const server = await servers.main(),
    { page } = tab;
  await page.addInitScript(() => {
    const sockets: WebSocket[] = ((window as any).__sockets = []);
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
        this.addEventListener("close", () => ((this as any).closedAt = Date.now()));
      }
    } as typeof WebSocket;
  });
  /** The news sockets the page made: each one's state, and when the last one closed. */
  const news = () =>
    page.evaluate<{ states: number[]; lastClosed: number }>(
      `(() => { const s = window.__sockets.filter((w) => w.url.includes("/api/news")); return { states: s.map((w) => w.readyState), lastClosed: Math.max(0, ...s.map((w) => w.closedAt ?? 0)) }; })()`
    );
  await page.goto(`${server.root}/admin/users`);
  await until(async () => (await news()).states[0] == WebSocket.OPEN, 10_000, "the news socket opens");
  // The server drops: the socket fails to come back a few times, and waits longer each time.
  await page.context().setOffline(true);
  await page.evaluate(`window.__sockets.forEach((s) => s.close())`);
  await until(
    async () => {
      const s = await news();
      return s.states.length >= 4 && s.states.every((r) => r == WebSocket.CLOSED);
    },
    15_000,
    "the socket failed to come back three times"
  );
  const { lastClosed, states } = await news();
  await page.context().setOffline(false);
  await page.click('.admin-side a[href^="/admin/auth"]');
  await page.waitForSelector(".switch .track");
  await until(async () => (await news()).states.at(-1) == WebSocket.OPEN, 10_000, "the new page's socket opens");
  // The old socket's wait (backoff(3): at most 5 s after its last failure) is over: a socket it opened would be here by now.
  await until(async () => Date.now() > lastClosed + 5500, 10_000, "the old socket's wait is over");
  expect((await news()).states.length - states.length, "the new page's socket, and no other").toBe(1);
});
