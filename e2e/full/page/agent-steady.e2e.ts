// The agent panel from page to page ("the agent shouldn't refresh its contents visible every time i navigate from one
// page to the next"): the next page shows the same conversation, at the same scroll place, from its first paint.
import { expect, servers, settle, test, until } from "../../helpers/fixtures";

await servers.script();

/**
 * At each page's first frame that shows the panel open: what its log shows, before the agent's own script loads the
 * conversation. (Before that frame, under load, Chrome may paint a page whose panel is still the closed circle.)
 */
const FIRST_PAINT = `(() => {
  const look = () => {
    const l = document.getElementById("agent-log");
    if (!l || !document.body.classList.contains("agent-open")) return requestAnimationFrame(look);
    window.__firstPaint = { n: l.children.length, top: l.scrollTop, model: document.getElementById("agent-model").textContent };
    window.__firstItem = l.firstElementChild;
  };
  requestAnimationFrame(look);
})()`;

test("the agent panel shows the same conversation and scroll place from the next page's first paint", async ({ tab }) => {
  const server = await servers.script();
  const { page } = tab;
  const [a, b] = [await server.fixture("empty"), await server.fixture("empty")];
  await page.addInitScript(FIRST_PAINT);
  await page.goto(`${server.root}/docs`);
  await until(() => page.evaluate(() => !!window.ergaAgent), 5000, "the panel's script runs");
  await page.evaluate(() => window.ergaAgent!.show(true));
  await until(
    () => page.evaluate(() => document.getElementById("agent-model")!.textContent == "script (test model)"),
    10_000,
    "the agent is on"
  );
  const log = () =>
    page.evaluate(() => {
      const l = document.getElementById("agent-log")!;
      return {
        n: l.children.length,
        top: l.scrollTop,
        max: l.scrollHeight - l.clientHeight,
        same: l.firstElementChild == window.__firstItem,
      };
    });
  const long = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long answer.`).join("\n");
  for (let i = 1; i <= 3; i++) {
    await page.focus("#agent-input");
    await page.keyboard.insertText(`Message ${i} @script ${JSON.stringify([{ text: `Answer ${i}.\n${long}` }])}`);
    await page.keyboard.press("Enter");
    await until(async () => (await page.locator("#agent-log .msg-assistant").count()) == i, 10_000, `answer ${i}`);
  }
  await settle(page);
  // Read back a little: the next page keeps that place too.
  const box = (await page.locator("#agent-log").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await until(
    async () => {
      const s = await log();
      return s.max - s.top > 200;
    },
    2000,
    "the wheel scrolls the log up"
  );
  await settle(page);
  const before = await log();
  expect(before.n).toBe(6);

  // Each page reads the conversation as it starts, and again once its socket opens.
  let reads = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/agent/conversation")) reads++;
  });
  for (const to of [a.address, b.address, `${server.root}/docs`]) {
    reads = 0;
    await page.goto(to);
    await until(() => page.evaluate(() => !!window.__firstPaint), 5000, "the next page paints");
    const first = await page.evaluate(() => window.__firstPaint!);
    expect(first, `${to}: the panel at the first paint`).toEqual({ n: before.n, top: before.top, model: "script (test model)" });
    // The page's agent loads the conversation (and its socket reads it again): nothing changes that a person sees.
    await until(() => reads >= 2, 5000, "the page and its socket read the conversation");
    await page.waitForLoadState("networkidle");
    await settle(page);
    // (The panel's height may differ by a few pixels from page to page: only its place counts.)
    const { max: _, ...now } = await log();
    expect(now, `${to}: the panel once loaded`).toEqual({ n: before.n, top: before.top, same: true });
  }

  // Another person in this tab (local development's ?user=) never sees the copy: their panel starts empty.
  expect(await page.evaluate(() => sessionStorage.getItem("erga:agent-panel")), "tester's copy").toContain("Answer 3");
  await page.evaluate(() => {
    window.__firstPaint = undefined;
  });
  await page.goto(`${server.root}/docs?user=ada`);
  await until(() => page.evaluate(() => !!window.__firstPaint), 5000, "ada's page paints");
  expect(await page.evaluate(() => window.__firstPaint!.n), "ada's panel at the first paint").toBe(0);

  // Sign-out deletes the tab's copy (ada's now, kept as that page went).
  await page.evaluate(() => location.assign("/auth/logout"));
  await until(
    () => page.evaluate(() => !document.title.startsWith("Signing out") && document.readyState == "complete").catch(() => false),
    15_000,
    "signed out"
  );
  expect(await page.evaluate(() => sessionStorage.getItem("erga:agent-panel")), "the panel's copy after sign-out").toBeNull();
});

declare global {
  interface Window {
    __firstPaint?: { n: number; top: number; model: string | null };
    __firstItem?: Element | null;
    ergaAgent?: { show(open: boolean): void };
  }
}
