// The way into the editor from the viewer, and back (client/inline/viewer-edit-boot.ts, client/common/edit-phase.ts):
// it connects once, the address keeps the page each entry was for, and an editor that can't load says so.
import { expect, servers, test } from "../../helpers/fixtures";
import { ready, site, styled, where } from "./tree";

await servers.short();

const keepAgentClosed = (page: import("playwright-core").Page) =>
  page.addInitScript(() => {
    if (window.top != window) return;
    try {
      localStorage.setItem("erga:settings:v1", '{"agent":false}');
    } catch {
      /* no storage */
    }
  });

/** Whether the viewer shows: its pencil up and not pressed, the editor's controls hidden. */
const viewing = (p: import("playwright-core").Page) =>
  p.evaluate(() => {
    const pencil = document.querySelector(".erga-edit-button");
    return !!pencil && getComputedStyle(pencil).visibility == "visible" && pencil.getAttribute("aria-pressed") != "true";
  });

test("pencil, eye, pencil: the editor's room socket opens once", async ({ tab }) => {
  const server = await servers.short();
  const s = await site(server);
  const p = tab.page;
  await keepAgentClosed(p);
  const rooms: string[] = [];
  p.on("websocket", (ws) => {
    if (/\/api\/room\?events=1/.test(ws.url())) rooms.push(ws.url());
  });
  await p.goto(`${server.root}${s.address}`);
  await expect.poll(async () => (await styled(p))?.h1).toBe("Home");
  await p.locator(".erga-edit-button").click();
  await expect.poll(() => ready(p)).toBe(true);
  await p.locator("#btn-edit").click();
  await expect.poll(() => viewing(p)).toBe(true);
  await p.locator(".erga-edit-button").click();
  await expect.poll(() => ready(p)).toBe(true);
  await p.locator("#btn-edit").click();
  await expect.poll(() => viewing(p)).toBe(true);
  await p.locator(".erga-edit-button").click();
  await expect.poll(() => ready(p)).toBe(true);
  expect(rooms.length).toBe(1);
});

test("edit the first page, eye, a link to another page, two entries back: the first page in the editor, its address kept", async ({
  tab,
}) => {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  const p = tab.page;
  await keepAgentClosed(p);
  await p.goto(`${server.root}/docs`);
  await p.goto(`${server.root}${s.address}?edit`);
  await expect.poll(async () => `${await where(p)} ${await ready(p)}`).toBe(`${s.address}?edit true`);
  await p.locator("#btn-edit").click();
  await expect.poll(() => viewing(p)).toBe(true);
  await p.frameLocator("#frame").getByRole("link", { name: "About" }).click();
  await expect.poll(async () => `${await where(p)} ${(await styled(p))?.h1}`).toBe(`${s.address}/about About`);
  // Two entries back at once (the Back button's menu): the frame's history and the tab's go back together.
  await p.evaluate(() => history.go(-2));
  await expect.poll(async () => `${await where(p)} ${(await styled(p))?.h1} ${await ready(p)}`).toBe(`${s.address}?edit Home true`);
});

test("the editor's script fails to load: the pencil stops, the viewer says so, and the pencil tries again", async ({ tab }) => {
  const server = await servers.short();
  const s = await site(server);
  const p = tab.page;
  await keepAgentClosed(p);
  let fail = true;
  await p.route(/\/_erga\/main-[^/]*\.js/, (route) => (fail ? route.abort() : route.continue()));
  await p.goto(`${server.root}${s.address}`);
  await expect.poll(async () => (await styled(p))?.h1).toBe("Home");
  await p.locator(".erga-edit-button").click();
  // The viewer again, the address without ?edit, and a note by the pencil.
  await expect.poll(() => viewing(p)).toBe(true);
  await expect.poll(() => where(p)).toBe(s.address);
  await expect
    .poll(() =>
      p
        .locator(".erga-edit-failed")
        .textContent()
        .catch(() => "")
    )
    .toContain("The editor didn't load");
  expect(await p.locator(".erga-edit-failed").isVisible()).toBe(true);
  // The pencil again, the network back: the editor opens.
  fail = false;
  await p.locator(".erga-edit-button").click();
  await expect.poll(async () => `${await where(p)} ${await ready(p)}`, { timeout: 15_000 }).toBe(`${s.address}?edit true`);
});
