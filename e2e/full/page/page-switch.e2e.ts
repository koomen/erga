// Another of the document's pages, picked while editing, opens in place (main.ts, swapPage): the editor's controls, the
// agent's pane (open) and the document's place beside it stay as they are, in every frame, and never the viewer's
// controls; only the page in the frame changes. The address follows, and Back and Forward go between the pages the same way.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test } from "../../fixtures";
import { F, openEditor } from "../../editor";
import { row } from "../tree/tree";

await servers.main();

test("a page picked in the pages card opens in the editor in place, and Back and Forward go between them", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "multi", { agent: true });
  const page = tab.page;
  await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("agent-open")`)).toBe(true);
  const frameAt = () => ed.eval<number>(`document.getElementById("frame").getBoundingClientRect().left`);
  // (Once the pane has opened: the document moves aside as it does.)
  let left = -1;
  await expect.poll(async () => { const was = left; left = await frameAt(); await ed.settle(); return was == left && left > 100; }).toBe(true);
  const h1 = () => ed.frame<string | null>(`${F}?.querySelector("h1")?.textContent ?? null`).catch(() => null);
  const path = () => new URL(page.url()).pathname;
  const home = path();

  // What each frame of the tab shows from here on: the editor's controls or the viewer's, the pane, the document's place.
  // (A mark on the window: gone if the tab loads a page.)
  await ed.eval(`(() => {
    window.__same = true;
    const seen = window.__seen = [];
    const tick = () => {
      const wrap = document.getElementById("erga-editor"), viewer = document.querySelector(".erga-view-buttons");
      seen.push({
        editor: !!wrap && getComputedStyle(wrap).opacity == "1",
        viewer: !!viewer && getComputedStyle(viewer).visibility != "hidden" && getComputedStyle(viewer).opacity != "0",
        agent: document.body.classList.contains("agent-open"),
        left: Math.round(document.getElementById("frame").getBoundingClientRect().left),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  // In the editor's frame: whether a page shows, with its heading (never an empty place between the two pages).
  await ed.frame(`(() => {
    const shown = window.__shown = [];
    const tick = () => {
      shown.push([...document.querySelectorAll("iframe")].some((f) => getComputedStyle(f).visibility == "visible" && f.getBoundingClientRect().width > 0 && !!f.contentDocument?.querySelector("h1")?.textContent));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  await page.click("#doc-title");
  await page.click(`#pages ${row("about.html")}`);
  await expect.poll(h1).toBe("About us");
  await expect.poll(() => ed.eval<string>(`ergaPage.pagePath`)).toBe("about.html");
  expect(path()).toBe(`${home}/about`);
  expect(new URL(page.url()).hash).toBe("#edit");

  // The same page all along: from the click to the new page, the editor's controls, the pane open, the document in its place.
  expect(await ed.eval<boolean>(`window.__same === true`)).toBe(true);
  const seen = await ed.eval<{ editor: boolean; viewer: boolean; agent: boolean; left: number }[]>(`window.__seen`);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((s) => !s.editor || s.viewer || !s.agent)).toEqual([]);
  expect([...new Set(seen.map((s) => s.left))]).toEqual([Math.round(left)]);
  expect(await ed.eval<boolean>(`document.getElementById("pages").hidden`)).toBe(true);
  const shown = await ed.frame<boolean[]>(`window.__shown`);
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.filter((s) => !s).length).toBe(0);

  // The new page is the one edited: typing goes to its file, and the first page's stays as it was.
  const dir = ed.dir, before = readFileSync(join(dir, "index.html"), "utf8");
  await ed.idle();
  await ed.clickEnd("h1");
  await ed.type("!");
  await expect.poll(() => readFileSync(join(dir, "about.html"), "utf8")).toContain("About us!");
  expect(readFileSync(join(dir, "index.html"), "utf8")).toBe(before);

  // Back: the first page, in place; Forward: the second again.
  await page.goBack();
  await expect.poll(h1).toBe("Field guide");
  expect(path()).toBe(home);
  await page.goForward();
  await expect.poll(h1).toBe("About us!");
  expect(path()).toBe(`${home}/about`);
  expect(await ed.eval<boolean>(`window.__same === true && document.body.classList.contains("agent-open")`)).toBe(true);
});
