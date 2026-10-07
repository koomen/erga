// The admin pages in the browser (tests/admin-layout.ts, in headless Chrome): the sidebar collapses and expands and
// is remembered, Share with agent opens its card, the admin's agent collapses to a round button and back, and a
// phone has a row of links. How far the sidebar has moved part-way through its animation is timing:
// admin-sidebar.bench.e2e.ts.
import { expect, servers, test, until, type Page } from "../fixtures";

test.beforeAll(async () => { await servers.main(); });

const widths = (page: Page) => page.evaluate(() => ({
  side: document.getElementById("admin-side")!.getBoundingClientRect().width, main: document.querySelector("main")!.getBoundingClientRect().width,
  closed: document.documentElement.classList.contains("side-closed"), expanded: document.getElementById("side-toggle")!.getAttribute("aria-expanded"),
  label: document.getElementById("side-toggle")!.getAttribute("aria-label"),
}));

test("the sidebar starts open, collapses with an animation to a rail of icons that gives the board the width, is remembered on the next page with no animation, and expands again", async ({ tab }) => {
  const page = tab.page, root = (await servers.main()).root;
  tab.strict = true;
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${root}/admin/factory`);
  await until(() => page.evaluate(() => !!document.getElementById("side-toggle") && !!document.querySelector("#tasks")), 10_000, "the Factory page opens");
  const open = await widths(page);
  expect(open.side).toBeGreaterThan(150);
  expect(open.closed).toBe(false);
  expect(open.expanded).toBe("true");
  // Animated: right after the click, the sidebar's width is on its way (a transition running), not there at once.
  const moving = await page.evaluate(() => {
    document.getElementById("side-toggle")!.click();
    const side = document.getElementById("admin-side")!;
    return { animations: side.getAnimations().length, width: side.getBoundingClientRect().width };
  });
  expect(moving.animations, "a transition runs").toBeGreaterThan(0);
  expect(moving.width).toBeGreaterThan(52);
  await until(async () => (await widths(page)).side == 52, 3000, "it ends as a rail of icons");
  const closed = await widths(page);
  expect(closed.closed).toBe(true);
  expect(closed.expanded).toBe("false");
  expect(closed.label).toBe("Expand the sidebar");
  expect(closed.main).toBeGreaterThanOrEqual(open.main + open.side - 52 - 1);
  // Remembered: another admin page opens collapsed, at once, with no animation.
  await page.goto(`${root}/admin/users`);
  const again = await page.evaluate(() => ({ animations: document.getElementById("admin-side")!.getAnimations().length }));
  expect(again.animations, "no animation on load").toBe(0);
  const w = await widths(page);
  expect(w.closed).toBe(true);
  expect(w.side).toBe(52);
  await page.evaluate(() => document.getElementById("side-toggle")!.click());
  await until(async () => (await widths(page)).side > 150, 3000, "it expands again");
  expect(await page.evaluate(() => localStorage.getItem("erga:admin-sidebar"))).toBe("open");
});

test("Share with agent opens its card on a page that isn't the factory's, and the card gets a token or says why not", async ({ tab }) => {
  const page = tab.page;
  tab.strict = true;
  await page.goto(`${(await servers.main()).root}/admin/users`);
  await until(() => page.evaluate(() => !!document.getElementById("btn-share")), 10_000, "/admin/users opens");
  await page.evaluate(() => document.getElementById("btn-share")!.click());
  await until(() => page.evaluate(() => !!document.getElementById("share") && !document.getElementById("share")!.hidden && document.getElementById("btn-share")!.getAttribute("aria-expanded") == "true"), 5000, "the card opens");
  await until(() => page.evaluate(() => /erga_[A-Za-z0-9_-]{20,}/.test((document.getElementById("share-prompt") as HTMLTextAreaElement).value) || document.getElementById("share-status")!.textContent!.length > 0), 10_000, "the card gets a token, or says why not");
});

test("the admin's agent: open beside the page; its button collapses it to a round button in the lower left, remembered; ⌘J expands it with the box focused; Esc collapses it; the round button expands it", async ({ tab }) => {
  const page = tab.page, root = (await servers.main()).root;
  tab.strict = true;
  await page.setViewportSize({ width: 1400, height: 900 });
  const agent = () => page.evaluate(() => {
    const f = document.getElementById("agent-fab")!, fb = f.getBoundingClientRect();
    return { width: document.getElementById("agent")!.getBoundingClientRect().width, mainLeft: document.querySelector("main")!.getBoundingClientRect().left, closed: document.documentElement.classList.contains("agent-closed"),
      fab: { left: fb.left, bottom: fb.bottom, opacity: getComputedStyle(f).opacity }, inert: (document.getElementById("agent") as HTMLElement).inert, expanded: f.getAttribute("aria-expanded") };
  });
  await page.goto(`${root}/admin/users`);
  await until(async () => (await page.evaluate(() => document.getElementById("agent-model")?.textContent ?? "")).length > 0, 10_000, "the agent panel connects on /admin/users");
  const opened = await agent();
  expect(opened.closed).toBe(false);
  expect(opened.width).toBeGreaterThanOrEqual(300);
  expect(opened.inert).toBe(false);
  expect(opened.expanded).toBe("true");
  await page.evaluate(() => document.getElementById("agent-close")!.click());
  await until(async () => { const a = await agent(); return a.width == 0 && a.fab.opacity == "1"; }, 3000, "it collapses to its round button");
  const closed = await agent();
  expect(closed.closed).toBe(true);
  expect(closed.inert).toBe(true);
  expect(closed.fab.left).toBeLessThanOrEqual(24);
  expect(closed.fab.bottom).toBeGreaterThanOrEqual(900 - 24);
  expect(closed.mainLeft, "the page takes the room").toBeLessThan(opened.mainLeft);
  await page.goto(`${root}/admin/changes`);
  await until(() => page.evaluate(() => !!document.getElementById("agent-fab")), 10_000, "/admin/changes opens");
  expect((await agent()).closed, "the next admin page opens with it collapsed").toBe(true);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true })));
  await until(async () => (await agent()).width >= 300, 3000, "⌘J expands it");
  expect(await page.evaluate(() => document.activeElement?.id ?? "")).toBe("agent-input");
  expect(await page.evaluate(() => localStorage.getItem("erga:admin-agent"))).toBe("open");
  await page.evaluate(() => document.getElementById("agent-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await until(async () => (await agent()).closed, 3000, "Esc in the panel collapses it");
  await page.evaluate(() => document.getElementById("agent-fab")!.click());
  await until(async () => (await agent()).width >= 300, 3000, "the round button expands it again");
});

test("on a phone: the links in one row, no toggle, no sideways scroll, and the agent collapsed so the page shows", async ({ tab }) => {
  const page = tab.page;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${(await servers.main()).root}/admin`);
  await until(() => page.evaluate(() => !!document.getElementById("admin-side")), 10_000, "/admin opens on a phone");
  const row = await page.evaluate(() => ({ tops: [...document.querySelectorAll(".admin-side a")].map((a) => Math.round(a.getBoundingClientRect().top)), toggle: getComputedStyle(document.getElementById("side-toggle")!).display, fits: document.documentElement.scrollWidth <= innerWidth }));
  expect(new Set(row.tops).size).toBe(1);
  expect(row.toggle).toBe("none");
  expect(row.fits).toBe(true);
  expect(await page.evaluate(() => document.documentElement.classList.contains("agent-closed"))).toBe(true);
});
