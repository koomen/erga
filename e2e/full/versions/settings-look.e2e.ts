// The settings on a phone, and over a dark page.
import { expect, servers, test } from "../../fixtures";
import { closeDrafts, draftDoc, openDocEditor } from "./settings";

await servers.short();
test.afterEach(closeDrafts);

test("on a phone: the top row fits, the settings are a sheet from the bottom, and its versions fit the screen", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Phone notes", 3);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address, { width: 390, height: 780 });
  expect(await s.eval<number>(`document.querySelector(".chrome-top").scrollWidth - document.querySelector(".chrome-top").clientWidth`)).toBeLessThanOrEqual(0);
  await s.open();
  const [vw, vh] = await s.eval<[number, number]>("[innerWidth, innerHeight]");
  // It slides up.
  await expect.poll(async () => Math.round((await s.rect("#doc-settings"))!.bottom)).toBe(vh);
  const sheet = (await s.rect("#doc-settings"))!;
  expect(sheet.left).toBe(0);
  expect(Math.round(sheet.w)).toBe(vw);
  const row = (await s.rect("#ds-list li[data-n]"))!;
  expect(row.left >= 0 && row.right <= vw && row.top >= 0 && row.bottom <= vh).toBe(true);
  expect(await s.eval<number>(`document.getElementById("doc-settings").scrollWidth - document.getElementById("doc-settings").clientWidth`)).toBeLessThanOrEqual(0);
});

test("on a page with a dark background, the popover is the editor's own dark card, with none of the page's colour", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Night notes", 4, "body{background:#14161c;color:#e8e8ee;font:18px/1.6 Georgia,serif;max-width:36rem;margin:15vh auto}");
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address, { dark: true });
  await expect.poll(() => s.eval<boolean>(`document.documentElement.classList.contains("page-dark")`)).toBe(true);
  await s.open();
  const look = await s.eval<string[]>(`(() => { const cs = getComputedStyle(document.getElementById("doc-settings")); return [cs.backgroundColor, cs.color]; })()`);
  const lum = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).reduce((a, n) => a + n, 0) / 3;
  expect(look[0], "its background is the dark card's").toBe("rgba(32, 32, 36, 0.94)");
  expect(lum(look[1]), `its text (${look[1]})`).toBeGreaterThan(180);
});
