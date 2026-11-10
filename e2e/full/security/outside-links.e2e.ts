// A page can't send the person's whole tab to another site (client/inline/viewer-nav.ts, erga-go): an address outside
// Erga opens in a new tab, whatever the page asks, so the tab that shows Erga stays Erga's. A link to another address
// of this Erga may still take the tab, where its author set it so.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { unique } from "../access/access";

await servers.script();

/** An address that isn't this Erga's (another origin: the same machine by another name), where a page could look like Erga's sign-in. */
const outside = (root: string) => `${root.replace("127.0.0.1", "localhost")}/api/health`;

const html = (docs: string, OUTSIDE: string) => `<!doctype html>
<html><head><title>Notes</title></head>
<body>
<h1>Quarterly notes</h1>
<p><a id="outside" href="${OUTSIDE}?by=link" target="_self">Sign in again</a></p>
<p><a id="inside" href="${docs}" target="_self">My documents</a></p>
<p id="trap">Click anywhere to continue.</p>
<script>
// On the reader's click, the page's own script asks the viewer for the whole tab, as its link script would.
document.getElementById("trap").addEventListener("click", function () {
  parent.postMessage({ type: "erga-go", url: "${OUTSIDE}?by=script" }, window.__ergaReader.config.shell);
});
</script>
</body></html>
`;

async function open(page: Page) {
  const s = await servers.script();
  const dir = join(s.scratch, "docs", unique("outside-"));
  mkdirSync(dir, { recursive: true });
  const OUTSIDE = outside(s.root);
  expect(new URL(OUTSIDE).origin).not.toBe(new URL(s.root).origin);
  writeFileSync(join(dir, "index.html"), html(`${s.root}/docs`, OUTSIDE));
  const address = (await s.open(dir)).replace(/[?&]edit=?$/, "");
  await page.goto(address);
  const frame = page.frameLocator("#frame");
  await expect
    .poll(() =>
      frame
        .locator("h1")
        .textContent({ timeout: 1000 })
        .catch(() => "")
    )
    .toBe("Quarterly notes");
  return { s, address, frame, OUTSIDE };
}

/** The tabs that open while `act` runs: each one's address. */
async function tabsFrom(page: Page, act: () => Promise<void>): Promise<string[]> {
  const opened: string[] = [];
  const seen = (p: Page) =>
    void p
      .waitForURL(/^http/, { timeout: 5000 })
      .catch(() => {})
      .then(() => opened.push(p.url()));
  page.context().on("page", seen);
  await act();
  await until(() => opened.length > 0, 8000, "a new tab opened").catch(() => {});
  page.context().off("page", seen);
  return opened;
}

test("a page's script that asks for the whole tab with an address outside Erga gets a new tab; the tab stays", async ({ tab }) => {
  const { page } = tab;
  const { frame, OUTSIDE } = await open(page);
  const here = page.url();
  const opened = await tabsFrom(page, () => frame.locator("#trap").click());
  expect(opened).toEqual([`${OUTSIDE}?by=script`]);
  expect(page.url()).toBe(here);
});

test("an author's link to another site set to this tab opens a new tab; one to this Erga takes the tab", async ({ tab }) => {
  const { page } = tab;
  const { s, frame, OUTSIDE } = await open(page);
  const here = page.url();
  const opened = await tabsFrom(page, () => frame.locator("#outside").click());
  expect(opened).toEqual([`${OUTSIDE}?by=link`]);
  expect(page.url()).toBe(here);
  // Erga's own address: the whole tab, as the author set it.
  await frame.locator("#inside").click();
  await expect.poll(() => page.url()).toContain(`${s.root}/docs`);
});
