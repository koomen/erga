// The access rules on the Users page (/admin/users), end to end on a server of this file's own (they change who may
// use the whole server): an admin sets who may sign in to Google accounts on a domain and GitHub accounts in an
// organization; such a person makes their account at their first sign-in, and anyone else is refused, told why, in
// place. Then the write rule leaves them out: they may not make a document. Sign-ins go through local development's
// pretend provider (/auth/dev); the admin is DEV_LOGIN ("tester"), local development's admin.
import { expect, servers, test, until } from "../../fixtures";
import { unique } from "./access";

const server = () => servers.of("access-rules");
await server();

test("read: a domain for Google, an organization for GitHub; others are refused in place; write leaves them viewers", async ({ tab }) => {
  const page = tab.page, root = (await server()).root;
  const hint = (rule: string) => page.textContent(`form.access-rule[data-rule="${rule}"] .hint`);
  const saveRule = async (rule: "read" | "write", o: { mode: "anyone" | "some"; domains?: string; orgs?: string }) => {
    await page.goto(`${root}/admin/users?user=tester`);
    const form = `form.access-rule[data-rule="${rule}"]`;
    await page.check(`${form} input[name=mode][value=${o.mode}]`);
    await page.fill(`${form} input[name=domains]`, o.domains ?? "");
    await page.fill(`${form} input[name=orgs]`, o.orgs ?? "");
    await page.click(`${form} button.save`);
    await until(async () => (await hint(rule)) == "Saved.", 5000, `the ${rule} rule saved`);
  };
  // A domain that isn't one is refused, in place, and nothing changes.
  await page.goto(`${root}/admin/users?user=tester`);
  await page.check('form.access-rule[data-rule="read"] input[name=mode][value=some]');
  await page.fill('form.access-rule[data-rule="read"] input[name=domains]', "not a domain");
  await page.click('form.access-rule[data-rule="read"] button.save');
  await until(async () => (await hint("read"))?.includes("isn't a domain"), 5000, "a bad domain refused");
  await saveRule("read", { mode: "some", domains: "example.org", orgs: "acme" });
  // The page says domains are Google's and organizations GitHub's.
  expect(await page.textContent("section")).toContain("Email domains count for Google accounts only");

  const id = unique("");
  const signIn = (q: string) => page.goto(`${root}/auth/dev?${q}&next=/docs`);
  // A Google account with a verified email on the domain: makes an account.
  await signIn(`provider=google&subject=g${id}&handle=amy.${id}@example.org&email=amy.${id}@example.org&name=Amy`);
  expect(new URL(page.url()).pathname).toBe("/auth/username");
  await page.fill("#username", `amy${id}`);
  await page.click("form.username button");
  await until(async () => new URL(page.url()).pathname == "/docs", 10_000, "Amy's account made");
  // Not verified, or another domain: refused, and told who may come in.
  await signIn(`provider=google&subject=h${id}&handle=bob.${id}@example.org&email=bob.${id}@example.org&verified=0`);
  expect(await page.textContent("h1")).toBe("Not on this server");
  expect(await page.textContent("main")).toContain("Google didn't say your email is verified");
  await signIn(`provider=google&subject=i${id}&handle=cy.${id}@other.example&email=cy.${id}@other.example`);
  expect(await page.textContent("main")).toContain("example.org");
  // GitHub: a member of acme comes in; anyone else is told what GitHub said.
  await signIn(`provider=github&subject=${Date.now()}&handle=dee-${id}&org=acme`);
  expect(new URL(page.url()).pathname).toBe("/auth/username");
  await signIn(`provider=github&subject=${Date.now() + 1}&handle=eve-${id}&org=other`);
  expect(await page.textContent("h1")).toBe("Not on this server");
  expect(await page.textContent("main")).toContain("an active member of other");

  // Write: listed accounts only. Amy (her account made by the rule, unlisted) may sign in, but not make a document.
  await saveRule("write", { mode: "some" });
  await signIn(`provider=google&subject=g${id}&handle=amy.${id}@example.org&email=amy.${id}@example.org`);
  await until(async () => new URL(page.url()).pathname == "/docs", 10_000, "Amy signs in");
  const made = await page.goto(`${root}/new`);
  expect(made?.status()).toBe(403);
  expect(await page.textContent("main")).toContain("not make or edit them");
  // Listed by the admin: she may.
  await page.goto(`${root}/admin/users?user=tester`);
  await page.evaluate(() => { window.confirm = () => true; });
  // The switch's input is under its track: a click on it, as the label passes it on.
  await page.evaluate((login) => document.querySelector<HTMLInputElement>(`li[data-login="${login}"] input.listed`)!.click(), `amy${id}`);
  await until(async () => (await page.isChecked(`li[data-login="amy${id}"] input.listed`)), 5000, "Amy listed");
  await signIn(`provider=google&subject=g${id}&handle=amy.${id}@example.org&email=amy.${id}@example.org`);
  await page.goto(`${root}/new`);
  await until(async () => new URL(page.url()).pathname.startsWith(`/amy${id}/`), 10_000, "Amy makes a document");
});
