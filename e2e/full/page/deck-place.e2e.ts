// A deck keeps its slide in its own address's hash (agents/document/PROMPT.md, rule 11): the tab's address shows it, so
// a reload by hand, the editor's own reload of the page (a change it can't patch in), and the link in another tab all open
// at that slide. A page with no hash logic is as before.
import { editor, F, openEditor } from "../../helpers/editor";
import { agentTools } from "./view-page";
import { expect, servers, test } from "../../helpers/fixtures";

await servers.main();

const THIRD = `
  # Third slide

  The last one.
`;

test("at slide 3, a reload of the tab opens the editor at slide 3; the tab's address says #3", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "deck");
  // Escape: the keys go to the page, and its arrows move between slides.
  await ed.press("Escape");
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
  // Escape: the keys go to the page, and its arrows move between slides.
  await ed.press("Escape");
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await ed.clickEnd(".current h1");
  await ed.shows(`
    # Third slide|

    The last one.
  `);
  await ed.frame(`window.__before = true`);
  // The page made afresh, as for a change the editor can't patch in: it loads again, in a new window.
  await ed.frame(`ergaFrame.page.render()`);
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
  // Escape: the keys go to the page, and its arrows move between slides.
  await ed.press("Escape");
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

// view_page and eval_in_page render the page in the server's browser, at its own address on the document's pages
// origin. Rule 14's example, as written, runs there too, and the page's own moves change its hash.
test("in view_page's render, rule 11's example runs with no error, and a hash moves the deck", async ({ tab }) => {
  const s = await servers.main();
  const ed = await openEditor(tab, s, "deck");
  const { tool } = await agentTools(s, ed.address);
  const at = await tool("eval_in_page", {
    expression: `({ hash: location.hash, slide: document.querySelector(".slide.current h1").textContent })`,
  });
  expect(at.text).not.toContain("error(s)");
  expect(JSON.parse(at.text.split("\n\n")[0])).toEqual({ hash: "#1", slide: "First slide" });
  // The page's own moves, in the same render: a key, location.hash, a link to a hash, and pushState.
  const moved = await tool("eval_in_page", {
    expression: `const out = [], h1 = () => document.querySelector(".slide.current h1").textContent;
     document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
     out.push(location.hash, h1());
     location.hash = "3";
     out.push(location.hash);
     const a = document.createElement("a"); a.href = "#2"; a.textContent = "two"; document.body.append(a); a.click();
     await new Promise((r) => setTimeout(r, 50));
     out.push(location.hash, document.querySelectorAll(".slide").length);
     history.pushState(null, "", "#1");
     out.push(location.hash);
     return out;`,
  });
  expect(moved.text).not.toContain("error(s)");
  expect(JSON.parse(moved.text.split("\n\n")[0])).toEqual(["#2", "Second slide", "#3", "#2", 3, "#1"]);
});
