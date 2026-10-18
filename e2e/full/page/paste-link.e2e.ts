// A URL pasted over selected text links that text ("Styling and views").
import { expect, servers, test } from "../../fixtures";
import { F, openEditor, type Editor } from "../../editor";

await servers.main();

const paste = (ed: Editor, text: string) => ed.frame(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(text)}); ${F}.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);

test("on an HTML page, text pasted over a selection replaces it; a URL pasted over selected text links it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.selectChars("p.lede", 3);
  await paste(ed, "not a url");
  await expect.poll(() => ed.source()).toMatch(/<p class="lede">not a urlld /);
  await ed.idle();
  await ed.selectChars("h1", 6);
  await paste(ed, " https://example.com/a?b=1&c=2 ");
  await expect.poll(() => ed.source()).toContain(`<h1><a href="https://example.com/a?b=1&amp;c=2">Launch</a> notes</h1>`);
});

test("on a Markdown page, a URL pasted over selected text links it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await ed.selectChars("h1", 5);
  await paste(ed, "https://example.com");
  await expect.poll(() => ed.source()).toContain("\n# [Field](https://example.com) notes\n");
});
