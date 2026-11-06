// The editor in the page runs only while editing, on the page itself (not its source), out of full screen, with an edit
// key (client/shell/editor-state.ts decides it). Each test watches what the shell tells the page: "edit" or "view".
import type { Page } from "playwright-core";
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

/** From now on, the page keeps the words the shell tells it. */
const watch = (ed: Editor) =>
  ed.frame(
    `(() => { window.__said = []; addEventListener("message", (e) => { const t = e.data?.type; if (t == "erga-mode") __said.push(e.data.mode); else if (t == "erga-test-mark") __said.push("mark"); }); return true; })()`
  );
/** The words the page got since `watch`, up to a mark the shell sends after all it has to do now. */
async function said(ed: Editor): Promise<string[]> {
  await ed.frame(`(() => { __said = __said.filter((w) => w != "mark"); return true; })()`);
  await ed.eval(
    `new Promise((done) => setTimeout(() => { document.getElementById("frame").contentWindow.postMessage({ type: "erga-test-mark" }, "*"); done(true); }))`
  );
  await expect.poll(() => ed.frame<boolean>(`__said.includes("mark")`)).toBe(true);
  return ed.frame<string[]>(`__said.slice(0, __said.indexOf("mark"))`);
}
/** The page's editor runs. */
const runs = (ed: Editor) => ed.frame<boolean>(`${F}.documentElement.hasAttribute("data-erga-editing")`);
const shell = (page: Page, cls: string) => page.evaluate((c) => document.body.classList.contains(c), cls);

test("⌘⇧P, then the eye: the page's editor stays stopped in the viewer; the pencil starts it again", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const page = tab.page;
  await ed.press("ControlOrMeta+Shift+p");
  await expect.poll(() => shell(page, "source")).toBe(true);
  await watch(ed);
  await page.locator("#btn-edit").click();
  await expect.poll(async () => !(await shell(page, "erga-editing")) && !(await shell(page, "source"))).toBe(true);
  expect(await said(ed)).not.toContain("edit");
  await expect.poll(() => runs(ed)).toBe(false);
  await page.locator(".erga-edit-button").click();
  await expect.poll(() => runs(ed)).toBe(true);
  expect(await said(ed)).toEqual(["edit"]);
});

test("⌘⇧P, then full screen: the page's editor stays stopped, the arrows step the deck; out of full screen it runs again", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "deck");
  const page = tab.page;
  await ed.press("ControlOrMeta+Shift+p");
  await expect.poll(() => shell(page, "source")).toBe(true);
  await watch(ed);
  await page.locator("#btn-full").click();
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("erga-full"))).toBe(true);
  await expect.poll(() => shell(page, "source")).toBe(false);
  expect(await said(ed)).not.toContain("edit");
  await expect.poll(() => runs(ed)).toBe(false);
  await ed.press("ArrowRight");
  await expect.poll(() => ed.eval<string>(`location.hash`)).toBe("#2");
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => runs(ed)).toBe(true);
  expect(await said(ed)).toEqual(["edit"]);
});

test("the host refuses the edit key: a note says so, the shell asks again, and the editor starts", async ({ tab }) => {
  const page = tab.page;
  let refuse = true;
  await page.route("**/api/key*", (r) => (refuse ? r.fulfill({ status: 500, body: "no" }) : r.continue()));
  const opening = openEditor(tab, await servers.main(), "page", { allowErrors: true });
  await expect
    .poll(() => page.evaluate(() => document.getElementById("toast")?.textContent ?? ""), { timeout: 8000 })
    .toContain("The editor can't start");
  refuse = false;
  const ed = await opening;
  expect(await runs(ed)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.getElementById("toast")?.textContent ?? "")).toContain("The editor started");
});
