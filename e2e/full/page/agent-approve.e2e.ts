// The person's agent waits for their Approve click before a delete, a share with anyone, a revoke or an admin change
// (an operation's `asks`; agents/turn.ts, asking). Text in a page that the model obeys then costs a click, not a document.
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { runTool } from "../../helpers/tools";

await servers.script();

/** The /docs page as `user`, its agent panel open and on. */
async function docs(page: Page, root: string, user: string) {
  await page.goto(`${root}/docs?user=${user}`);
  await until(() => page.evaluate(() => !!window.ergaAgent), 5000, "the panel's script runs");
  await page.evaluate(() => window.ergaAgent!.show(true));
  await until(
    () => page.evaluate(() => document.getElementById("agent-model")!.textContent == "script (test model)"),
    10_000,
    "the agent is on"
  );
}

async function ask(page: Page, text: string) {
  await page.focus("#agent-input");
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}

/** Whether `user` still has the document at `address`. */
const has = async (root: string, user: string, address: string) => (await runTool(root, "ls", { document: address }, { user })).ok;

test("the agent's delete waits for Approve: Deny leaves the document, Approve deletes it", async ({ tab }) => {
  const { root } = await servers.script();
  const { page } = tab;
  const user = "approver";
  const made = await runTool<{ address: string }>(root, "create_document", { title: "Keep me" }, { user });
  const address = made.result!.address;
  await docs(page, root, user);
  const script = (after: string) =>
    `@script ${JSON.stringify([{ tool: "documents", args: { op: "delete_document", document: address } }, { text: after }])}`;

  await ask(page, `Delete it ${script("Left alone.")}`);
  const question = page.locator("#agent-log .msg-tool.asking");
  await expect.poll(() => question.count(), { timeout: 10_000 }).toBe(1);
  expect(await question.locator(".detail").textContent()).toBe(`Delete the document ${address} for good`);
  // The run stopped at the call: nothing ran, and the panel does not say the agent works.
  await expect.poll(() => page.locator("#agent-fab.busy").count()).toBe(0);
  expect(await has(root, user, address)).toBe(true);
  await question.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => page.locator("#agent-log .msg-assistant").last().textContent(), { timeout: 10_000 }).toBe("Left alone.");
  expect(await page.locator("#agent-log .msg-tool.error .detail").textContent()).toBe("Not approved.");
  expect(await has(root, user, address)).toBe(true);

  await ask(page, `Delete it now ${script("Deleted.")}`);
  await expect.poll(() => question.count(), { timeout: 10_000 }).toBe(1);
  // The question is there after a reload too, and its button still works.
  await page.goto(`${root}/docs?user=${user}&again`);
  await expect.poll(() => question.count(), { timeout: 10_000 }).toBe(1);
  await question.getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => page.locator("#agent-log .msg-assistant").last().textContent(), { timeout: 10_000 }).toBe("Deleted.");
  expect(await question.count()).toBe(0);
  expect(await has(root, user, address)).toBe(false);
});

test("a share with a person runs at once; a share with anyone waits", async ({ tab }) => {
  const { root } = await servers.script();
  const { page } = tab;
  const user = "approver-share";
  const address = (await runTool<{ address: string }>(root, "create_document", { title: "Shared" }, { user })).result!.address;
  await docs(page, root, user);
  const share = (login: string) => ({ tool: "documents", args: { op: "share_document", document: address, login, role: "viewer" } });
  await ask(page, `Share it @script ${JSON.stringify([share("bo"), share("*"), { text: "Shared." }])}`);
  const question = page.locator("#agent-log .msg-tool.asking");
  await expect.poll(() => question.count(), { timeout: 10_000 }).toBe(1);
  expect(await question.locator(".detail").textContent()).toBe(`Share ${address} with anyone who has the link (viewer)`);
  expect(await page.locator("#agent-log .msg-tool.done").count()).toBe(1);
});
