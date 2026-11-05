// Add user with a GitHub login, when GitHub refuses the server's lookups without credentials (a reported bug: erga.dev's
// shared Cloudflare IPs used up GitHub's 60 lookups an hour, and Add user said "GitHub didn't answer … status 403").
// The pretend GitHub (dev/github-mock.ts) refuses a rate-limited-* login so, unless the sign-in app's client id and
// secret come with the lookup. Without the app, the page says it's GitHub's rate limit and when it resets. With the app
// saved on /admin/auth, Add user works, and takes a pasted profile URL too. On a server of this file's own: it sets the
// sign-in app. The admin is DEV_LOGIN ("tester").
import { expect, servers, test, until } from "../../helpers/fixtures";
import { unique } from "./access";

const server = () => servers.of("github-lookup");
await server();

test("Add user: GitHub's rate limit is said as such; with the sign-in app, a pasted profile URL is added", async ({ tab }) => {
  const page = tab.page,
    root = (await server()).root;
  const login = `rate-limited-${unique("")}`;
  const hint = () => page.textContent("#users-hint");
  const add = async (handle: string) => {
    await page.goto(`${root}/admin/users?user=tester`);
    await page.selectOption("form.add-user select[name=provider]", "github");
    await page.fill("form.add-user input[name=handle]", handle);
    await page.selectOption("form.add-user select[name=role]", "read");
    await page.click("form.add-user button");
  };

  // No app that GitHub knows: refused, and the page says why and until when.
  await add(login);
  await until(async () => !["", "Adding…"].includes((await hint()) ?? ""), 5000, "an answer");
  expect(await hint()).toBe("GitHub's rate limit stops this lookup until 2030-01-01 12:34 UTC: try again then.");

  // The pretend GitHub's app, saved on /admin/auth: sign-in uses it now.
  const CARD = 'section.server[data-provider="github"]';
  await page.goto(`${root}/admin/auth`);
  await page.fill(`${CARD} input[name=clientId]`, "Iv1.mockgithubapp0");
  await page.fill(`${CARD} input[name=secret]`, "mock-github-client-secret");
  await page.click(`${CARD} button.save`);
  await until(async () => (await page.getAttribute(CARD, "data-state")) == "working", 10_000, "the app in use");

  // Its profile's URL, pasted: they wait for their first sign-in, by their login.
  await add(`https://github.com/${login}`);
  const waiting = `ol.users > li.waiting:has(.handle:text-is("${login}"))`;
  await until(async () => !!(await page.$(waiting)), 5000, `${login} waits`);
  expect(await hint()).toBe("");
});
