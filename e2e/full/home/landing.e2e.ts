// The homepage as its owner, others and admins use it.
// Each test starts from a fresh homepage, and leaves one for the next.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, SHORT, test } from "../../helpers/fixtures";
import { ROOT } from "../../helpers/env";
import { editor, F } from "../../helpers/editor";
import { deployed, docOf, fresh, front, get, homeView, openHome, redeploy, resetLanding } from "./home";
import { runTool } from "../../helpers/tools";

await servers.short();
test.afterEach(async () => { await resetLanding(await servers.short()); });

test("in a browser, once its first deploy is done, / is the landing document itself, with Clone over it", async ({ tab }) => {
  const server = await servers.short();
  await fresh(server);
  await deployed(server);
  await tab.page.setViewportSize({ width: 1200, height: 800 });
  await openHome(tab.page, server.root);
  const shown = await tab.page.evaluate(() => {
    const controls = document.querySelector("erga-controls")?.shadowRoot;
    return (
      document.querySelector("h1")?.textContent == "Erga" &&
      !document.querySelector("iframe#frame") &&
      !!controls?.querySelector("a.erga-new-clone[href='/new?from=landing']")
    );
  });
  expect(shown).toBe(true);
});

// The edit is cut into a version once edits pause (SHORT.idle); / shows it only after a deploy.
test("its owner edits it in the editor, and / shows the edit once they deploy", { timeout: 30_000 }, async ({ tab }) => {
  const server = await servers.short();
  const { id, address } = await fresh(server);
  await tab.page.addInitScript(() => {
    if (window.top != window) return;
    try { if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}'); } catch { /* no storage */ }
  });
  await tab.page.setViewportSize({ width: 1200, height: 800 });
  await tab.page.goto(`${server.root}${address}?edit`);
  const ed = editor(tab.page, { address, dir: "", file: "" });
  await expect.poll(() => tab.page.evaluate(() => document.body.classList.contains("erga-editor-ready"))).toBe(true);
  // The first paragraph: the heading is the logo, which isn't edited (data-erga-noedit).
  // (The page's <body> is the one editing host: the paragraph is editable in it.)
  await expect.poll(() => ed.frame<boolean>(`!!${F}?.querySelector("p.lede")?.isContentEditable`)).toBe(true);
  // Its fonts first: the text moves when they load.
  await ed.frame(`${F}.fonts.ready.then(() => true)`);
  await ed.clickEnd("p.lede");
  // The caret at the paragraph's end, wherever the click put it.
  await ed.frame(`(() => { const p = ${F}.querySelector("p.lede"); ${F}.getSelection().collapse(p, p.childNodes.length); return true; })()`);
  await ed.type(" At home.");
  await expect.poll(async () => (await get(server, `/d/${id}/doc/index.html`)).text()).toContain("for them. At home.</p>");
  await expect
    .poll(async () => (await runTool(server.root, "versions", { document: id })).result?.pending, { timeout: SHORT.idle * 5 })
    .toBe(false); // a version
  await deployed(server);
  expect((await front(server)).html).not.toContain("for them. At home.</p>");
  await redeploy(server);
  await expect.poll(async () => (await front(server)).html).toContain("for them. At home.</p>");
  expect(docOf((await front(server)).html)).toBe(id);
});

test("someone who isn't an admin sees it with Clone, without Edit; /new?from=landing copies it", async () => {
  const server = await servers.short();
  const { id } = await fresh(server);
  const ada = await homeView(server, "Ada");
  expect(docOf(ada)).toBe(id);
  expect(ada).not.toContain("erga-edit-button");
  expect(ada).toContain("erga-new-clone");
  const made = await get(server, "/new?from=landing");
  const to = made.headers.get("location") ?? "";
  expect(made.status).toBe(302);
  expect(to).toMatch(/^\/tester\/.+?edit$/);
});

test("the homepage project is nobody's: an admin can't delete it; reset, it's made again from assets/landing/", async () => {
  const server = await servers.short();
  const { id } = await fresh(server);
  const del = await runTool(server.root, "delete_document", { document: "/_home" });
  expect(del.status).toBe(403);
  expect(docOf((await front(server)).html)).toBe(id);
  const again = await fresh(server);
  expect(again.id).not.toBe(id);
  expect(await (await get(server, `/d/${again.id}/doc/index.html`)).text()).toBe(
    readFileSync(join(ROOT, "assets/landing/index.html"), "utf8")
  );
  // The one before is an ordinary document of the dev server's person now, at its id.
  expect((await get(server, `/tester/${id}`)).status).toBe(200);
});

test("a landing document an admin chose is the homepage, and nothing more is made", async () => {
  const server = await servers.short();
  await fresh(server);
  const landings = async () => ((await (await get(server, "/docs")).text()).match(/href="\/_home\?edit"/g) ?? []).length;
  const before = await landings();
  expect(before).toBe(1);
  const mine = (await get(server, "/new")).headers.get("location")!.replace(/[?&]edit=?$/, "");
  const mineId = ((await (await get(server, `${mine}/api/doc`)).json()) as { docName: { id: string } }).docName.id;
  const set = await runTool(server.root, "set_setting", { key: "landing_document", value: mine });
  expect(set.ok).toBe(true);
  expect(docOf((await front(server)).html)).toBe(mineId);
  expect(await landings()).toBe(before);
});
