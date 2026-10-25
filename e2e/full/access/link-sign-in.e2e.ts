// One account per verified email (server/identity/accounts.ts), through local development's pretend provider: a Google
// account makes an Erga account; a GitHub account with the same verified address signs in to it, linked; /settings
// shows both, and unlinks one.
import { expect, servers, test, until } from "../../fixtures";
import { unique } from "./access";

await servers.main();

test("a GitHub account with the same verified email signs in to the Google-made account; Settings shows both and unlinks one", async ({ tab }) => {
  const page = tab.page, root = (await servers.main()).root;
  const id = unique(""), name = `lin${id}`, email = `lin.${id}@example.com`;
  await page.goto(`${root}/auth/dev?provider=google&subject=g${id}&handle=${encodeURIComponent(email)}&email=${encodeURIComponent(email)}&name=Lin&next=/settings`);
  await page.fill("#username", name);
  await page.click("form.username button");
  await until(async () => new URL(page.url()).pathname == "/settings", 10_000, "the account is made");
  // Signed out, a GitHub account whose verified addresses include hers (and a noreply one) signs in: her account.
  await page.goto(`${root}/auth/logout`);
  await page.goto(`${root}/auth/dev?provider=github&subject=${Date.now()}&handle=lin-gh-${id}&email=${encodeURIComponent(`9+lin@users.noreply.github.com`)}&email=${encodeURIComponent(email)}&name=Lin&next=/settings`);
  await until(async () => new URL(page.url()).pathname == "/settings", 10_000, "signed in, no username step");
  const rows = () => page.$$eval("ol.identities > li", (lis) => lis.map((li) => (li as HTMLElement).dataset.provider));
  expect(await rows()).toEqual(["github", "google"]);
  expect(await page.textContent("section.sign-in .sub")).toContain(email);
  expect(await page.textContent("section.sign-in .sub")).not.toContain("noreply");
  // Unlink Google: one left, which can't be unlinked.
  // The page asks first (confirm): yes.
  await page.evaluate(() => { window.confirm = () => true; });
  await page.click('ol.identities > li[data-provider="google"] button.unlink');
  await until(async () => (await rows()).join() == "github", 10_000, "Google unlinked");
  expect(await page.textContent(".notice")).toContain("Unlinked");
  expect(await page.$('ol.identities > li[data-provider="github"] button.unlink')).toBeNull();
});
