// The access rules on the Access page (/admin/access), end to end on a server of this file's own (they change who may
// use the whole server): one list of rules, each who and read or write. An admin adds a Google Workspace organization
// and a GitHub organization; such people make their accounts at their first sign-in, with that access; anyone else is
// refused, told why, in place. Everybody's rule changes with its select; a removed rule lets nobody in any more.
// Sign-ins go through local development's pretend provider (/auth/dev); the admin is DEV_LOGIN ("tester").
import { expect, servers, test, until } from "../../helpers/fixtures";
import { unique } from "./access";

const server = () => servers.of("access-rules");
await server();

test("rules: a Workspace with write, a GitHub organization with read, everybody's select, a rule removed", async ({ tab }) => {
  const page = tab.page, root = (await server()).root;
  const admin = () => page.goto(`${root}/admin/access?user=tester`);
  const hint = () => page.textContent("#rules-hint");
  const addRule = async (kind: string, value: string, access: "read" | "write") => {
    await admin();
    await page.selectOption("form.add-rule select[name=kind]", kind);
    await page.fill("form.add-rule input[name=value]", value);
    await page.selectOption("form.add-rule select[name=access]", access);
    await page.click("form.add-rule button");
  };
  const rule = (kind: string, value = "") => `ol.rules > li[data-kind="${kind}"]${value ? `:has(.title:text-is("${value}"))` : ""}`;

  // Everybody is first, and none: this server was invite-only.
  await admin();
  expect(await page.$eval("ol.rules > li:first-child", (li) => (li as HTMLElement).dataset.kind)).toBe("everybody");
  expect(await page.inputValue(`${rule("everybody")} select.access`)).toBe("none");
  // A Workspace is named by its domain: one that isn't is refused, in place.
  await addRule("workspace", "not a domain", "write");
  await until(async () => (await hint())?.includes("isn't a domain"), 5000, "a bad domain refused");
  await addRule("workspace", "example.org", "write");
  await until(async () => !!(await page.$(rule("workspace", "example.org"))), 5000, "the Workspace rule added");
  await addRule("github_org", "acme", "read");
  await until(async () => !!(await page.$(rule("github_org", "acme"))), 5000, "the organization rule added");

  const id = unique("");
  const signIn = (q: string) => page.goto(`${root}/auth/dev?${q}&next=/docs`);
  const join = async (name: string) => {
    expect(new URL(page.url()).pathname).toBe("/auth/username");
    await page.fill("#username", name);
    await page.click("form.username button");
    await until(async () => new URL(page.url()).pathname == "/docs", 10_000, `${name}'s account made`);
  };
  // A Workspace account of example.org (hd): write, so a new document.
  await signIn(`provider=google&subject=g${id}&handle=amy.${id}@example.org&email=amy.${id}@example.org&hd=example.org`);
  await join(`amy${id}`);
  await page.goto(`${root}/new`);
  await until(async () => new URL(page.url()).pathname.startsWith(`/amy${id}/`), 10_000, "Amy makes a document");
  // The same email domain without hd is a personal account: refused, and told so.
  await signIn(`provider=google&subject=h${id}&handle=bob.${id}@example.org&email=bob.${id}@example.org`);
  expect(await page.textContent("h1")).toBe("Not on this server");
  expect(await page.textContent("main")).toContain("personal Google account");
  // A member of acme: read, so no new document.
  await signIn(`provider=github&subject=${Date.now()}&handle=dee-${id}&org=acme`);
  await join(`dee${id}`);
  expect((await page.goto(`${root}/new`))?.status()).toBe(403);
  expect(await page.textContent("main")).toContain("not make or edit documents");
  // Not a member: refused, told what GitHub said.
  await signIn(`provider=github&subject=${Date.now() + 1}&handle=eve-${id}&org=other`);
  expect(await page.textContent("main")).toContain("an active member of other");

  // Everybody: read, with its select. Bob (personal account) may come in now.
  await admin();
  await page.selectOption(`${rule("everybody")} select.access`, "read");
  await until(async () => (await hint()) == "Saved.", 5000, "everybody's access saved");
  await signIn(`provider=google&subject=h${id}&handle=bob.${id}@example.org&email=bob.${id}@example.org`);
  await join(`bob${id}`);
  // The Workspace rule removed: Amy keeps only everybody's read.
  await admin();
  await page.evaluate(() => { window.confirm = () => true; });
  await page.click(`${rule("workspace", "example.org")} .remove-rule`);
  await until(async () => !(await page.$(rule("workspace", "example.org"))), 5000, "the Workspace rule removed");
  await signIn(`provider=google&subject=g${id}&handle=amy.${id}@example.org&email=amy.${id}@example.org&hd=example.org`);
  await until(async () => new URL(page.url()).pathname == "/docs", 10_000, "Amy signs in");
  expect((await page.goto(`${root}/new`))?.status()).toBe(403);
});

test("users: added by provider account before their first sign-in, with one role; the dev server's admin (DEV_LOGIN) is one already", async ({
  tab,
}) => {
  const page = tab.page,
    root = (await server()).root;
  const users = () => page.goto(`${root}/admin/users?user=tester`);
  const hint = () => page.textContent("#users-hint");
  const add = async (provider: string, handle: string, role: string) => {
    await users();
    await page.selectOption("form.add-user select[name=provider]", provider);
    await page.fill("form.add-user input[name=handle]", handle);
    await page.selectOption("form.add-user select[name=role]", role);
    await page.click("form.add-user button");
  };
  const id = unique("");
  // A Google account by its email, with Can authenticate: it waits on the Users page.
  await add("google", `ann.${id}@example.net`, "read");
  const waiting = `ol.users > li.waiting:has(.handle:text-is("ann.${id}@example.net"))`;
  await until(async () => !!(await page.$(waiting)), 5000, "Ann waits");
  expect(await page.inputValue(`${waiting} select.role`)).toBe("read");
  // A GitHub login GitHub doesn't know: refused, in place.
  await add("github", `no-such-${id}`, "read");
  await until(async () => (await hint())?.includes("GitHub has no account"), 5000, "an unknown login refused");
  // The dev server's admin (DEV_LOGIN): already an admin, said, not refused.
  await add("github", "tester", "read");
  await until(async () => (await hint()) == "tester is already an admin.", 5000, "tester is already an admin");
  // Ann's first sign-in, with that email verified: her account, with that role (no new documents).
  await page.goto(`${root}/auth/dev?provider=google&subject=a${id}&handle=ann.${id}@example.net&email=ann.${id}@example.net&next=/docs`);
  expect(new URL(page.url()).pathname).toBe("/auth/username");
  await page.fill("#username", `ann${id}`);
  await page.click("form.username button");
  await until(async () => new URL(page.url()).pathname == "/docs", 10_000, "Ann's account made");
  expect((await page.goto(`${root}/new`))?.status()).toBe(403);
  await users();
  expect(await page.$(waiting)).toBeNull();
  expect(await page.inputValue(`ol.users > li[data-login="ann${id}"] select.role`)).toBe("read");
  // Her role changed on the page: she may write now.
  await page.selectOption(`ol.users > li[data-login="ann${id}"] select.role`, "write");
  await until(
    async () =>
      (await page.inputValue(`ol.users > li[data-login="ann${id}"] select.role`)) == "write" && !(await hint())?.includes("Saving"),
    5000,
    "the role saved"
  );
  await page.goto(`${root}/auth/dev?provider=google&subject=a${id}&handle=ann.${id}@example.net&email=ann.${id}@example.net&next=/docs`);
  await page.goto(`${root}/new`);
  await until(async () => new URL(page.url()).pathname.startsWith(`/ann${id}/`), 10_000, "Ann makes a document");
});
