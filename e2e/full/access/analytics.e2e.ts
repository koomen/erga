// The Analytics page (/admin), the first admin page: twelve people read a shared document, one more edits it, and the
// admin sees each number on the page as the server counted it: today's active people, views and edits, the most active
// people and the newest users, ten at a time, with Load more. 7 days shows seven bars. Anyone else gets no page. Its
// own server: the counts are the whole server's.
import { expect, test } from "../../helpers/fixtures";
import { runTool } from "../../helpers/tools";
import { mint, newDoc, tool } from "./access";

const READERS = Array.from({ length: 12 }, (_, i) => `reader${String(i + 1).padStart(2, "0")}`);

test("an admin sees the day's people, views and edits, the lists ten at a time with Load more; nobody else sees the page", {
  timeout: 60_000,
}, async ({ tab }) => {
  const page = tab.page;
  const s = await tab.own({ env: { ERGA_AGENT_MODEL: "script" } });
  const doc = await newDoc(s.root);
  const address = s.root + doc.at.replace(/[?&]edit=?$/, "");
  expect((await runTool(s.root, "share_document", { document: doc.id, login: "*", role: "viewer" })).ok).toBe(true);
  // The admin (tester) writes the page through an agent: one version, after the agent's calls end.
  const token = (await mint(s.root, null, { label: "Docs", scope: "documents" })).token;
  const wrote = await tool(s.root, token, "write", { document: doc.id, path: "index.html", content: "<h1>Plan</h1>\n<p>Ship it.</p>\n" });
  expect(wrote.status).toBe(200);
  // Reader n opens it n times, in turn: the first opens make each one's account, oldest first.
  for (const [i, login] of READERS.entries())
    for (let n = 0; n <= i; n++) expect((await fetch(`${address}?user=${login}`)).status).toBe(200);

  // The counts land after each answer, and the version a few seconds after the write.
  const today = async () => (await runTool(s.root, "analytics", { days: 7 })).result.days.at(-1);
  await expect.poll(async () => (await today()).views, { timeout: 15_000 }).toBe(78);
  await expect.poll(async () => (await today()).edits, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  const day = await today();
  expect(day.activePeople).toBe(13);

  await page.goto(`${s.root}/admin`);
  expect(await page.locator(".admin-side a[aria-current=page]").innerText()).toBe("Analytics");
  const big = (chart: string) => page.locator(`[data-chart="${chart}"] [data-big]`).innerText();
  expect(await big("people")).toBe("13");
  expect(await big("views")).toBe("78");
  expect(await big("edits")).toBe(String(day.edits));
  expect(await page.locator("#chart-views-svg > g").count()).toBe(30);
  expect(await page.locator("#chart-views-svg > g[data-date] title").last().textContent()).toMatch(/: 78 views$/);

  // The most active: reader12 first, with 12 views; ten, then the other three with Load more.
  const logins = (list: string) =>
    page.locator(`ol.people-rows[data-list="${list}"] > li`).evaluateAll((lis) => lis.map((li) => (li as HTMLElement).dataset.login));
  const active = await logins("active");
  expect(active.slice(0, 3)).toEqual(["reader12", "reader11", "reader10"]);
  expect(active.length).toBe(10);
  expect(await page.locator('ol.people-rows[data-list="active"] > li[data-login="reader12"] [data-n="views"]').innerText()).toBe(
    "12 views"
  );
  await page.locator('button.more[data-list="active"]').click();
  await expect.poll(async () => (await logins("active")).length).toBe(13);
  const all = await logins("active");
  expect(all.slice(0, 10)).toEqual(active);
  expect(all.slice(10).sort()).toEqual(["reader01", "reader02", "tester"]);
  expect(await page.locator('button.more[data-list="active"]').isHidden()).toBe(true);

  // The newest: the readers, last first; Load more brings the first two and the admin.
  const newest = await logins("newest");
  expect(newest).toEqual(READERS.slice(2).reverse());
  await page.locator('button.more[data-list="newest"]').click();
  await expect.poll(() => logins("newest")).toEqual([...newest, "reader02", "reader01", "tester"]);
  expect(await page.locator('button.more[data-list="newest"]').isHidden()).toBe(true);

  // 7 days: seven bars, in place.
  await page.locator('nav.range a:text("7 days")').click();
  await expect.poll(() => page.locator("#chart-views-svg > g").count()).toBe(7);
  expect(new URL(page.url()).search).toBe("?days=7");
  expect(await page.locator('nav.range a[aria-current="page"]').innerText()).toBe("7 days");

  // A reader is no admin: no page, and no numbers for their agent.
  expect((await page.goto(`${s.root}/admin?user=reader01`))!.status()).toBe(404);
  expect((await runTool(s.root, "analytics", {}, { user: "reader01" })).ok).toBe(false);
});
