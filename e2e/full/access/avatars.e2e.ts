// Each account's picture (shared/avatars.ts), through local development's pretend provider (/auth/dev), which takes the
// same steps as Google's and GitHub's answers: a Google account shows the picture Google gave, in the corner and in the
// editor; one with none shows its initial, never a GitHub picture; a GitHub account shows GitHub's, by its id.
import { expect, type Page, servers, test, until } from "../../fixtures";
import { corner, unique } from "./access";

await servers.main();

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

/** A new account, signed in with the pretend provider (`q`: its answer), its username chosen: on /docs after. */
async function newAccount(page: Page, q: string) {
  const root = (await servers.main()).root;
  await page.goto(`${root}/auth/dev?${q}&next=/docs`);
  await page.fill("#username", unique("av"));
  await page.click("form.username button");
  await until(async () => new URL(page.url()).pathname == "/docs", 10_000, "the account is made");
  await until(async () => (await corner(page)).state == "in", 10_000, "its page shows the corner");
}

test("a Google account shows Google's picture, in the corner and the editor; with none, its initial; GitHub's is by its id", async ({
  tab,
}) => {
  const page = tab.page,
    root = (await servers.main()).root;
  // The pictures, served here, so none fails offline and takes itself off.
  await page.route(/^https:\/\/(lh3\.googleusercontent\.com|avatars\.githubusercontent\.com)\//, (r) =>
    r.fulfill({ contentType: "image/png", body: PNG })
  );
  const sub = unique("g"),
    picture = encodeURIComponent("https://lh3.googleusercontent.com/a/ACg8oc-gina=s96-c");
  await newAccount(
    page,
    `provider=google&subject=${sub}&handle=gina.${sub}%40example.com&email=gina.${sub}%40example.com&name=Gina&picture=${picture}`
  );
  expect((await corner(page)).img).toBe("https://lh3.googleusercontent.com/a/ACg8oc-gina=s64-c");
  await page.goto(`${root}/new`);
  await until(() => page.evaluate(() => !!document.querySelector("#me .avatar img")), 10_000, "the editor shows the picture");
  expect(await page.evaluate(() => document.querySelector("#me .avatar img")!.getAttribute("src"))).toBe(
    "https://lh3.googleusercontent.com/a/ACg8oc-gina=s64-c"
  );

  // A Google account with no picture: its initial on its colour, no picture at all.
  await page.context().clearCookies();
  const bare = unique("g");
  await newAccount(page, `provider=google&subject=${bare}&handle=bo.${bare}%40example.com&email=bo.${bare}%40example.com&name=Bo`);
  const c = await corner(page);
  expect([c.img, c.initial]).toEqual([null, "B"]);
  expect(await page.content()).not.toContain("avatars.githubusercontent.com");

  // A GitHub account: GitHub's picture by its numeric id, not its login.
  await page.context().clearCookies();
  const id = String(700_000_000 + Math.floor(Math.random() * 1e8));
  await newAccount(page, `provider=github&subject=${id}&handle=${unique("octo")}&name=Octo`);
  expect((await corner(page)).img).toBe(`https://avatars.githubusercontent.com/u/${id}?s=64`);
});
