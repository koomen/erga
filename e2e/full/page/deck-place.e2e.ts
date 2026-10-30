// A deck keeps its slide in its own address's hash (agents/document/PROMPT.md, rule 14): the tab's address shows it, so
// a reload by hand, the editor's own reload of the page (a change it can't patch in), and the link in another tab all open
// at that slide. A page with no hash logic is as before.
import { editor, F, openEditor } from "../../helpers/editor";
import { expect, servers, test } from "../../helpers/fixtures";

await servers.main();

const THIRD = `
  # Third slide

  The last one.
`;

test("at slide 3, a reload of the tab opens the editor at slide 3; the tab's address says #3", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "deck");
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await ed.shows(THIRD);
  await expect.poll(() => ed.eval<string>(`location.hash`)).toBe("#3");
  await tab.page.reload();
  await ed.loaded();
  await ed.shows(THIRD);
  expect(await ed.eval<string>(`location.hash`)).toBe("#3");
  expect(await ed.eval<string>(`location.search`)).toBe("?edit");
});

test("at slide 3, the editor's own reload of the page keeps slide 3, and the caret where it was", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "deck");
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await ed.clickEnd(".current h1");
  await ed.shows(`
    # Third slide|

    The last one.
  `);
  await ed.frame(`window.__before = true`);
  // The page made afresh, as for a change the editor can't patch in: it loads again, in a new window.
  await ed.eval(`window.ergaPage.page.render()`);
  await expect.poll(() => ed.frame<boolean>(`!window.__before`)).toBe(true);
  await ed.idle();
  await ed.shows(`
    # Third slide|

    The last one.
  `);
  expect(await ed.eval<string>(`location.hash`)).toBe("#3");
});

test("the tab's address at slide 3, opened in another tab, opens at slide 3: in the editor and for a reader", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "deck");
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await expect.poll(() => ed.eval<string>(`location.hash`)).toBe("#3");
  const url = tab.page.url();
  for (const address of [url, url.replace("?edit", "")]) {
    const other = await tab.page.context().newPage();
    await other.goto(address);
    const frame = () => other.frames().find((f) => f != other.mainFrame());
    await expect
      .poll(
        () =>
          frame()
            ?.evaluate(`document.querySelector(".slide.current h1")?.textContent`)
            .catch(() => null),
        { timeout: 10_000 }
      )
      .toBe("Third slide");
    expect(new URL(other.url()).hash).toBe("#3");
    await other.close();
  }
});

test("a page with no hash logic: a reload keeps the address as it was, with no hash", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "one-line");
  await ed.type("x");
  await expect.poll(() => ed.source()).toContain("<h1>xOne line</h1>");
  await tab.page.reload();
  const again = editor(tab.page, ed);
  await again.loaded();
  expect(await again.eval<string>(`location.hash`)).toBe("");
  expect(await again.eval<string>(`location.search`)).toBe("?edit");
});
