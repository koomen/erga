// Document or Project, in the document's settings (the gear): a new document's title has no caret, and opens its name;
// the switch makes it a project, and the caret shows at once, in this tab and in another (no reload), and opens its
// pages. A request from elsewhere (an agent's) switches it too. A project with more than one page can't be a document:
// the settings say why, in place. With one page again, it can. On Documents a document's row has no chevron; a
// project's has, and says Project. The New menu's Project makes a project from the start, with two pages.
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { clickOn, js, openTreeEditor, paths } from "./tree";

/**
 * Clicks a control of the editor's chrome once it can take the click. The chrome hides while the page changes (the
 * editor's own first changes too, later on a busy machine) and comes back as the pointer moves: so the pointer moves,
 * as a person's would, until it shows.
 */
async function clickWhenShown(page: Page, selector: string, what: string) {
  let x = 200;
  await until(
    async () => {
      const ok = await page.evaluate((sel) => {
        const g = document.querySelector(sel),
          r = g?.getBoundingClientRect();
        return (
          !!r?.width &&
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(sel) == g &&
          getComputedStyle(g!.closest(".chrome") ?? g!).opacity == "1"
        );
      }, selector);
      if (!ok) await page.mouse.move((x = x == 200 ? 400 : 200), 300, { steps: 4 });
    return ok;
    },
    10_000,
    `${what} can be clicked`
  );
  await clickOn(page, selector);
}

/** Opens the settings once the gear can be clicked, and waits for them. */
async function openSettings(page: Page) {
  if (await page.evaluate(`document.getElementById("doc-settings")?.hidden !== false`))
    await clickWhenShown(page, "#btn-settings", "the gear");
  await until(() => page.evaluate(`document.getElementById("doc-settings")?.hidden === false`), 5000, "the settings open");
}

await servers.main();

test("Document or Project in the settings: the breadcrumb's caret follows the kind at once, in every tab", async ({ tab }) => {
  const page = tab.page;
  const server = await servers.main();
  const made = (await fetch(`${server.root}/new?template=page`, { redirect: "manual" })).headers.get("location") ?? "";
  const address = made.replace(/[?&]edit=?$/, "");
  const { id } = (await (await fetch(`${server.root}${address}/api/name`)).json()) as { id: string };
  /** A tree operation from outside the tabs, as an agent's (the tests' server signs it in as DEV_LOGIN). */
  const treeOp = (op: object) => fetch(`${server.root}/api/docs/${id}/tree`, { method: "POST", headers: { "Content-Type": "application/json", Origin: server.root }, body: JSON.stringify(op) });
  // Documents: no chevron for it.
  await page.goto(`${server.root}/docs`);
  await until(() => page.evaluate(`!!document.querySelector('a.doc[href*="${address}"]')`), 5000, "the document is on the list");
  expect(await js(page, `!!document.querySelector('button.twist[data-id="${id}"]')`)).toBe(false);

  // The editor, and a second tab of it: a document's title has no caret, and opens its name.
  await openTreeEditor(tab, `${server.root}${address}`);
  const other = await page.context().newPage();
  await other.goto(`${server.root}${address}?edit`);
  await until(() => other.evaluate(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden`), 10_000, "the second tab is up");
  await page.bringToFront();
  const caret = (p = page) => p.evaluate(`getComputedStyle(document.querySelector("#doc-title .nav-caret")).display != "none"`) as Promise<boolean>;
  expect(await caret()).toBe(false);
  expect(await caret(other)).toBe(false);
  await clickWhenShown(page, "#doc-title", "the title");
  expect(await js(page, `[document.getElementById("naming").hidden, document.getElementById("pages").hidden]`)).toEqual([false, true]);
  await page.keyboard.press("Escape");

  // The settings: Document chosen, no homepage note, and nothing about "Make a project" in the pages.
  await openSettings(page);
  await until(() => js(page, `!!document.querySelector('#ds-kind [data-kind="document"][aria-checked="true"]:not([aria-disabled])')`), 5000, "the settings show Document");
  expect(await js(page, `document.getElementById("ds-home").hidden`)).toBe(true);
  expect(await js(page, `document.getElementById("ds-kind-explain").textContent`)).toBe("One page, with its files beside it. A project has more pages.");
  expect(await js(page, `[...document.querySelectorAll("#pages .et-add")].map((b) => b.textContent)`)).not.toContain("Make a project");

  // Project: the caret shows at once here, and in the other tab with no reload; the title opens the pages.
  await clickOn(page, '#ds-kind [data-kind="project"]');
  await until(() => js(page, `!!document.querySelector('#ds-kind [data-kind="project"][aria-checked="true"]')`), 5000, "the settings show Project");
  await until(() => caret(), 2000, "the caret shows once the server says so");
  await until(() => caret(other), 5000, "the other tab's caret shows, with no reload");
  await other.close();
  await page.keyboard.press("Escape");
  await clickWhenShown(page, "#doc-title", "the title");
  await until(() => js(page, `!document.getElementById("pages").hidden && [...document.querySelectorAll("#pages .et-foot .et-add")].filter((b) => !b.hidden).map((b) => b.textContent).join()`), 5000, "a project's pages open, with New page")
    .then((v) => expect(v).toBe("New page,New folder"));
  await page.keyboard.press("Escape");

  // A second page (from elsewhere): Document can't be chosen, and the settings say why.
  expect((await treeOp({ op: "new_page", path: "about" })).status).toBe(200);
  await openSettings(page);
  await until(() => js(page, `document.querySelector('#ds-kind [data-kind="document"]').getAttribute("aria-disabled") == "true"`), 5000, "Document is off with two pages");
  expect(await js(page, `document.getElementById("ds-kind-explain").textContent`)).toBe("It has 2 pages, and a document has one. Delete the others first.");

  // One page again: Document, and the caret goes at once.
  expect((await treeOp({ op: "delete", path: "about.html" })).status).toBe(200);
  await until(() => js(page, `!document.querySelector('#ds-kind [data-kind="document"]').hasAttribute("aria-disabled")`), 5000, "Document is on again with one page");
  await clickOn(page, '#ds-kind [data-kind="document"]');
  await until(async () => !(await caret()), 5000, "the caret goes");

  // From elsewhere (an agent's make_project): the caret comes back with no reload, and the open settings follow.
  expect((await treeOp({ op: "make_project" })).status).toBe(200);
  await until(() => caret(), 5000, "the caret shows after a change from elsewhere");
  await until(() => js(page, `!!document.querySelector('#ds-kind [data-kind="project"][aria-checked="true"]')`), 5000, "the open settings follow");

  // Documents: its chevron, and Project.
  await page.goto(`${server.root}/docs`);
  await until(() => page.evaluate(`!!document.querySelector('button.twist[data-id="${id}"]')`), 5000, "a project's row has its chevron");
  expect(await js(page, `document.querySelector('button.twist[data-id="${id}"]').closest(".name").querySelector(".note.kind").textContent`)).toBe("Project");
});

test("New, then Project: a project from the start, its caret shown, and its two pages in the tree", async ({ tab }) => {
  const page = tab.page;
  const server = await servers.main();
  const made = (await fetch(`${server.root}/new?template=page`, { redirect: "manual" })).headers.get("location") ?? "";
  await openTreeEditor(tab, `${server.root}${made.replace(/[?&]edit=?$/, "")}`);
  const from = await page.evaluate(() => location.pathname);
  await until(
    () =>
      page.evaluate(() => {
        const b = document.querySelector("#btn-new")!,
          r = b.getBoundingClientRect();
        return !!r.width && b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }),
    10_000,
    "+ can be clicked"
  );
  await clickOn(page, "#btn-new");
  await until(() => js(page, `!document.querySelector(".erga-new-menu").hidden`), 5000, "the New menu opens");
  await clickOn(page, '.erga-new-menu a[data-template="project"]');
  await until(
    () => page.evaluate((f) => location.pathname != f && location.search == "?edit", from),
    10_000,
    "the new project opens in the editor"
  );
  await until(
    () => page.evaluate(() => document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title")!.hidden),
    10_000,
    "the editor is up"
  );
  await until(
    () => js(page, `getComputedStyle(document.querySelector("#doc-title .nav-caret")).display != "none"`),
    5000,
    "a project's caret shows"
  );
  await clickWhenShown(page, "#doc-title", "the title");
  await until(() => js(page, `!document.getElementById("pages").hidden`), 5000, "the pages open");
  await until(
    async () =>
      (await paths(page, "#pages")).join() == "index.html,about.html" || (await paths(page, "#pages")).join() == "about.html,index.html",
    5000,
    "both pages in the tree"
  );
});
