// Pages with their own parts (the robustness hunt): a <details>, the page's own contenteditable, an extension's
// span in the text. Keys only, checked by what the page shows.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

// The page's own contenteditable box is text like any other: the editor saves what the person types in it (the text
// was gone after a reload).
test("text typed in the page's own contenteditable box is still there after a reload", async ({ tab }) => {
    const ed = await openEditor(tab, await servers.main(), "robust-page");
    await ed.clickEnd("#own");
    await ed.type(" XY");
    await ed.source();
    await tab.page.reload();
    await ed.loaded();
    expect(await ed.textOf("#own")).toBe("Own editable XY");
  });

// The page's own contenteditable box marked data-erga-noedit is the page's: the browser edits it as the page wrote it,
// with no note that it is not editable, and the editor never saves it (Pete's decision).
test("text typed in the page's own contenteditable box marked data-erga-noedit shows, and the file does not change", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "robust-page");
  const before = await ed.source();
  await ed.clickEnd("#scratch p");
  await ed.type(" XY");
  await expect.poll(() => ed.textOf("#scratch")).toBe("Scratch XY");
  expect((await ed.toast()).shown).toBe(false);
  await ed.settle();
  expect(await ed.source()).toBe(before);
  // The text around it still edits.
  await ed.clickEnd("#last");
  await ed.type("!");
  await expect.poll(() => ed.source()).toContain("Last paragraph.!</p>");
});

// Enter at the end of a <summary> keeps one summary (a browser uses only the first): the new paragraph goes into the
// <details> if they are open, else after them, and the next key goes there.
test("Enter at the end of a <details> summary keeps one summary, and the next key shows after it", async ({ tab }) => {
    const ed = await openEditor(tab, await servers.main(), "robust-page");
    await ed.clickEnd("#sum");
    await ed.press("Enter");
    await ed.type("X");
    await ed.idle();
    expect(await ed.count("summary")).toBe(1);
    expect(await ed.textOf("#sum")).toBe("More info");
});

// An extension (as Grammarly did) wraps some of a paragraph's text in its own <span>. The keys typed in that paragraph
// still show (they were lost): the editor draws the paragraph again from its HTML, without the extension's <span>.
test("keys typed after an extension wraps a word in a <span> show in the paragraph", async ({ tab }) => {
    const ed = await openEditor(tab, await servers.main(), "robust-page");
    await ed.clickEnd("#last");
    await ed.type("12");
    await ed.frame(
      `(() => { const t = document.getElementById("last").firstChild, r = document.createRange(); r.setStart(t, 1); r.setEnd(t, 3); const s = document.createElement("span"); s.className = "gr_ gr-alert"; r.surroundContents(s); return true; })()`
    );
    await ed.type("34");
    await until(
      async () => (await ed.textOf("#last")) == "Last paragraph.1234",
      3000,
      "the paragraph shows the keys",
      () => ed.textOf("#last")
    );
});
