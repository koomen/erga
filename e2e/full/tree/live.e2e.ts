// The tree follows changes without a reload: a file on disk, another tab, an agent ("Live").
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test, until } from "../../helpers/fixtures";
import { act, clickOn, menuItem, multi, openCard, openTreeEditor, paths, press, rows, type } from "./tree";

await servers.main();

test("a page arriving on disk shows, by its title", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  writeFileSync(join(doc.dir, "faq.html"), "<!doctype html><title>Questions</title><h1>Questions</h1>");
  await until(async () => (await rows(page)).some((x) => x[0] == "faq.html" && x[1] == "Questions"), 10_000, "a page arriving on disk shows, by its title");
});

test("two tabs: a page made and moved in one shows in the other", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  // The folder it moves to open here, so the moved page shows.
  await clickOn(page, '.et-row[data-path="blog"]');
  await expect.poll(() => paths(page)).toContain("blog/index.html");
  const p2 = await page.context().newPage();
  try {
    // (Not waiting for its page to have the focus: one tab at a time has it.)
    await openTreeEditor({ ...tab, page: p2 }, doc.base, { focus: false });
    await openCard(p2);
    await clickOn(p2, ".et-foot .et-add:nth-child(1)");
    await type(p2, "Field notes");
    await press(p2, "Enter");
    await until(async () => (await doc.tree()).includes("field-notes.html"), 5000, "the second tab makes a page");
    await until(async () => (await rows(page)).some((x) => x[0] == "field-notes.html" && x[1] == "Field notes"), 10_000, "the first tab shows it, live");
    await act(p2, "field-notes.html", "more");
    await menuItem(p2, "Move page to…");
    await menuItem(p2, "blog");
    await until(async () => { const p = await paths(page); return p.includes("blog/field-notes.html") && !p.includes("field-notes.html"); }, 10_000, "a move in the second tab shows in the first");
  } finally { await p2.close(); }
});

test("an agent's new page, move and stylesheet show: pages by their titles", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  await clickOn(page, '.et-row[data-path="blog"]');
  await doc.agentTool("new_page", { path: "blog/owl-calls" });
  await doc.agentTool("write", { path: "blog/owl-calls.html", content: "<!doctype html><title>Owl calls</title><link rel=stylesheet href=../style.css><h1>Owl calls</h1>" });
  await until(async () => (await rows(page)).some((x) => x[0] == "blog/owl-calls.html" && x[1] == "Owl calls"), 10_000, "an agent's new page shows, by its title");
  await doc.agentTool("mv", { from: "about.html", to: "blog/about.html" });
  await until(async () => { const p = await paths(page); return p.includes("blog/about.html") && !p.includes("about.html"); }, 10_000, "an agent's move shows");
  // A stylesheet: a project's tree shows it too.
  await doc.agentTool("write", { path: "blog/blog.css", content: "h1 { letter-spacing: 0.01em; }" });
  await until(async () => (await paths(page)).includes("blog/blog.css"), 10_000, "the stylesheet shows");
});

test("?pages opens the tree at once; the page you're on, moved by an agent: the editor follows it to its new address, and the tree marks it there", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await doc.agentTool("new_page", { path: "blog/owl-calls" });
  await openTreeEditor(tab, `${doc.base}/blog/owl-calls`, { query: "?pages" });
  await until(async () => (await rows(page)).some((x) => x[0] == "blog/owl-calls.html" && x[3]), 10_000, "the tree marks the page you're on, in its folder, which opened");
  await doc.agentTool("mv", { from: "blog/owl-calls.html", to: "owl-calls.html" });
  await until(() => { const u = new URL(page.url()); return u.pathname + u.search == `${doc.address}/owl-calls?edit`; }, 10_000, "the editor follows its page to its new address");
  await until(async () => (await rows(page).catch(() => [])).some((x) => x[0] == "owl-calls.html" && x[3]), 10_000, "and the tree marks it there");
});
