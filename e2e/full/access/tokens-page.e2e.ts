// /tokens in the browser (/tokens in headless Chrome): make a one-document token with an
// expiry, shown once, then listed with its scope, document and expiry; the Admin scope offered to an admin only.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { mint, publish, unique } from "./access";

await servers.main();

test("an admin is offered every scope; a one-document token with an expiry is shown once with its scope, document and expiry, then listed so", async ({ tab }) => {
  const root = (await servers.main()).root, page = tab.page;
  tab.strict = true;
  const docs = await mint(root, null, { label: "Docs", scope: "documents" });
  await mint(root, null, { label: "Admin", scope: "admin" });
  const made = await publish(root, docs.token, "Scoped one");
  const label = unique("Chrome made ");
  await page.goto(`${root}/tokens`);
  await until(() => page.evaluate(() => !!document.querySelector("form.add")), 10_000, "/tokens opens");
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>("input[name=scope]")].map((i) => i.value))).toEqual(["document", "documents", "admin"]);
  await page.evaluate(({ label, id, expires }) => {
    (document.querySelector("input[name=label]") as HTMLInputElement).value = label;
    const pick = document.querySelector(".doc-pick") as HTMLSelectElement;
    pick.value = id;
    pick.dispatchEvent(new Event("change"));
    (document.querySelector("input[name=expires]") as HTMLInputElement).value = expires;
    (document.querySelector("form.add") as HTMLFormElement).requestSubmit();
  }, { label, id: made.id, expires: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) });
  await until(() => page.evaluate(() => !!document.querySelector(".card.made pre.secret")), 10_000, "the new token is shown");
  const shown = await page.evaluate((label) => ({ card: (document.querySelector(".card.made") as HTMLElement).innerText, row: [...document.querySelectorAll<HTMLElement>("ol.rows > li")].find((li) => li.innerText.includes(label))?.innerText ?? "" }), label);
  for (const part of ["One document", "Scoped one", "Expires"]) expect(shown.card, "the card").toContain(part);
  expect(shown.row, "the row").toContain("One document");
  expect(shown.row, "the row").toContain("Scoped one");
  expect(shown.row, "the row has an expiry").not.toContain("Never\nNever");
  const rows = await page.evaluate(() => (document.querySelector("ol.rows") as HTMLElement).innerText);
  expect(rows).toContain("Admin");
  expect(rows).toContain("All my documents");
});

test("a user isn't offered the admin scope", async ({ tab }) => {
  const page = tab.page;
  await page.goto(`${(await servers.main()).root}/tokens?user=${unique("Bo")}`);
  await until(() => page.evaluate(() => !!document.querySelector("form.add")), 10_000, "/tokens opens");
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>("input[name=scope]")].map((i) => i.value))).toEqual(["document", "documents"]);
});
