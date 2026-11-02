// The editor on a phone (narrower than 760px): at rest the buttons' bar is your avatar alone; a tap on it opens the
// quick actions out of it, to its left, and its menu under it, and the breadcrumbs' bar makes way with its end in
// sight. A card opened from the quick actions keeps them open; a tap on the page closes all. The agent starts closed,
// and open it covers the page.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

const W = 390,
  H = 844;

/** The two bars as they show: the quick actions' width, the buttons that show in the right bar, the breadcrumbs' bar against it. */
const look = (ed: Editor) =>
  ed.eval<{
    quick: number;
    shown: string[];
    open: boolean;
    menu: boolean;
    navRight: number;
    topLeft: number;
    titleIn: boolean;
    brandOut: boolean;
  }>(`(() => {
    const top = document.querySelector(".chrome-top").getBoundingClientRect(), nav = document.getElementById("nav-docs").getBoundingClientRect();
    const title = document.getElementById("doc-title").getBoundingClientRect(), brand = document.getElementById("nav-brand").getBoundingClientRect();
    const shown = [...document.querySelectorAll(".chrome-top :is(.icon-btn, .avatar)")].filter((b) => {
      const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      return r.width > 0 && b.contains(document.elementFromPoint(x, y));
    }).map((b) => b.id || (b.classList.contains("me") ? "me" : b.className));
    return {
      quick: Math.round(document.getElementById("quick").getBoundingClientRect().width), shown,
      open: document.body.classList.contains("quick-open"), menu: !document.getElementById("account").hidden,
      navRight: nav.right, topLeft: top.left,
      titleIn: title.right <= nav.right + 0.5 && title.right >= nav.right - 12, brandOut: brand.left < nav.left,
    };
  })()`);

test("phone: at rest only the avatar; a tap opens the quick actions and the menu, the breadcrumbs make way; a card keeps them open; a tap on the page closes all", async ({
  tab,
}) => {
  await tab.page.setViewportSize({ width: W, height: H });
  const ed = await openEditor(tab, await servers.main(), "long", { agent: true });
  expect(await ed.eval<boolean>(`document.body.classList.contains("agent-open")`), "the agent starts closed").toBe(false);
  await expect
    .poll(async () => {
      const l = await look(ed);
      return { quick: l.quick, shown: l.shown, open: l.open };
    })
    .toEqual({ quick: 0, shown: ["me"], open: false });
  const avatar = (await ed.page.locator(".me-slot .avatar").boundingBox())!;
  await ed.page.mouse.click(avatar.x + avatar.width / 2, avatar.y + avatar.height / 2);
  await expect
    .poll(async () => (await look(ed)).shown)
    .toEqual(expect.arrayContaining(["btn-new", "btn-full", "btn-settings", "btn-edit", "btn-agent-share", "btn-docs", "me"]));
  const opened = await look(ed);
  expect(opened.open && opened.menu, "the quick actions and the menu are open").toBe(true);
  expect(opened.navRight, "the breadcrumbs' bar ends before the buttons' bar").toBeLessThanOrEqual(opened.topLeft - 7.5);
  expect(opened.titleIn, "the title's end shows").toBe(true);
  expect(opened.brandOut, "erga has slid out on the left").toBe(true);
  // Document settings, from the quick actions: its card opens, the menu closes, the quick actions stay.
  const gear = (await ed.page.locator("#btn-settings").boundingBox())!;
  await ed.page.mouse.click(gear.x + gear.width / 2, gear.y + gear.height / 2);
  await expect.poll(() => ed.eval<boolean>(`!!document.querySelector("#doc-settings:not([hidden])")`)).toBe(true);
  expect(await look(ed)).toMatchObject({ open: true, menu: false });
  // A tap on the page, above the settings' sheet, closes them all.
  const sheet = (await ed.page.locator("#doc-settings").boundingBox())!;
  await ed.page.mouse.click(W / 2, sheet.y / 2 + 40);
  await expect
    .poll(async () => {
      const l = await look(ed);
      return { quick: l.quick, shown: l.shown, open: l.open };
    })
    .toEqual({ quick: 0, shown: ["me"], open: false });
  expect(await ed.eval<boolean>(`!!document.querySelector("#doc-settings:not([hidden])")`)).toBe(false);
});

test("phone: the agent, opened, covers the page, 16px from the sides and the bottom and 8px from the top", async ({ tab }) => {
  await tab.page.setViewportSize({ width: W, height: H });
  const ed = await openEditor(tab, await servers.main(), "empty");
  const fab = (await ed.page.locator("#agent-fab").boundingBox())!;
  await ed.page.mouse.click(fab.x + fab.width / 2, fab.y + fab.height / 2);
  await expect
    .poll(() =>
      ed.eval<number[]>(
        `(() => { const r = document.querySelector(".agent-glass").getBoundingClientRect(); return [r.left, r.top, innerWidth - r.right, innerHeight - r.bottom].map(Math.round); })()`
      )
    )
    .toEqual([16, 8, 16, 16]);
});
