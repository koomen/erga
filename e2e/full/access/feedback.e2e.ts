// Send feedback (client/agent/feedback-dialog.ts), in the browser: the account menu opens a small dialog that says the
// text goes to Erga's issues on GitHub without the person's name; they type, press Send, and see "Thanks, sent." The
// server keeps it, then opens an issue on the pretend GitHub (dev/github-mock.ts) with no name; the admins' Feedback
// page lists it, with its issue. And the editor's own avatar menu opens the same dialog. The issues go to the
// repository of the setting feedback_repository, which the test sets as an admin does.
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { runTool } from "../../helpers/tools";
import { clickOn, newDoc } from "./access";

await servers.main();
test.beforeAll(async () => {
  await runTool((await servers.main()).root, "set_setting", { key: "feedback_repository", value: "erga/pretend" });
});

const SHOTS = ".e2e/shots";

interface Issue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
}
/** The issues the pretend GitHub opened in the server's pretend repository. */
const issues = async (root: string): Promise<Issue[]> => (await fetch(`${root}/__github/api/repos/erga/pretend/issues`)).json();

/** Types `text` in the dialog with real keys, and presses Send. */
async function typeAndSend(page: Page, text: string) {
  await page.waitForSelector("#erga-feedback[open] textarea");
  await page.keyboard.type(text);
  await clickOn(page, "#erga-feedback .send");
}

test("Send feedback in the account menu: type, Send, thanks; the issue on GitHub has no name; the admins' Feedback page lists it with its issue", async ({
  tab,
}) => {
  const page = tab.page,
    root = (await servers.main()).root;
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(`${root}/docs`);
  await clickOn(page, "[data-erga-account] button");
  await clickOn(page, "#erga-account-menu a[href='#feedback']");
  await page.waitForSelector("#erga-feedback[open]");
  // The menu closes behind it.
  expect(await page.evaluate(() => document.getElementById("erga-account-menu")!.hidden)).toBe(true);
  expect(await page.textContent("#erga-feedback")).toContain("Your text goes to Erga's issue list on GitHub, without your name.");
  // The text box has the keys at once.
  expect(await page.evaluate(() => document.activeElement?.matches("#erga-feedback textarea"))).toBe(true);
  const text = `The documents list should sort by name, and keep the order I chose ${Date.now()}\nAnd remember it.`;
  await page.keyboard.type(text.split("\n")[0]);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("And remember it.");
  await page.screenshot({ path: `${SHOTS}/feedback-dialog.png` });
  await clickOn(page, "#erga-feedback .send");
  await expect
    .poll(() => page.evaluate(() => document.querySelector<HTMLElement>("#erga-feedback .thanks")!.innerText))
    .toContain("Thanks, sent.");
  await page.screenshot({ path: `${SHOTS}/feedback-thanks.png` });
  await clickOn(page, "#erga-feedback .done");
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLDialogElement>("#erga-feedback")!.open)).toBe(false);

  // The issue: the first line as its title, the text and the feedback's id as its body, the label; no name.
  const issue = await until(
    async () => (await issues(root)).find((i) => i.body.startsWith(text)),
    10_000,
    "the pretend GitHub has the issue"
  );
  expect(issue!.title).toBe(text.split("\n")[0].slice(0, 59).trimEnd() + "…");
  expect(issue!.body).toMatch(new RegExp(`^${text}\\n\\n---\\nFeedback fb-[a-z0-9]{8}$`));
  expect(issue!.labels).toEqual([{ name: "feedback" }]);
  expect(JSON.stringify(issue)).not.toMatch(/tester|\/docs/);

  // The admins' Feedback page: the text, when, the page, the issue's link.
  await page.goto(`${root}/admin/settings`);
  // The repository is a setting on the Settings page.
  const setting = await page.evaluate(() => {
    const row = [...document.querySelectorAll<HTMLElement>("[data-key]")].find((r) => r.dataset.key == "feedback_repository");
    return row ? { text: row.innerText, value: row.querySelector<HTMLInputElement>("#set-feedback_repository")?.value } : null;
  });
  expect(setting?.text).toContain("Feedback's repository");
  expect(setting?.value).toBe("erga/pretend");
  await page.locator("[data-key=feedback_repository]").screenshot({ path: `${SHOTS}/feedback-setting.png` });
  await clickOn(page, ".admin-side a[href='/admin/feedback']");
  await page.waitForSelector(`.feedback li:has-text("${text.split("\n")[0]}")`);
  const row = await page.evaluate((first) => {
    const li = [...document.querySelectorAll<HTMLElement>(".feedback li")].find((l) => l.innerText.includes(first))!;
    return {
      text: li.querySelector<HTMLElement>(".text")!.innerText,
      page: li.querySelector(".page")?.textContent,
      issue: li.querySelector<HTMLAnchorElement>("a.issue")?.textContent,
      href: li.querySelector<HTMLAnchorElement>("a.issue")?.getAttribute("href"),
    };
  }, text.split("\n")[0]);
  expect(row).toEqual({
    text,
    page: "/docs",
    issue: `#${issue!.number}`,
    href: expect.stringMatching(new RegExp(`/__github/erga/pretend/issues/${issue!.number}$`)),
  });
  await page.screenshot({ path: `${SHOTS}/feedback-admin.png` });
  expect(tab.errors).toEqual([]);
});

test("in the editor, the avatar's menu has Send feedback, which opens the same dialog and sends from the document's page", async ({
  tab,
}) => {
  const page = tab.page,
    root = (await servers.main()).root;
  const { at } = await newDoc(root);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(root + at);
  await until(
    () => page.evaluate(() => !!document.querySelector("#me .avatar") && document.body.classList.contains("erga-editor-ready")),
    10_000,
    "the editor shows your avatar"
  );
  await clickOn(page, "#me .avatar");
  await clickOn(page, "#account-feedback");
  const text = `From the editor ${Date.now()}`;
  await typeAndSend(page, text);
  await expect
    .poll(() => page.evaluate(() => document.querySelector<HTMLElement>("#erga-feedback .thanks")!.innerText))
    .toContain("Thanks, sent.");
  const issue = await until(async () => (await issues(root)).find((i) => i.title == text), 10_000, "the pretend GitHub has the issue");
  expect(issue!.body).toContain(text);
});
