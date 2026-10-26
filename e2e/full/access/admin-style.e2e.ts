// The admin pages have one stylesheet (admin.css, server/admin/style.ts), so a page shown in place by a link
// (client/admin/admin-nav.ts) is styled as it is after a load. Before, the in-place page kept the first page's style: from
// Ops, API keys showed each key's label and env name run together, and its rows without their look.
import { expect, servers, test } from "../../fixtures";

test("a link from one admin page to another shows the new page styled, in place", async ({ tab }) => {
  const server = await servers.main(), { page } = tab;
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${server.root}/admin/ops`);
  // A mark on this window: still here after the links, so the pages came in place, not with a load.
  await page.evaluate(() => { (window as unknown as { stayed: boolean }).stayed = true; });

  await page.click('.admin-side a[href^="/admin/api-keys"]');
  await page.waitForSelector("li.credential .head");
  const keys = await page.evaluate(() => {
    const head = getComputedStyle(document.querySelector("li.credential .head")!), key = getComputedStyle(document.querySelector("li.credential .key")!);
    const row = getComputedStyle(document.querySelector("ol.rows > li.setting")!);
    return { stayed: (window as unknown as { stayed?: boolean }).stayed, head: head.display, gap: head.columnGap, key: key.fontFamily, row: row.display };
  });
  expect(keys).toMatchObject({ stayed: true, head: "flex", gap: "10px", row: "grid" });
  expect(keys.key).not.toBe(await page.evaluate(() => getComputedStyle(document.body).fontFamily));

  await page.click('.admin-side a[href^="/admin/users"]');
  await page.waitForSelector("ol.users .switch .track");
  const users = await page.evaluate(() => ({
    stayed: (window as unknown as { stayed?: boolean }).stayed,
    track: getComputedStyle(document.querySelector("ol.users .switch .track")!).width,
    row: getComputedStyle(document.querySelector("ol.users > li")!).display,
  }));
  expect(users).toEqual({ stayed: true, track: "34px", row: "grid" });

  // A switch is the editor's blue when on and its grey when off (the app's tokens --caret and --rule).
  const colours = await page.evaluate(() => {
    const token = (name: string) => { const el = document.body.appendChild(document.createElement("i")); el.style.background = `var(${name})`; const c = getComputedStyle(el).backgroundColor; el.remove(); return c; };
    // One switch, on and then off (in the page only: no change event, so nothing is sent), without its transition.
    const input = document.querySelector<HTMLInputElement>(".switch input:checked")!, track = input.nextElementSibling as HTMLElement;
    track.style.transition = "none";
    const on = getComputedStyle(track).backgroundColor;
    input.checked = false;
    return { on, off: getComputedStyle(track).backgroundColor, blue: token("--caret"), grey: token("--rule") };
  });
  expect(colours.on).toBe(colours.blue);
  expect(colours.off).toBe(colours.grey);

  // In dark mode: the switch's circle is the page's colour, as the editor's, and a link in the help text is the editor's
  // link colour (--link), readable on the dark page.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${server.root}/admin/auth`);
  await page.waitForSelector(".switch .track");
  const dark = await page.evaluate(() => {
    const token = (name: string) => {
      const el = document.body.appendChild(document.createElement("i"));
      el.style.color = `var(${name})`;
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    };
    const link = document.querySelector<HTMLElement>("main.admin-main .steps a")!;
    return {
      circle: getComputedStyle(document.querySelector(".switch .track")!, "::after").backgroundColor,
      bg: token("--bg"),
      link: getComputedStyle(link).color,
      linkToken: token("--link"),
    };
  });
  expect(dark.circle).toBe(dark.bg);
  expect(dark.link).toBe(dark.linkToken);
  expect(dark.bg).toBe("rgb(24, 24, 27)");
});
