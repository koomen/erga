// On Documents, Delete takes the row away at once, before the server answers; when the server refuses, the row is back.
// Back from a document shows the list at once, from the browser's copy, and the list then follows what changed.
import type { Route } from "playwright-core";
import { expect, test } from "../../helpers/fixtures";
import { person, servers, tools } from "./front";

await servers.script();

test("Delete: the row goes at once; refused, it is back in its place", async ({ tab }) => {
  const p = await person(await servers.script());
  const page = tab.page;
  const agent = tools(p.base, await p.token("At once"));
  for (const title of ["First", "Second", "Third"]) await agent.call("create_document", { title });
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  const titles = () =>
    page.evaluate<string[]>(`[...document.querySelectorAll("ol.rows > li[data-live]:not([hidden]) .title")].map((t) => t.innerText)`);
  const order = await titles();
  expect([...order].sort()).toEqual(["First", "Second", "Third"]);
  const held: Route[] = [];
  await page.route("**/api/tools/delete_document*", (r) => void held.push(r));
  // The runner answers the browser's own dialogs: the page's own say theirs here.
  await page.evaluate(() => {
    const w = window as unknown as { said: string[] };
    w.said = [];
    window.confirm = () => true;
    window.alert = (m) => void w.said.push(String(m));
  });
  const said = () => page.evaluate(() => (window as unknown as { said: string[] }).said);
  const second = `ol.rows > li[data-live]:has(.title:text-is("Second")) button.act.delete`;
  await page.locator(second).click({ force: true });
  await expect.poll(titles).toEqual(order.filter((t) => t != "Second"));
  expect(await page.textContent("#docs-count")).toBe("2 documents");
  await expect.poll(() => held.length).toBe(1);
  await held[0].fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Not now." }) });
  await expect.poll(titles).toEqual(order);
  expect(await said()).toEqual(["Not now."]);
  expect(await page.textContent("#docs-count")).toBe("3 documents");
});

test("Back to Documents shows the list from the browser's copy, and the list follows a change made meanwhile", async ({ tab }) => {
  const p = await person(await servers.script());
  const page = tab.page;
  const agent = tools(p.base, await p.token("Back"));
  const made = (await agent.call("create_document", { title: "Before" })).data as { id: string; address: string };
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  const titles = () => page.evaluate<string[]>(`[...document.querySelectorAll("ol.rows > li[data-live] .title")].map((t) => t.innerText)`);
  await expect.poll(titles).toEqual(["Before"]);
  await page.goto(`${p.base}${made.address}`);
  await agent.call("rename_document", { document: made.id, title: "After" });
  await page.goBack();
  await expect.poll(titles).toEqual(["After"]);
  // No answer from the server for the page: the browser kept it.
  expect(
    await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      return [n.type, n.transferSize];
    })
  ).toEqual(["back_forward", 0]);
});
