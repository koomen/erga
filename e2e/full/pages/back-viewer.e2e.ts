// Back after a link in the viewer: the entry before it is the one the pencil left the editor for, so the first page
// shows in the viewer again, and the page, the pencil and the address agree (client/inline/viewer-edit-boot.ts).
import { expect, servers, test } from "../../helpers/fixtures";
import { site, styled, where, ready, PAGE } from "./tree";

await servers.short();

test("editor, pencil off, a link to another page, then Back: the first page in the viewer, not editable, the pencil off", async ({
  tab,
}) => {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  await s.write("index.html", PAGE("Home", `<nav data-erga-noedit><a href="about.html">About</a></nav>\n<h1>Home</h1>`));
  const p = tab.page;
  await p.addInitScript(() => {
    if (window.top == window)
      try {
        localStorage.setItem("erga:settings:v1", '{"agent":false}');
      } catch {
        /* no storage */
      }
  });
  await p.goto(`${server.root}/docs`);
  await p.goto(`${server.root}${s.address}?edit`);
  await expect.poll(() => ready(p)).toBe(true);
  // The pencil, in the upper right: the editor off.
  await p.locator("#btn-edit").click();
  await expect.poll(() => p.evaluate(() => getComputedStyle(document.querySelector(".erga-view-buttons")!).visibility)).toBe("visible");
  await p.frameLocator("#frame").getByRole("link", { name: "About" }).click();
  await expect.poll(async () => `${await where(p)} ${(await styled(p))?.h1}`).toBe(`${s.address}/about About`);

  await p.goBack();
  await expect.poll(async () => `${await where(p)} ${(await styled(p))?.h1}`).toBe(`${s.address} Home`);
  // What the page shows: the viewer's pencil, not pressed, and the editor's controls hidden.
  const shown = () =>
    p.evaluate(() => {
      const pencil = document.querySelector(".erga-edit-button");
      const wrap = document.getElementById("erga-editor");
      return {
        pencil: !!pencil && getComputedStyle(pencil).visibility == "visible" && pencil.getAttribute("aria-pressed") != "true",
        editor: !!wrap && getComputedStyle(wrap).opacity != "0",
      };
    });
  await expect.poll(shown).toEqual({ pencil: true, editor: false });
  // Typing in the page changes nothing; the pencil then opens the editor, and typing goes to the file.
  const h1 = p.frameLocator("#frame").locator("h1");
  await h1.click();
  await p.keyboard.type("X");
  await p.locator(".erga-edit-button").click();
  await expect.poll(() => ready(p)).toBe(true);
  await h1.click();
  await p.keyboard.press("End");
  await p.keyboard.type("!");
  await expect.poll(async () => (await s.tool("read", { path: "index.html" })).text).toContain("<h1>Home!</h1>");
  expect((await styled(p))?.h1).toBe("Home!");
});
