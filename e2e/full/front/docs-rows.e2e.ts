// The rows of /docs and /docs/archived line up: a document's name (no chevron) starts where a project's name does,
// and every row has the same height. A rule for the search's no-match line (.none) once also matched a document's
// empty chevron place (span.twist.none), and moved its name 12 px right and made its row taller.
import type { Page } from "playwright-core";
import { expect, test } from "../../helpers/fixtures";
import { person, servers, tools } from "./front";

await servers.script();

/** Each row's title: its left edge, and its row's height, in CSS px. */
const rows = (page: Page) =>
  page.evaluate<{ title: string; left: number; height: number }[]>(
    `[...document.querySelectorAll("ol.rows > li[data-live]")].map((li) => ({ title: li.querySelector(".title").innerText, left: Math.round(li.querySelector(".title").getBoundingClientRect().left), height: Math.round(li.getBoundingClientRect().height) }))`
  );

test("on /docs and /docs/archived, a document's name lines up with a project's, and the rows have the same height", async ({ tab }) => {
  const p = await person(await servers.script());
  const page = tab.page;
  tab.strict = true;
  await page.setViewportSize({ width: 1280, height: 800 });
  const agent = tools(p.base, await p.token("Rows test"));
  const made: string[] = [];
  for (const [title, kind] of [
    ["A project", "project"],
    ["A document", "document"],
    ["Another project", "project"],
    ["Another document", "document"],
  ])
    made.push(((await agent.call("create_document", { title, kind })).data as { id: string }).id);

  const lined = async () => {
    const r = await rows(page);
    expect(r.map((x) => x.title).sort()).toEqual(["A document", "A project", "Another document", "Another project"]);
    expect(new Set(r.map((x) => x.left)).size, JSON.stringify(r)).toBe(1);
    expect(new Set(r.map((x) => x.height)).size, JSON.stringify(r)).toBe(1);
    // As before the search came: a row is its name's line and 11 px above and below it.
    expect(r[0].height, JSON.stringify(r)).toBeLessThanOrEqual(46);
  };
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  await lined();

  for (const id of made) expect((await p.tool("archive_document", { document: id })).status).toBe(200);
  await page.goto(`${p.base}/docs/archived`);
  await lined();
});
