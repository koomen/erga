// A page's model (window.ergaLLM, agents/page-llm.ts): off at first. Its owner turns it on in Document settings, and
// the page's own script asks the model as its visitor (the scripted model: no real one). Signed out: "sign_in", and
// signIn() goes to Erga's sign-in, back to the page. Over the visitor's hour: "limit".
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { clickOn, newDoc, unique } from "./access";
import type {} from "../../../client/common/page-llm";

type Result = { text?: string; code?: string; message?: string };

/** The page in the viewer's frame, once its script has ergaLLM. */
async function pageFrame(page: Page) {
  const f = await until(
    async () => {
      const f = await (await page.$("#frame"))?.contentFrame();
      return f && (await f.evaluate(() => !!window.ergaLLM)) ? f : null;
    },
    10_000,
    "the page has window.ergaLLM"
  );
  return f!;
}

/** What the page's own script gets from ergaLLM: status(), or ask() with one user message. */
const status = async (page: Page) => (await pageFrame(page)).evaluate(() => window.ergaLLM!.status());
const ask = async (page: Page, content: string) =>
  (await pageFrame(page)).evaluate(
    (content) =>
      window.ergaLLM!.ask({ system: "Be brief.", messages: [{ role: "user", content }], max_tokens: 800 }).then(
        (r): Result => r,
        (e: Error & { code?: string }): Result => ({ code: e.code, message: e.message })
      ),
    content
  );

/** Calls a tool as the owner (the dev server's own person), as their page does. */
const asOwner = (root: string, name: string, args: Record<string, unknown>) =>
  fetch(`${root}/api/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(root).origin },
    body: JSON.stringify(args),
  }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as { result?: { access?: { pageLlm?: { on: boolean; model: string } } } },
  }));

test("off at first; the owner turns it on in Document settings, and the page's script gets the model's text", async ({ tab }) => {
  const page = tab.page;
  const root = (await servers.script()).root;
  const made = await newDoc(root);
  const address = (root + made.at).replace(/[?&]edit=?$/, "");
  await page.goto(address);
  expect(await status(page)).toEqual({ on: false, model: null, signedIn: true });
  expect((await ask(page, "Hi")).code).toBe("off");
  // The owner ticks it in Document settings: Haiku, as it starts.
  await page.goto(root + made.at);
  await until(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready")), 10_000, "the editor is ready");
  await clickOn(page, "#btn-settings");
  await page.locator("#ds-llm-on").waitFor();
  expect(await page.locator("#ds-llm-on").isChecked()).toBe(false);
  expect(await page.locator("#ds-llm-model").inputValue()).toBe("haiku");
  await page.locator("#ds-llm-on").click();
  await expect
    .poll(async () => (await asOwner(root, "ls", { document: made.id })).body.result?.access?.pageLlm)
    .toEqual({ on: true, model: "haiku" });
  await page.goto(address);
  expect(await status(page)).toEqual({ on: true, model: "Haiku 5.5", signedIn: true });
  expect(await ask(page, '@script [{"text": "Hello from the model."}]')).toEqual({ text: "Hello from the model." });
  // Off again: "off".
  expect((await asOwner(root, "share_document", { document: made.id, page_llm: false })).status).toBe(200);
  expect((await ask(page, "Hi")).code).toBe("off");
});

test("signed out: sign_in, and signIn() goes to Erga's sign-in and back to the page", async ({ tab }) => {
  const page = tab.page;
  const root = (await servers.script()).root;
  const made = await newDoc(root);
  const path = new URL(root + made.at).pathname;
  expect((await asOwner(root, "share_document", { document: made.id, page_llm: true })).status).toBe(200);
  expect((await asOwner(root, "share_document", { document: made.id, login: "*", role: "viewer" })).status).toBe(200);
  // Locally, a browser that signed out has this cookie (the dev server signs in every other one).
  const url = new URL(root);
  await page.context().addCookies([{ name: `erga_signed_out_${url.port}`, value: "1", domain: url.hostname, path: "/" }]);
  await page.goto(root + path);
  expect(await status(page)).toEqual({ on: true, model: "Haiku 5.5", signedIn: false });
  expect((await ask(page, "Hi")).code).toBe("sign_in");
  // The page's own button, clicked: Erga's sign-in, which comes back here.
  const frame = await pageFrame(page);
  await frame.evaluate(() => {
    const b = document.body.appendChild(document.createElement("button"));
    b.id = "sign-in-test";
    b.textContent = "Sign in";
    b.onclick = () => window.ergaLLM!.signIn();
  });
  const signIn = page.waitForRequest((r) => r.isNavigationRequest() && new URL(r.url()).pathname == "/auth/sign-in");
  await frame.locator("#sign-in-test").click();
  expect(new URL((await signIn).url()).searchParams.get("next")).toBe(path);
});

test("a visitor over the hour's limit gets limit", async ({ tab }) => {
  const page = tab.page;
  const root = (await servers.script()).root;
  const made = await newDoc(root);
  const visitor = unique("visitor");
  expect((await asOwner(root, "share_document", { document: made.id, login: visitor, role: "viewer" })).status).toBe(200);
  expect((await asOwner(root, "share_document", { document: made.id, page_llm: true })).status).toBe(200);
  await page.goto(`${(root + made.at).replace(/[?&]edit=?$/, "")}?user=${visitor}`);
  // One answer that used the visitor's whole hour of tokens (PAGE_LLM_LIMITS.visitor.tokens: 60,000).
  expect(await ask(page, '@script [{"text": "Long.", "tokens": 60000}]')).toEqual({ text: "Long." });
  expect((await ask(page, '@script [{"text": "Again."}]')).code).toBe("limit");
});
