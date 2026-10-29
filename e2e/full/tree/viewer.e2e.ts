// Someone who may only view a document sees its tree read-only ("a viewer").
import { expect, servers, test, until } from "../../helpers/fixtures";
import { clickOn, multi, row, signIn, js } from "./tree";
import { runTool } from "../../helpers/tools";

await servers.main();

test("for a viewer the tree has no add, rename, move or delete, no keys that change it, and its pages open in the viewer", async ({ tab }) => {
  const server = await servers.main();
  const doc = await multi(server);
  await doc.agentTool("new_page", { path: "owl-calls" });
  // A document linked from disk starts shared with anyone signed in, to edit: that goes first.
  const owner = await signIn(server, null);
  const share = (login: string, role: string) =>
    runTool(server.root, "share_document", { document: doc.id, login, role }, { cookie: owner });
  expect((await share("*", "none")).ok).toBe(true);
  expect((await share("ada", "viewer")).ok).toBe(true);
  const ada = await signIn(server, "ada");
  const seen = await (await fetch(`${server.root}/api/docs/${doc.id}/tree`, { headers: { Cookie: ada } })).json() as { canEdit: boolean };
  expect(seen.canEdit).toBe(false);

  const page = tab.page;
  tab.strict = true;
  const twist = `button.twist[data-id="${doc.id}"]`, sub = `#pages-${doc.id}`;
  await page.goto(`${server.root}/auth/github?as=ada&next=/docs`);
  await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(twist)})`), 5000, "Ada's Documents lists the document");
  await clickOn(page, twist);
  await until(() => page.evaluate(`document.querySelectorAll("${sub} .et-row[data-path]").length > 1`), 5000, "Ada sees its pages");
  expect(await js(page, `!document.querySelector("${sub} .et-act, ${sub} .et-foot:not([hidden]), ${sub} [draggable=true]")`)).toBe(true);
  expect(await js(page, `document.querySelector(${JSON.stringify(`${sub} ${row("owl-calls.html")} a`)}).getAttribute("href")`)).toMatch(/\/owl-calls$/);
  await page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(`${sub} ${row("owl-calls.html")}`)}); r.focus(); r.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); r.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })); })()`);
  // The keys are handled at once (or not at all): what they'd show would be there after a frame.
  await page.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  expect(await js(page, `!!document.querySelector(".et-input, .et-row.confirm")`)).toBe(false);
  expect(await doc.tree()).toContain("owl-calls.html");
});
