// Edits made to the file on disk reach the open page ("HTML page").
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test } from "../../helpers/fixtures";
import { DISK_MS, F, openEditor, TIMESCALE } from "../../helpers/editor";

await servers.main();

test("a disk edit reaches the page, patched in place, with the change marked exactly, and the marks fade", { timeout: 45_000 }, async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  ed.write(ed.disk().replace("Where the leads go.", "Where the leads went."));
  await expect.poll(() => ed.textOf("figcaption"), { timeout: DISK_MS }).toBe("Where the leads went.");
  expect(await ed.count("[data-erga-text]")).toBeGreaterThanOrEqual(9);
  expect(await ed.frame<boolean>(`!!${F}.querySelector("figcaption.erga-flash")`)).toBe(false);
  const m = await ed.marks();
  expect(m.added.join("|")).toBe("went");
  expect(m.gone.join("|")).toBe("Edited on diskgo");
  expect(await ed.textOf("figcaption")).toBe("Where the leads went.");
  // The marks fade: 3.2 s of the editor's time.
  await expect.poll(async () => { const m = await ed.marks(); return m.added.length + m.gone.length; }, { timeout: 3200 * TIMESCALE + 3000 }).toBe(0);
});

test("a diagram added on disk shows up without a reload, and the page still edits", { timeout: 45_000 }, async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  ed.write(ed.disk().replace("<h2>What changed</h2>", `<svg id="diagram" width="80" height="20"><rect width="80" height="20" fill="#c00"/></svg>\n    <h2>What changed</h2>`));
  await expect.poll(() => ed.frame<boolean>(`!!${F}.getElementById("diagram")`), { timeout: DISK_MS }).toBe(true);
  await expect.poll(() => ed.count("[data-erga-text]")).toBeGreaterThanOrEqual(9);
});

test("a change to the page's stylesheet reaches the page", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const css = join(ed.dir, "style.css");
  writeFileSync(css, readFileSync(css, "utf8") + "\nh1 { letter-spacing: 3px; }\n");
  await expect.poll(() => ed.frame<string>(`getComputedStyle(${F}.querySelector("h1")).letterSpacing`)).toBe("3px");
});
