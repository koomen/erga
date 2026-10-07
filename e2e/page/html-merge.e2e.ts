// Typing and an edit on disk at the same moment (tests/page.ts, "HTML page").
import { expect, servers, test } from "../fixtures";
import { openEditor } from "../editor";

test.beforeAll(async () => { await servers.main(); });

test("typing and a disk edit at once: both survive, marked; ⌘Z takes back the typing only, ⌘⇧Z brings it back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  ed.write(ed.disk().replace("Where the leads go.", "Where the leads went."));
  await expect.poll(() => ed.textOf("figcaption")).toBe("Where the leads went.");
  await ed.clickEnd("h1");
  await ed.type(" now");
  ed.write(ed.disk().replace("Where the leads went.", "Where the leads go now."));
  // Marks are brief (the timescale makes them briefer): looked for as the edit lands.
  await expect.poll(async () => (await ed.marks()).added.some((x) => /go now/.test(x))).toBe(true);
  await expect.poll(() => ed.disk()).toMatch(/ now<\/h1>[\s\S]*leads go now\./);
  expect(await ed.textOf("h1")).toMatch(/ now$/);
  expect(await ed.textOf("figcaption")).toBe("Where the leads go now.");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.textOf("h1")).not.toMatch(/ now$/);
  expect(await ed.textOf("figcaption")).toBe("Where the leads go now.");
  await ed.press("ControlOrMeta+Shift+z");
  await expect.poll(() => ed.textOf("h1")).toMatch(/ now$/);
});
