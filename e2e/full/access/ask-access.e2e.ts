// The "no access" page (server/documents/view.ts): someone signed in opens a document that nobody shared with them. The
// page has three ways out: "Ask <owner> for access", "Use another account" and "Your documents". The owner sees each
// request at the top of their documents list, with Share and Decline. One request for each person and document.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { runTool } from "../../helpers/tools";
import { getter, newDoc, unique } from "./access";

await servers.main();

test("a person with no access asks the owner; the owner shares from the documents list, or declines", async ({ tab }) => {
  const page = tab.page;
  tab.strict = false; // (The page with no access answers 403: the browser logs it.)
  const root = (await servers.main()).root;
  const made = await newDoc(root);
  const address = (root + made.at).replace(/[?&]edit=?$/, "");
  const ada = unique("ada"),
    bo = unique("bo");

  // Ada: the page says who has not shared it, and has three buttons.
  await page.goto(`${address}?user=${ada}`);
  await expect.poll(() => page.locator("main").innerText()).toContain(`tester has not shared this document with ${ada}.`);
  expect(await page.locator("main .ways > *").allInnerTexts()).toEqual(["Ask tester for access", "Use another account", "Your documents"]);
  expect(await page.locator("main .ways a").evaluateAll((l) => l.map((a) => new URL((a as HTMLAnchorElement).href).pathname))).toEqual([
    "/auth/logout",
    "/docs",
  ]);
  await page.locator("#ask-access").click();
  await expect.poll(() => page.locator("#ask-access").innerText()).toBe("Asked");
  expect(await page.locator("#ask-access").isDisabled()).toBe(true);
  expect(await page.locator("#ask-note").innerText()).toBe("tester sees your request on their documents list.");
  await page.screenshot({ path: ".e2e/shots/ask-access-page.png" });
  // The page remembers; a second request changes nothing.
  await page.reload();
  await expect.poll(() => page.locator("#ask-access").innerText()).toBe("Asked");
  // Bo asks through his agent's tool.
  expect((await runTool(root, "request_access", { document: made.id }, { user: bo })).error).toBeUndefined();
  expect((await runTool(root, "request_access", { document: made.id }, { user: bo })).error).toBeUndefined();

  // The owner: the requests at the top of the list; the owner's tools see them too.
  const asks = () =>
    page.locator("ul.asks li").evaluateAll((l) => l.map((li) => (li as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
  await page.goto(`${root}/docs`);
  expect((await asks()).filter((t) => t.includes(ada) || t.includes(bo)).sort()).toEqual(
    [`${ada} asks for access to Untitled Share Decline`, `${bo} asks for access to Untitled Share Decline`].sort()
  );
  const ls = (await runTool(root, "ls", { document: made.id })).result as { access: { requests: { login: string }[] } };
  expect(ls.access.requests.map((r) => r.login).sort()).toEqual([ada, bo].sort());
  await page.screenshot({ path: ".e2e/shots/ask-access-list.png" });

  // Share: Ada can view it. Decline: Bo can't, and his request doesn't come back.
  await page.locator(`ul.asks li[data-login="${ada}"] button.share`).click();
  await page.locator(`ul.asks li[data-login="${bo}"] button.decline`).click();
  await until(async () => !(await asks()).some((t) => t.includes(ada) || t.includes(bo)), 5000, "the two requests go");
  const get = getter(root);
  expect((await get(`${made.at.replace(/[?&]edit=?$/, "")}?user=${ada}`)).status).toBe(200);
  expect((await get(`${made.at.replace(/[?&]edit=?$/, "")}?user=${bo}`)).status).toBe(403);
  expect((await runTool(root, "request_access", { document: made.id }, { user: bo })).error).toBeUndefined();
  await page.reload();
  expect((await asks()).some((t) => t.includes(bo))).toBe(false);
  // Someone who has access has nothing to ask for.
  expect((await runTool(root, "request_access", { document: made.id }, { user: ada })).error).toMatch(/already/);
});
