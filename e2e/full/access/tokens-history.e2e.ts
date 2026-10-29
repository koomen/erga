// /settings in headless Chrome: a form's POST answers 303 to the page (server/identity/flash.ts), so after making or
// revoking a token, Back and Reload never send the form again. The new token shows once: never on Back or Reload.
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { unique } from "./access";

await servers.main();

/** The POSTs the page sends while `act` runs. */
async function posts(page: Page, act: () => Promise<unknown>) {
  const sent: string[] = [];
  const see = (r: { method(): string; url(): string }) => r.method() == "POST" && sent.push(r.url());
  page.on("request", see);
  try {
    await act();
  } finally {
    page.off("request", see);
  }
  return sent;
}

const rowsOf = (page: Page, label: string) =>
  page.evaluate(
    (label) => [...document.querySelectorAll<HTMLElement>("ol.rows > li")].filter((li) => li.innerText.includes(label)).length,
    label
  );
const secretShown = (page: Page) => page.evaluate(() => !!document.querySelector(".card.made pre.secret"));

test("after a token is made or revoked on /settings, Back and Reload send no form again, and the token shows once only", async ({
  tab,
}) => {
  const root = (await servers.main()).root,
    page = tab.page;
  tab.strict = true;
  // Yes to "Revoke …?".
  await page.addInitScript(() => (window.confirm = () => true));
  const label = unique("History ");
  await page.goto(`${root}/docs`);
  await page.goto(`${root}/settings`);
  await until(() => page.evaluate(() => !!document.querySelector("form.add")), 10_000, "/settings opens");

  // Make one: the token shows, on /settings.
  const made = await posts(page, async () => {
    await page.fill("form.add input[name=label]", label);
    await Promise.all([page.waitForURL(`${root}/settings`), page.click("form.add button")]);
    await until(() => secretShown(page), 10_000, "the new token is shown");
  });
  expect(made).toEqual([`${root}/tokens/new`]);
  expect(await rowsOf(page, label)).toBe(1);

  // Reload: no POST, no second token, and the token isn't shown again.
  expect(await posts(page, () => page.reload())).toEqual([]);
  expect(await secretShown(page)).toBe(false);
  expect(await rowsOf(page, label)).toBe(1);

  // Back: the page before, with no POST (Chrome's resubmission prompt comes only for a POST in the history).
  expect(await posts(page, () => page.goBack())).toEqual([]);
  expect(page.url()).toBe(`${root}/settings`);
  expect(await secretShown(page)).toBe(false);
  expect(await rowsOf(page, label)).toBe(1);
  expect(await posts(page, () => page.goForward())).toEqual([]);
  expect(await secretShown(page)).toBe(false);

  // Revoke it: then Back and Reload send nothing either.
  const revoked = await posts(page, async () => {
    await Promise.all([
      page.waitForURL(`${root}/settings`),
      page.evaluate(
        (label) =>
          [...document.querySelectorAll<HTMLElement>("ol.rows > li")]
            .find((li) => li.innerText.includes(label))!
            .querySelector("form")!
            .requestSubmit(),
        label
      ),
    ]);
    await until(async () => (await rowsOf(page, label)) == 0, 10_000, "the token is gone");
  });
  expect(revoked).toEqual([`${root}/tokens/revoke`]);
  expect(await posts(page, () => page.reload())).toEqual([]);
  expect(await posts(page, () => page.goBack())).toEqual([]);
  expect(await rowsOf(page, label)).toBe(0);
});
