// ⌘B on an HTML page (tests/page.ts, "HTML page").
import { expect, servers, test } from "../fixtures";
import { openEditor } from "../editor";

await servers.main();

test("⌘B wraps the selection in <strong>, and again takes it off", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.selectChars("li:last-child", 1);
  await ed.press("ControlOrMeta+b");
  await expect.poll(() => ed.source()).toMatch(/<li><strong>A<\/strong> <strong>new<\/strong> editor<\/li>/);
  await ed.press("ControlOrMeta+b");
  await expect.poll(() => ed.source()).toMatch(/<li>A <strong>new<\/strong> editor<\/li>/);
});
