// The link bar ("Styling and views"): the style bar's link button turns it into the bar that edits a link's text,
// address and where it opens; a click in a link shows it too, and typing at a link's ends joins it or ends it.
// And for readers: a link that leaves the document opens a new tab, unless its author set it to open in this one.
import { expect, servers, test } from "../../fixtures";
import { openEditor, type Editor } from "../../editor";
import { inPage, openViewer } from "../viewer/viewer";

await servers.main();

const shell = <T>(ed: Editor, expr: string) => ed.eval<T>(expr);
const linkBar = (ed: Editor) => shell<boolean>(ed, `!document.getElementById("fmt").hidden && !document.getElementById("fmt-link").hidden && !document.querySelector(".fmt.morphing")`);
const styleBar = (ed: Editor) => shell<boolean>(ed, `!document.getElementById("fmt").hidden && !document.getElementById("fmt-style").hidden && !document.querySelector(".fmt.morphing")`);
const field = (ed: Editor, id: string) => shell<string>(ed, `document.getElementById(${JSON.stringify(id)}).value`);
const press = (ed: Editor, sel: string) => shell(ed, `document.querySelector(${JSON.stringify(sel)}).click()`);

test("a click in a link puts the caret there and shows the link bar, without following the link; letters at its ends join it, a space ends it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const url = tab.page.url();
  const at = await ed.charAt("p.lede a", 2);
  await ed.click(at.x, at.y);
  await expect.poll(() => linkBar(ed)).toBe(true);
  expect(await field(ed, "fmt-link-url")).toBe("https://example.com");
  expect(await field(ed, "fmt-link-text")).toBe("a link");
  expect(tab.page.url()).toBe(url);
  // The focus stayed in the page: typing goes into the link, and the bar follows it.
  await ed.type("X");
  await expect.poll(() => ed.source()).toContain(`<a href="https://example.com">a Xlink</a>`);
  await expect.poll(() => field(ed, "fmt-link-text")).toBe("a Xlink");
  // At its end.
  for (let i = 0; i < 4; i++) await ed.press("ArrowRight");
  await ed.type("s");
  await expect.poll(() => ed.source()).toContain(`>a Xlinks</a> and`);
  await ed.type(" ok");
  await expect.poll(() => ed.source()).toContain(`>a Xlinks</a> ok and`);
  // At its start.
  const start = await ed.charAt("p.lede a", 0);
  await ed.click(start.x - 1, start.y);
  await ed.type("Z");
  await expect.poll(() => ed.source()).toContain(`has <a href="https://example.com">Za Xlinks</a>`);
});

test("the link button turns the style bar into the link bar; Enter links the selection, opening in this tab; × goes back; a click on the new link doesn't follow it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const url = tab.page.url();
  await ed.selectChars("h1", 6);
  await expect.poll(() => styleBar(ed)).toBe(true);
  await press(ed, "#fmt [data-act=link]");
  await expect.poll(() => linkBar(ed)).toBe(true);
  expect(await shell<string>(ed, "document.activeElement.id")).toBe("fmt-link-url");
  expect(await field(ed, "fmt-link-text")).toBe("Launch");
  await ed.type("erga.dev/plan");
  await press(ed, "#fmt [data-link=tab]");
  await ed.press("Enter");
  await expect.poll(() => ed.source()).toContain(`<h1><a href="https://erga.dev/plan" target="_self">Launch</a> notes</h1>`);
  await expect.poll(() => styleBar(ed)).toBe(true);
  // The link bar again, for the link that's there now; × goes back to the style bar and changes nothing.
  await press(ed, "#fmt [data-act=link]");
  await expect.poll(() => linkBar(ed)).toBe(true);
  expect(await field(ed, "fmt-link-url")).toBe("https://erga.dev/plan");
  expect(await shell<string>(ed, `document.querySelector("#fmt [data-link=tab]").getAttribute("aria-checked")`)).toBe("false");
  await press(ed, "#fmt [data-link=close]");
  await expect.poll(() => styleBar(ed)).toBe(true);
  expect(await ed.source()).toContain(`<h1><a href="https://erga.dev/plan" target="_self">Launch</a> notes</h1>`);
  // A click on the new link: the caret and the link bar, and the editor stays.
  const at = await ed.charAt("h1 a", 3);
  await ed.click(at.x, at.y);
  await expect.poll(() => linkBar(ed)).toBe(true);
  await tab.page.waitForTimeout(300);
  expect(tab.page.url()).toBe(url);
  expect(await shell<string>(ed, `document.querySelector("#fmt [data-link=tab] .fmt-label").textContent`)).toBe("Opens in this tab");
});

test("the link bar changes a link's text; Esc closes it until a click in the link; it removes the link", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const at = await ed.charAt("p.lede a", 2);
  await ed.click(at.x, at.y);
  await expect.poll(() => linkBar(ed)).toBe(true);
  await shell(ed, `document.getElementById("fmt-link-text").focus()`);
  await ed.press("ControlOrMeta+a");
  await ed.type("the example");
  await ed.press("Enter");
  await expect.poll(() => ed.source()).toContain(`has <a href="https://example.com">the example</a> and`);
  // Esc closes the link bar while the caret stays in the link; a click there opens it again.
  const again = await ed.charAt("p.lede a", 3);
  await ed.click(again.x, again.y);
  await expect.poll(() => linkBar(ed)).toBe(true);
  await ed.press("Escape");
  await expect.poll(() => shell<boolean>(ed, `document.getElementById("fmt").hidden`)).toBe(true);
  await ed.click(again.x, again.y);
  await expect.poll(() => linkBar(ed)).toBe(true);
  await press(ed, "#fmt [data-link=remove]");
  await expect.poll(() => ed.source()).toContain("This paragraph has the example and");
});

test("a click in the page while the link bar is open applies it to its own selection, not where the click goes; Esc applies nothing", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.selectChars("h1", 6);
  await press(ed, "#fmt [data-act=link]");
  await expect.poll(() => linkBar(ed)).toBe(true);
  await ed.type("erga.dev/a");
  await ed.press("Escape");
  await expect.poll(() => styleBar(ed)).toBe(true);
  await press(ed, "#fmt [data-act=link]");
  await expect.poll(() => linkBar(ed)).toBe(true);
  await ed.type("erga.dev/b");
  // A click in the other link: the new link is the heading's, and the other link stays as it was.
  const at = await ed.charAt("p.lede a", 2);
  await ed.click(at.x, at.y);
  await expect.poll(() => ed.source()).toContain(`<h1><a href="https://erga.dev/b">Launch</a> notes</h1>`);
  const src = await ed.source();
  expect(src).toContain(`has <a href="https://example.com">a link</a> and`);
  expect(src).not.toContain("erga.dev/a");
});

test("for readers, a link that leaves the document opens a new tab; one set to open in this tab takes the tab", async ({ tab }) => {
  const server = await servers.main();
  const page = tab.page;
  const { address } = await server.fixture("page");
  await openViewer(page, address);
  await expect.poll(async () => (await inPage<number>(page, `document.querySelectorAll("p.lede a").length`))[0]).toBe(1);
  const popup = page.context().waitForEvent("page");
  await inPage(page, `document.querySelector("p.lede a").click()`);
  expect((await popup).url()).toContain("example.com");
  // In this tab: a reader's click (a real one) takes the whole tab, not the page's frame.
  const away = address + (address.includes("?") ? "&" : "?") + "went=1";
  await inPage(page, `(() => { const a = document.querySelector("p.lede a"); a.href = ${JSON.stringify(away)}; a.target = "_self"; return 1; })()`);
  const box = await page.evaluate(() => { const r = document.getElementById("frame")!.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  const r = (await inPage<{ x: number; y: number }>(page, `(() => { const b = document.querySelector("p.lede a").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`))[0];
  await page.mouse.click(box.x + r.x, box.y + r.y);
  await expect.poll(() => page.url()).toContain("went=1");
});
