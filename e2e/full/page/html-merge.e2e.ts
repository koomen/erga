// Typing and an edit on disk at the same moment ("HTML page").
import { expect, servers, test, until } from "../../helpers/fixtures";
import { DISK_MS, openEditor } from "../../helpers/editor";

await servers.main();

test("typing and a disk edit at once: both survive, unmarked; ⌘Z takes back the typing only, ⌘⇧Z brings it back", {
  timeout: 45_000,
}, async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  ed.write(ed.disk().replace("Where the leads go.", "Where the leads went."));
  await expect.poll(() => ed.textOf("figcaption"), { timeout: DISK_MS }).toBe("Where the leads went.");
  await ed.clickEnd("h1");
  await ed.type(" now");
  await ed.watchMarks();
  ed.write(ed.disk().replace("Where the leads went.", "Where the leads go now."));
  await until(
    async () => (await ed.textOf("figcaption")) == "Where the leads go now.",
    DISK_MS,
    "the disk's edit shows",
    async () => ({ caption: await ed.textOf("figcaption"), h1: await ed.textOf("h1") })
  );
  expect(await ed.seenMarks()).toEqual([]);
  await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toMatch(/ now<\/h1>[\s\S]*leads go now\./);
  expect(await ed.textOf("h1")).toMatch(/ now$/);
  expect(await ed.textOf("figcaption")).toBe("Where the leads go now.");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.textOf("h1")).not.toMatch(/ now$/);
  expect(await ed.textOf("figcaption")).toBe("Where the leads go now.");
  await ed.press("ControlOrMeta+Shift+z");
  await expect.poll(() => ed.textOf("h1")).toMatch(/ now$/);
});
