// Track changes: every change, yours or from disk, marked as a diff from when it was switched on ("HTML page").
import { expect, servers, test } from "../../helpers/fixtures";
import { DISK_MS, openEditor } from "../../helpers/editor";

await servers.main();

test("tracking marks your edits and the disk's; it's a diff, so typing and deleting leaves no mark; a letter added marks the letter; off clears it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.eval(`document.getElementById("btn-track").click()`);
  await ed.clickEnd("h1");
  await ed.type(" too");
  ed.write(ed.disk().replace("Where the leads go.", "Where leads go."));
  await expect
    .poll(
      async () => {
        const m = await ed.marks();
        return m.added.some((x) => /too/.test(x)) && m.gone.join("|").trim() == "Edited on diskthe";
      },
      { timeout: DISK_MS }
    )
    .toBe(true);
  for (let i = 0; i < 4; i++) await ed.press("Backspace");
  await expect.poll(async () => { const m = await ed.marks(); return !m.added.some((x) => /too/.test(x)) && m.gone.length == 1; }).toBe(true);
  await ed.type("s");
  await expect.poll(async () => { const m = await ed.marks(); return m.added.includes("s") && !m.added.some((x) => /notess/.test(x)) && m.gone.length == 1; }).toBe(true);
  await ed.press("Backspace");
  await ed.eval(`document.getElementById("btn-track").click()`);
  await expect.poll(async () => { const m = await ed.marks(); return m.added.length + m.gone.length; }).toBe(0);
});

test("with tracking on, typing hides the top bar with its Track changes button, as with tracking off", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.eval(`document.getElementById("btn-track").click()`);
  expect(await ed.eval<string>(`document.getElementById("btn-track").getAttribute("aria-pressed")`)).toBe("true");
  await ed.clickEnd("h1");
  await ed.type(" too");
  await expect
    .poll(() =>
      ed.eval<string>(
        `document.body.classList.contains("chrome-hidden") && getComputedStyle(document.querySelector(".chrome-top")).opacity`
      )
    )
    .toBe("0");
});
