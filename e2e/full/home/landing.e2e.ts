// The homepage as its owner, others and admins use it.
// Each test starts from a fresh homepage, and leaves one for the next.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, SHORT, test } from "../../helpers/fixtures";
import { ROOT } from "../../helpers/env";
import { editor, F } from "../../helpers/editor";
import { deployed, docOf, editOf, fresh, front, get, resetLanding } from "./home";

await servers.short();
test.afterEach(async () => { await resetLanding(await servers.short()); });

test("in a browser, once its first deploy is done, / is the landing document itself, with Edit and Clone over it", async ({ tab }) => {
  const server = await servers.short();
  const { address } = await fresh(server);
  await deployed(server);
  await tab.page.setViewportSize({ width: 1200, height: 800 });
  await tab.page.goto(`${server.root}/`);
  expect(await tab.page.evaluate((address) => {
    const controls = document.querySelector("erga-controls")?.shadowRoot;
    return document.querySelector("h1")?.textContent == "Erga" && !document.querySelector("iframe#frame")
      && !!controls?.querySelector("a.erga-clone-button[href='/new?from=landing']") && !!controls?.querySelector(`a.erga-edit-button[href='${address}?edit']`);
  }, address)).toBe(true);
});

// The edit is cut into a version once edits pause (SHORT.idle), and deployed SHORT.homeDelay after.
test("its owner edits it in the editor, and / shows the edit", { timeout: 30_000 }, async ({ tab }) => {
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
  await expect.poll(() => ed.frame<string | null>(`${F}?.querySelector("p.lede")?.getAttribute("contenteditable") ?? null`)).toBe("true");
  // Its fonts first: the text moves when they load.
  await ed.frame(`${F}.fonts.ready.then(() => true)`);
  await ed.clickEnd("p.lede");
  // The caret at the paragraph's end, wherever the click put it.
  await ed.frame(`(() => { const p = ${F}.querySelector("p.lede"); ${F}.getSelection().collapse(p, p.childNodes.length); return true; })()`);
  await ed.type(" At home.");
  await expect.poll(async () => (await get(server, `/d/${id}/doc/index.html`)).text()).toContain("for them. At home.</p>");
  await expect.poll(async () => (await front(server)).html, { timeout: SHORT.idle + SHORT.homeDelay + 5_000 }).toContain("for them. At home.</p>"); // a version, then a deploy
  expect(docOf((await front(server)).html)).toBe(id);
});

test("someone who isn't an admin sees it with Clone, without Edit; /new?from=landing copies it", async () => {
  const server = await servers.short();
  const { id } = await fresh(server);
  const ada = await front(server, "Ada");
  expect(docOf(ada.html)).toBe(id);
  expect(ada.html).not.toContain("erga-edit-button");
  expect(ada.html).toContain("erga-clone-button");
  const made = await get(server, "/new?from=landing");
  const to = made.headers.get("location") ?? "";
  expect(made.status).toBe(302);
  expect(to).toMatch(/^\/tester\/.+?edit$/);
});

test("deleted, the landing document is made again from assets/landing/ on the next /", async () => {
  const server = await servers.short();
  const { id } = await fresh(server);
  const del = await get(server, "/docs/delete", { method: "POST", headers: { Origin: server.root }, body: new URLSearchParams({ id }) });
  expect(del.status).toBe(303);
  const again = (await front(server)).html;
  const id2 = docOf(again);
  expect(id2).toBeTruthy();
  expect(id2).not.toBe(id);
  expect(editOf(again)).toMatch(/^\/tester\/landing(-\d+)?$/);
  expect(await (await get(server, `/d/${id2}/doc/index.html`)).text()).toBe(readFileSync(join(ROOT, "assets/landing/index.html"), "utf8"));
});

test("a landing document an admin chose is the homepage, and nothing more is made", async () => {
  const server = await servers.short();
  await fresh(server);
  const landings = async () => ((await (await get(server, "/docs")).text()).match(/href="\/tester\/landing(-\d+)?\?edit"/g) ?? []).length;
  const before = await landings();
  const mine = (await get(server, "/new")).headers.get("location")!.replace(/[?&]edit=?$/, "");
  const mineId = ((await (await get(server, `${mine}/api/name`)).json()) as { id: string }).id;
  const set = await get(server, "/admin/settings", { method: "POST", headers: { Origin: server.root }, body: new URLSearchParams({ key: "landing_document", value: JSON.stringify(mine) }) });
  expect(set.ok).toBe(true);
  expect(docOf((await front(server)).html)).toBe(mineId);
  expect(await landings()).toBe(before);
});
