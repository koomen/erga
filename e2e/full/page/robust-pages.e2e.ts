// Pages with their own parts (the robustness hunt): a <details>, the page's own contenteditable, an extension's
// span in the text. Keys only, checked by what the page shows.
import { expect, knownBug, servers, test, until } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

// Known bug: the page's own contenteditable box shows what the person types, but the editor does not save it.
// After a reload the text is gone.
test(
  "text typed in the page's own contenteditable box is still there after a reload",
  knownBug(async ({ tab }) => {
    const ed = await openEditor(tab, await servers.main(), "robust-page");
    await ed.clickEnd("#own");
    await ed.type(" XY");
    await ed.source();
    await tab.page.reload();
    await ed.loaded();
    expect(await ed.textOf("#own")).toBe("Own editable XY");
  })
);

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

// Known bug: an extension (as Grammarly did) wraps some of a paragraph's text in its own <span>. After that, the keys
// typed in that paragraph are lost: the caret stays, and no text comes.
test(
  "keys typed after an extension wraps a word in a <span> show in the paragraph",
  knownBug(async ({ tab }) => {
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
  })
);
