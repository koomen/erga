// A page's details (Document settings, Page details, Edit): its title, description, icon and link picture, in its <head>.
// The owner types them in the dialog and saves; the page's source has the tags, the viewer's tab shows the title and
// icon, and a link's preview reads the description (the viewer's own head, since the page is in a frame).
import { expect, servers, test, until } from "../../helpers/fixtures";
import { clickOn, newDoc } from "../access/access";

await servers.main();

async function tool(root: string, name: string, args: Record<string, unknown>) {
  const r = await fetch(`${root}/api/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(root).origin },
    body: JSON.stringify(args),
  });
  return (await r.json()) as { ok: boolean; result?: any; error?: string };
}

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("the owner sets the page's title, description and icon in Page details; the tab and a link's preview show them", async ({ tab }) => {
  const page = tab.page;
  const root = (await servers.main()).root;
  const made = await newDoc(root);
  expect((await tool(root, "write", { document: made.id, files: { "logo.png": { base64: PIXEL } } })).ok).toBe(true);
  await page.goto(root + made.at);
  await until(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready")), 10_000, "the editor is ready");
  await clickOn(page, "#btn-settings");
  await page.locator("#ds-page-edit").waitFor();
  await page.locator("#ds-page-edit").click();
  const dialog = page.locator("#erga-page-head");
  await dialog.waitFor();
  // The title box has the focus: the owner types into it, then Tab to the description.
  await page.keyboard.type("Pete's <Page>");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Everything about the page.");
  await page.locator("#ph-icon").fill("logo.png");
  expect(await dialog.locator(".ph-tab-title").textContent()).toBe("Pete's <Page>");
  expect(await dialog.locator(".ph-desc").textContent()).toBe("Everything about the page.");
  await dialog.locator(".ph-save").click();
  await dialog.waitFor({ state: "detached" });
  // The page's source has the tags.
  await expect
    .poll(
      async () => (await tool(root, "ls", { document: made.id })).result.entries.find((e: { path: string }) => e.path == "index.html")?.head
    )
    .toEqual({ title: "Pete's <Page>", description: "Everything about the page.", icon: "logo.png" });
  // The tab follows the page's head at once.
  await expect.poll(() => page.title()).toBe("Pete's <Page>");
  await expect
    .poll(() => page.evaluate(() => document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? ""))
    .toMatch(/\/logo\.png$/);
  // Page details in the settings show them, with Edit.
  await clickOn(page, "#btn-settings");
  await expect.poll(() => page.locator("#ds-page-tab").textContent()).toBe("Pete's <Page>");
  expect(await page.locator("#ds-page-desc").textContent()).toBe("Everything about the page.");
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLImageElement>("#ds-page-tab img")?.naturalWidth ?? 0)).toBe(1);
  expect(await page.locator("#ds-page-edit").textContent()).toBe("Edit");
  await page.keyboard.press("Escape");
  // A reader's (or a link preview's) first response has them in the viewer's own head.
  const html = await (await fetch(root + made.at.replace(/[?&]edit=?$/, ""))).text();
  expect(html).toContain("<title>Pete&#39;s &lt;Page&gt;</title>");
  expect(html).toContain('<meta name="description" content="Everything about the page.">');
  expect(html).toMatch(/<link rel="icon" href="[^"]+\/logo\.png">/);
  // Empty again: the tab shows the document's title, and Erga's icon.
  expect((await tool(root, "set_head", { document: made.id, title: "", description: "", icon: "" })).result.head).toEqual({});
  await expect.poll(() => page.title()).not.toBe("Pete's <Page>");
});
