// The editor's own controls (the editor): your avatar's menu, sharing with people, the order of the
// controls, the view switcher, and the pencil between viewing and editing without a reload.
import { expect, servers, test, until, type Page } from "../../fixtures";
import { clickOn, inFrames, inPage, newDoc } from "./access";

await servers.main();

/** A new document, open in the editor at 1100×720, its controls shown: its editor address. */
async function editing(page: Page): Promise<string> {
  const root = (await servers.main()).root;
  const { at } = await newDoc(root);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(root + at);
  await until(() => page.evaluate(() => !!document.querySelector("#me .avatar") && document.body.classList.contains("erga-editor-ready")), 10_000, "the editor shows your avatar");
  return at;
}

test("your avatar, far right of the editor's controls with your GitHub picture, opens the menu, which stays open; Escape closes it; the pencil beside it is on and goes to the viewer", async ({ tab }) => {
  const page = tab.page;
  const at = await editing(page);
  // Its controls fade in: wait for where they end.
  await expect.poll(() => page.evaluate(() => { const b = document.querySelector("#me .avatar")!, r = b.getBoundingClientRect(); return r.right > 1100 - 30 && r.top < 30 && !!b.querySelector("img")?.getAttribute("src")?.startsWith("https://avatars.githubusercontent.com/tester"); })).toBe(true);
  // A press on the picture or the logo is a click: the browser doesn't drag either away.
  expect(await page.evaluate(() => { const img = document.querySelector<HTMLImageElement>("#me .avatar img")!, brand = document.getElementById("nav-brand")!; return { img: img.draggable, imgDrag: getComputedStyle(img).getPropertyValue("-webkit-user-drag"), brand: brand.draggable }; })).toEqual({ img: false, imgDrag: "none", brand: false });
  await clickOn(page, "#me .avatar");
  const menu = () => page.evaluate(() => ({ hidden: document.getElementById("account")!.hidden, expanded: document.querySelector("#me .avatar")!.getAttribute("aria-expanded"), links: [...document.querySelectorAll<HTMLAnchorElement>("#account a:not([hidden])")].map((a) => a.textContent + " " + a.getAttribute("href")) }));
  expect(await menu()).toEqual({ hidden: false, expanded: "true", links: ["Documents /docs", "Settings /settings", "Deploy your own /deploy", "Admin settings /admin", "Sign out /auth/logout"] });
  // Stays open: the same after the frames that follow the click (the old harness looked again 600 ms later; a pause has no place in the gate).
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0)))));
  expect((await menu()).hidden).toBe(false);
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => document.getElementById("account")!.hidden)).toBe(true);
  expect(await page.evaluate(() => { const e = document.getElementById("btn-edit")!; return { pressed: e.getAttribute("aria-pressed"), hidden: e.hidden, href: e.getAttribute("href") }; })).toEqual({ pressed: "true", hidden: false, href: at.replace(/#edit$/, "") });
});

test("its owner adds someone, sees them listed with their role, and takes them off; the controls, left to right up to your avatar", async ({ tab }) => {
  const page = tab.page;
  await editing(page);
  await clickOn(page, "#btn-share");
  await until(() => page.evaluate(() => !document.getElementById("sharing")!.hidden && !!document.querySelector("#sharing-list li")), 5000, "the Share button opens who has the document");
  await page.evaluate(() => { const f = document.getElementById("sharing-add") as HTMLFormElement; (f.elements.namedItem("login") as HTMLInputElement).value = "ada"; (f.elements.namedItem("role") as HTMLSelectElement).value = "viewer"; f.requestSubmit(); });
  await until(() => page.evaluate(() => [...document.querySelectorAll("#sharing-list li")].some((li) => li.querySelector(".who")!.textContent!.startsWith("ada") && li.querySelector("select")?.value == "viewer")), 5000, "adding someone lists them, with their role");
  await page.evaluate(() => ([...document.querySelectorAll("#sharing-list li")].find((li) => li.querySelector(".who")!.textContent!.startsWith("ada"))!.querySelector(".remove") as HTMLElement).click());
  await until(() => page.evaluate(() => ![...document.querySelectorAll("#sharing-list li")].some((li) => li.querySelector(".who")!.textContent!.startsWith("ada"))), 5000, "taking them off unlists them");
  const order = await page.evaluate(() => [...document.querySelectorAll(".chrome-top .icon-btn:not([hidden]), .chrome-top .mode")].map((e) => e.id).join(" "));
  // New document (+), clone, then the editor's own (pause, track changes, share, document settings, view), then edit.
  expect(order).toBe("btn-new btn-clone btn-pause btn-track btn-share btn-settings mode btn-edit");
  await page.keyboard.press("Escape");
});

test("the view switcher: each view has the controls' own tooltip; a click on the document closes it, the view still the page", async ({ tab }) => {
  const page = tab.page;
  await editing(page);
  await clickOn(page, '#mode button[aria-checked="true"]');
  await expect.poll(() => page.evaluate(() => document.getElementById("mode")!.classList.contains("open"))).toBe(true);
  const tips = await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("#mode button")].map((b) => b.dataset.tip + "|" + (b.title || "")));
  expect(tips.length).toBe(3);
  for (const t of tips) expect(t).toMatch(/^(Page|Markdown|HTML).*\|$/);
  await page.mouse.click(550, 500);
  await expect.poll(() => page.evaluate(() => document.getElementById("mode")!.classList.contains("open"))).toBe(false);
  expect(await page.evaluate(() => document.body.classList.contains("source"))).toBe(false);
  expect(await page.evaluate(() => (document.querySelector('#mode button[aria-checked="true"]') as HTMLElement).dataset.mode)).toBe("text");
});

test("the pencil switches between viewing and editing without a reload, the document where it was, nothing bouncing past its ends; Back goes to the viewer", async ({ tab }) => {
  const page = tab.page;
  const at = await editing(page);
  const h1 = async () => (await inPage<number | null>(page, `document.querySelector("h1") ? Math.round(document.querySelector("h1").getBoundingClientRect().top) : null`)).find((t) => t != null) ?? null;
  const visible = (sel: string) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).visibility != "hidden" && getComputedStyle(el).opacity == "1"; }, sel);
  // Neither the document nor anything around it bounces past its ends (macOS's rubber band), so the controls never move.
  const still = `getComputedStyle(document.documentElement).overscrollBehaviorY`;
  const bounce = async () => [await page.evaluate(still) as string, ...(await inFrames<string>(page, still)), ...(await inPage<string>(page, still))].filter((v) => v != null);
  const editingTop = await until(h1, 5000, "the page shows in the editor");
  for (const v of await bounce()) expect(v, "editing, overscroll").toBe("none");
  await page.evaluate(() => { (window as any).__samePage = true; });
  await clickOn(page, "#btn-edit");
  await until(async () => (await page.evaluate(() => location.pathname + location.hash)) == at.replace(/#edit$/, "") && await visible(".erga-view-buttons") && !(await visible("#erga-editor")), 5000, "the pencil goes back to the viewer");
  await until(async () => (await h1()) != null, 5000, "the viewer's page shows");
  const viewing = await bounce();
  expect(viewing.length).toBeGreaterThanOrEqual(3);
  for (const v of viewing) expect(v, "viewing, overscroll").toBe("none");
  expect(await visible(".erga-crumbs"), "viewing, the viewer's breadcrumbs").toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("nav-docs")!).visibility)).toBe("hidden");
  expect(await h1()).toBe(editingTop);
  await clickOn(page, ".erga-edit-button");
  await until(async () => (await page.evaluate(() => location.pathname + location.hash)) == at && await visible("#erga-editor") && !(await visible(".erga-view-buttons")), 5000, "the pencil goes back into the editor");
  expect(await page.evaluate(() => (window as any).__samePage === true), "neither reloaded the page").toBe(true);
  await page.evaluate(() => history.back());
  await until(async () => (await page.evaluate(() => location.pathname + location.hash)) == at.replace(/#edit$/, "") && await visible(".erga-view-buttons"), 5000, "Back goes to the viewer too");
});
