// Typing and an edit on disk at the same moment ("HTML page").
import { expect, servers, test, until } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

test("typing and a disk edit at once: both survive, marked; ⌘Z takes back the typing only, ⌘⇧Z brings it back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  ed.write(ed.disk().replace("Where the leads go.", "Where the leads went."));
  await expect.poll(() => ed.textOf("figcaption")).toBe("Where the leads went.");
  await ed.clickEnd("h1");
  await ed.type(" now");
  // Marks are brief (the timescale makes them briefer): each one is kept as it shows.
  await ed.watchMarks();
  ed.write(ed.disk().replace("Where the leads went.", "Where the leads go now."));
  await until(
    async () => (await ed.seenMarks()).some((x) => /go now/.test(x)),
    5000,
    "the disk's edit shows marked",
    async () => ({ seen: await ed.seenMarks(), now: await ed.marks(), caption: await ed.textOf("figcaption"), h1: await ed.textOf("h1") })
  );
  await expect.poll(() => ed.disk()).toMatch(/ now<\/h1>[\s\S]*leads go now\./);
  expect(await ed.textOf("h1")).toMatch(/ now$/);
  expect(await ed.textOf("figcaption")).toBe("Where the leads go now.");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.textOf("h1")).not.toMatch(/ now$/);
  expect(await ed.textOf("figcaption")).toBe("Where the leads go now.");
  await ed.press("ControlOrMeta+Shift+z");
  await expect.poll(() => ed.textOf("h1")).toMatch(/ now$/);
});
