// The person's agent on a page (client/agent/person-agent.ts). With its panel closed, it reads the conversation one
// time, and only after the page has loaded: the page itself does not wait for it. With the panel open, it reads it at
// once. A message sent shows the agent at work at once, before the server answers.
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";

await servers.script();

/** /docs as `user`, with the panel open or closed as this browser keeps it. */
async function docs(page: Page, root: string, user: string, open: boolean) {
  await page.addInitScript((open) => localStorage.setItem("erga:settings:v1", JSON.stringify({ agent: open })), open);
  await page.goto(`${root}/docs?user=${user}`);
  await until(
    () => page.evaluate(() => document.getElementById("agent-model")!.textContent == "script (test model)"),
    10_000,
    "the agent is on"
  );
}
/** The page's requests for the conversation: when each started, against the page's load event. */
const reads = (page: Page) =>
  page.evaluate(() => {
    const loaded = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).loadEventStart;
    return performance
      .getEntriesByType("resource")
      .filter((r) => /\/api\/agent\/conversation/.test(r.name))
      .map((r) => (r.startTime >= loaded ? "after load" : "before load"));
  });
test("the panel closed: the conversation is read one time, after the page has loaded", async ({ tab }) => {
  const { page } = tab;
  let socket = false;
  page.on("websocket", (ws) => {
    if (/\/api\/agent\/events/.test(ws.url())) socket = true;
  });
  await docs(page, (await servers.script()).root, "lazy-closed", false);
  // Its socket is open, and nothing more is on its way.
  await until(async () => socket, 10_000, "the agent's socket");
  await page.waitForLoadState("networkidle");
  expect(await reads(page)).toEqual(["after load"]);
});

test("the panel open: the conversation is read at once", async ({ tab }) => {
  const { page } = tab;
  await docs(page, (await servers.script()).root, "lazy-open", true);
  expect((await reads(page))[0]).toBe("before load");
});

test("a message sent shows the agent at work at once, before the server has it; not sent, it stops", async ({ tab }) => {
  const { page } = tab;
  const root = (await servers.script()).root;
  await docs(page, root, "lazy-send", true);
  const held: (() => void)[] = [];
  await page.route(/\/api\/agent(\?.*)?$/, (r) => (r.request().method() == "POST" ? void held.push(() => void r.abort()) : r.continue()));
  await page.focus("#agent-input");
  await page.keyboard.insertText(`Hello @script [{"text":"Hi."}]`);
  await page.keyboard.press("Enter");
  const working = () => page.evaluate(() => document.getElementById("agent-fab")!.classList.contains("busy"));
  await expect.poll(working).toBe(true);
  await expect.poll(() => held.length).toBeGreaterThan(0);
  expect(await page.locator("#agent-log .msg-user.pending").count()).toBe(1);
});
