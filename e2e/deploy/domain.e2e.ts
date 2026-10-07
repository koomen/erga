// Buying a domain on /deploy (tests/deploy.ts): only after its price is shown and confirmed.
import { expect, test } from "../fixtures";
import { openDeploy, servers } from "./deploy";

await servers.mock();

test("a search shows prices, and why one can't be had; a domain is bought only after its price is confirmed, and becomes the app's", async ({ tab }) => {
  const s = await servers.mock(), p = await openDeploy(tab.page, s.root);
  await p.oauth();
  await p.click("#buy summary");
  await p.fill("q", "myerga");
  await p.click("#search");
  await expect.poll(() => tab.page.evaluate(() => document.querySelectorAll("#offers li").length)).toBe(4);
  const offers = await p.text("#offers");
  expect(offers).toContain("myerga.com");
  expect(offers).toContain("10.44 USD");
  expect(offers).toContain("can't be registered through the API");
  await p.click("[data-buy='0']");
  await expect.poll(() => tab.page.evaluate(() => (document.getElementById("confirm-buy") as HTMLDialogElement).open)).toBe(true);
  expect(await p.text("#buy-price")).toBe("10.44 USD");
  expect(await tab.page.evaluate(() => (document.getElementById("buy-go") as HTMLButtonElement).disabled)).toBe(true);
  await p.click("#buy-go");
  expect((await p.mock()).registrations, "nothing bought without the confirmation").toEqual([]);
  await p.click("#buy-ok");
  await p.click("#buy-go");
  await expect.poll(() => p.text("#offers")).toContain("Registered");
  expect(await tab.page.evaluate(() => (document.querySelector("input[name=app][value=domain]") as HTMLInputElement).checked && (document.getElementById("app-host") as HTMLInputElement).value)).toBe("myerga.com");
  const { registrations } = await p.mock();
  expect(registrations).toEqual([{ domain: "myerga.com", price: "10.44" }]);
});
