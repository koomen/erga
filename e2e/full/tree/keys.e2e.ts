// Folders open and close by click and by key; ↑ ↓ ← → Home End move ("the editor": open and close a folder).
import { expect, servers, test } from "../../helpers/fixtures";
import { clickOn, focused, multi, openCard, openTreeEditor, paths, press, row } from "./tree";

await servers.main();

test("clicking a folder opens it; ← closes it, → opens it, → again goes in; ↓ moves down; Home and End go to the first and the last", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  await clickOn(page, row("blog"));
  await expect.poll(async () => (await paths(page)).join()).toBe("index.html,assets,blog,blog/drafts,blog/index.html,blog/spring-migration.html,fonts,about.html,contact.html,style.css");
  await press(page, "ArrowLeft");
  await expect.poll(() => paths(page)).not.toContain("blog/drafts");
  await press(page, "ArrowRight");
  await expect.poll(() => paths(page)).toContain("blog/drafts");
  await press(page, "ArrowRight");
  await expect.poll(() => focused(page)).toBe("blog/drafts");
  await press(page, "ArrowDown");
  await press(page, "ArrowDown");
  await expect.poll(() => focused(page)).toBe("blog/spring-migration.html");
  await press(page, "Home");
  await expect.poll(() => focused(page)).toBe("index.html");
  await press(page, "End");
  await expect.poll(() => focused(page)).toBe("style.css");
});
