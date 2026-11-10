// The templates' typefaces (Instrument Sans, Literata) come from Erga itself: the pages origin gives each page their
// @font-face rules, with the files on the app's origin. A new document asks Google for nothing.
import { expect, servers, test } from "../../helpers/fixtures";
import { editorReady, newDoc } from "./templates";

await servers.main();

test("a new document from each template loads its typefaces from Erga, with no request to Google", async ({ tab }) => {
  const page = tab.page;
  const asked: string[] = [];
  page.on("request", (r) => {
    if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) asked.push(r.url());
  });
  for (const id of ["page", "project", "canvas"]) {
    const made = await newDoc(await servers.main(), id);
    await page.goto(`${made.address}?edit`);
    await editorReady(page);
    const frame = page.frames().find((f) => f.parentFrame() == page.mainFrame())!;
    const loaded = () =>
      frame.evaluate(() =>
        document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status == "loaded").map((f) => f.family.replace(/["']/g, "")))
      );
    await expect.poll(loaded, { message: id }).toContain("Literata");
    expect(await loaded(), id).toContain("Instrument Sans");
  }
  expect(asked).toEqual([]);
});
