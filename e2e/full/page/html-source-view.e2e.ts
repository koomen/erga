// The source view, ⌘⇧P ("HTML page").
import { expect, servers, test } from "../../helpers/fixtures";
import { DISK_MS, F, openEditor } from "../../helpers/editor";

await servers.main();

test("⌘⇧P shows the file, and again goes back to a page that edits", { timeout: 45_000 }, async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  ed.write(ed.disk().replace("Where the leads go.", "Where leads go now."));
  await expect.poll(() => ed.textOf("figcaption"), { timeout: DISK_MS }).toBe("Where leads go now.");
  await ed.press("ControlOrMeta+Shift+p");
  await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("source")`)).toBe(true);
  expect(await ed.source()).toContain("Where leads go now.");
  await ed.press("ControlOrMeta+Shift+p");
  await expect
    .poll(
      async () =>
        !(await ed.eval<boolean>(`document.body.classList.contains("source")`)) &&
        (await ed.frame<boolean>(`!!${F}.querySelector("h1[data-erga-text]")`))
    )
    .toBe(true);
  // A click right away puts the caret where it lands: the editor doesn't move it back afterwards.
  await ed.clickEnd("h1");
  await ed.type("!");
  await expect.poll(() => ed.textOf("h1")).toBe("Launch notes!");
});

test("the source view is the file, editable, as code (smaller monospace, lines not wrapped); Esc goes back to the page", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.press("ControlOrMeta+Shift+p");
  await expect.poll(() => ed.eval<string | null>(`document.querySelector("#source .cm-content")?.getAttribute("contenteditable") ?? null`)).toBe("true");
  await ed.settle();
  expect(await ed.eval<boolean>(`(() => { const c = document.querySelector("#source .cm-content"); return getComputedStyle(c).fontSize == "13px" && !c.classList.contains("cm-lineWrapping"); })()`)).toBe(true);
  await ed.press("Escape");
  await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("source")`)).toBe(false);
});

test("the source view types HTML as code: a tag brings its closing tag, Enter indents, and names and comments have their colors", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.press("ControlOrMeta+Shift+p");
  await expect
    .poll(() => ed.eval<string | null>(`document.querySelector("#source .cm-content")?.getAttribute("contenteditable") ?? null`))
    .toBe("true");
  await ed.settle();
  const end = async () => (await ed.source()).slice((await ed.source()).indexOf("</html>\n") + 8);
  await ed.press("ControlOrMeta+End");
  await ed.type("<section>");
  await expect.poll(end).toBe("<section></section>");
  await ed.press("Enter");
  await ed.type("<p>hi");
  await expect.poll(end).toBe("<section>\n  <p>hi</p>\n</section>");
  await ed.press("End");
  await ed.press("Enter");
  await ed.type("<ul>");
  await ed.press("Enter");
  await expect.poll(end).toBe("<section>\n  <p>hi</p>\n  <ul>\n    \n  </ul>\n</section>");
  // "</" closes the innermost open element.
  await ed.type("<li>x");
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await ed.press("Backspace");
  await ed.press("Backspace");
  await ed.press("Backspace");
  await ed.press("Backspace");
  await ed.press("Backspace");
  await ed.type("</");
  await expect.poll(end).toBe("<section>\n  <p>hi</p>\n  <ul>\n    <li>x</li>\n  </ul>\n</section>");
  await ed.press("ControlOrMeta+End");
  await ed.type("\n<!-- a note -->");
  await expect.poll(end).toBe("<section>\n  <p>hi</p>\n  <ul>\n    <li>x</li>\n  </ul>\n</section>\n<!-- a note -->");
  // The colors: a tag's brackets and a comment pale, names and values darker than the text, a comment in italics.
  const look = (text: string) =>
    ed.eval<string[]>(
      `(() => { const s = [...document.querySelectorAll("#source .cm-line span")].find((s) => s.textContent == ${JSON.stringify(text)}); const c = s && getComputedStyle(s); return c ? [c.color, c.fontStyle] : []; })()`
    );
  const text = await ed.eval<string>(`getComputedStyle(document.querySelector("#source .cm-content")).color`);
  const [bracket] = await look("<"),
    [name] = await look("html"),
    [value] = await look('"en"');
  expect(new Set([text, bracket, name]).size).toBe(3);
  expect(value).toBe(name);
  expect(await look("<!-- a note -->")).toEqual([bracket, "italic"]);
});
