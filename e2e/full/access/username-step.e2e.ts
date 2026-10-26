// A new account's first sign-in: its person chooses a username (server/identity/accounts.ts), here through local
// development's pretend provider (/auth/dev), which takes the same steps as GitHub's and Google's answers. The page
// says at once whether a name is free; the account is made only when they choose; the next sign-in skips the step.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { unique } from "./access";

await servers.main();

test("the first sign-in asks for a username, checks it as it's typed, makes the account, and isn't asked again", async ({ tab }) => {
  const page = tab.page, root = (await servers.main()).root;
  const sub = unique("g"), name = unique("nia");
  const signIn = `${root}/auth/dev?provider=google&subject=${sub}&handle=${encodeURIComponent(`Nia.Ray.${sub}@example.com`)}&email=${encodeURIComponent(`nia.${sub}@example.com`)}&name=Nia&next=/docs`;
  await page.goto(signIn);
  expect(new URL(page.url()).pathname).toBe("/auth/username");
  // Offered from the provider's name, made valid.
  expect(await page.inputValue("#username")).toBe(`nia-ray-${sub}`);
  const hint = () => page.textContent("#username-hint");
  await page.fill("#username", "admin");
  await until(async () => (await hint())?.includes("reserved"), 5000, "a reserved name is refused as it's typed");
  await page.fill("#username", "tester");
  await until(async () => (await hint())?.includes("taken"), 5000, "a name in use is refused as it's typed");
  // Sent anyway: the page says why, and nothing is made.
  await page.click("form.username button");
  await until(async () => (await hint())?.includes("taken"), 5000, "the server refuses it too");
  await page.fill("#username", name);
  await until(async () => (await hint())?.includes("is free"), 5000, "a free name is free");
  await page.click("form.username button");
  await until(async () => new URL(page.url()).pathname == "/docs", 10_000, "made, and on to where they were going");
  const me = await page.evaluate(() => document.querySelector("[data-erga-account] button")?.getAttribute("aria-label"));
  expect(me).toBe("You (Nia)");
  // Their documents' addresses are under the username.
  await page.goto(`${root}/new`);
  await until(async () => new URL(page.url()).pathname.startsWith(`/${name}/`), 10_000, "a new document under the username");
  // The next sign-in goes straight in.
  await page.goto(signIn);
  await until(async () => new URL(page.url()).pathname == "/docs", 10_000, "no username step the second time");
});
