// Track changes: every change, yours or from disk, marked as a diff from when it was switched on (tests/page.ts, "HTML page").
import { expect, servers, test } from "../fixtures";
import { openEditor } from "../editor";

test.beforeAll(async () => { await servers.main(); });

test("tracking marks your edits and the disk's; it's a diff, so typing and deleting leaves no mark; a letter added marks the letter; off clears it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.eval(`document.getElementById("btn-track").click()`);
  await ed.clickEnd("h1");
  await ed.type(" too");
  ed.write(ed.disk().replace("Where the leads go.", "Where leads go."));
  await expect.poll(async () => { const m = await ed.marks(); return m.added.some((x) => /too/.test(x)) && m.gone.join("|").trim() == "Edited on diskthe"; }).toBe(true);
  for (let i = 0; i < 4; i++) await ed.press("Backspace");
  await expect.poll(async () => { const m = await ed.marks(); return !m.added.some((x) => /too/.test(x)) && m.gone.length == 1; }).toBe(true);
  await ed.type("s");
  await expect.poll(async () => { const m = await ed.marks(); return m.added.includes("s") && !m.added.some((x) => /notess/.test(x)) && m.gone.length == 1; }).toBe(true);
  await ed.press("Backspace");
  await ed.eval(`document.getElementById("btn-track").click()`);
  await expect.poll(async () => { const m = await ed.marks(); return m.added.length + m.gone.length; }).toBe(0);
});
