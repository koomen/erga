// Clicking a page opens it in the editor, at its address; folders stay open for the tab ("the editor").
import { expect, servers, test } from "../../fixtures";
import { clickOn, clickToGo, multi, openCard, openTreeEditor, paths, row } from "./tree";

await servers.main();

test("clicking a page goes to its address in the editor (…/contact#edit); back on the document, the folder opened before is still open", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  await clickOn(page, row("blog"));
  await expect.poll(() => paths(page)).toContain("blog/index.html");
  await clickToGo(page, row("contact.html"), `${doc.address}/contact#edit`);
  await openTreeEditor(tab, doc.base);
  await openCard(page, 4);
  expect(await paths(page)).toContain("blog/index.html");
});
