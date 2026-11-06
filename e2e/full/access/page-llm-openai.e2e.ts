// A page's model from OpenAI (agents/page-llm.ts): Document settings' model menu has Claude's models, and OpenAI's once
// the admin saves the server's OpenAI key on /admin/api-keys. The owner chooses GPT-6 Luna, and the page's own script
// gets its answer (the scripted model: no real one). Without the key, share_document refuses an OpenAI model.
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { clickOn, newDoc } from "./access";
import type {} from "../../../client/common/page-llm";

const own = () => servers.of("page-llm-openai", { env: { ERGA_AGENT_MODEL: "script" } });
await own();

/** Calls a tool as the owner (the dev server's own person), as their page does. */
const asOwner = (root: string, name: string, args: Record<string, unknown>) =>
  fetch(`${root}/api/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(root).origin },
    body: JSON.stringify(args),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as { error?: string; result?: { access?: { pageLlm?: object } } } }));

/** The model menu's choices, by provider, as Document settings shows them. */
async function menu(page: Page, root: string, at: string) {
  await page.goto(root + at);
  await until(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready")), 10_000, "the editor is ready");
  await clickOn(page, "#btn-settings");
  await page.locator("#ds-llm-model option").first().waitFor({ state: "attached" });
  return page
    .locator("#ds-llm-model optgroup")
    .evaluateAll((gs) =>
      gs.map((g) => `${(g as HTMLOptGroupElement).label}: ${[...g.querySelectorAll("option")].map((o) => o.textContent).join(", ")}`)
    );
}

test("OpenAI's models are in the page model menu once the server has an OpenAI key; the page gets the chosen one", async ({ tab }) => {
  const page = tab.page;
  const root = (await own()).root;
  const made = await newDoc(root);
  expect(await menu(page, root, made.at)).toEqual(["Anthropic: Opus 5.5 fast, Opus 5.5, Sonnet 5.5, Haiku 5.5"]);
  const refused = await asOwner(root, "share_document", { document: made.id, page_llm_model: "gpt-6-luna" });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toContain("The server has no API key that runs GPT-6 Luna for pages.");

  // The admin saves the server's OpenAI key.
  await page.goto(`${root}/admin/api-keys`);
  await page.fill("#key-openai", "sk-proj-" + "y".repeat(60) + "Zz90");
  await page.press("#key-openai", "Enter");
  await page.waitForSelector("li[data-name=openai] .models");

  expect(await menu(page, root, made.at)).toEqual([
    "Anthropic: Opus 5.5 fast, Opus 5.5, Sonnet 5.5, Haiku 5.5",
    "OpenAI: GPT-6.1 Sol, GPT-6 Astra, GPT-6.1 Terra, GPT-6 Luna",
  ]);
  await page.locator("#ds-llm-on").click();
  await expect
    .poll(async () => (await asOwner(root, "ls", { document: made.id })).body.result?.access?.pageLlm)
    .toMatchObject({ on: true });
  await page.locator("#ds-llm-model").selectOption({ label: "GPT-6 Luna" });
  await expect
    .poll(async () => (await asOwner(root, "ls", { document: made.id })).body.result?.access?.pageLlm)
    .toMatchObject({ on: true, model: "gpt-6-luna" });

  // The page's own script: the model is GPT-6 Luna, and it answers.
  await page.goto((root + made.at).replace(/[?&]edit=?$/, ""));
  const frame = await until(
    async () => {
      const f = await (await page.$("#frame"))?.contentFrame();
      return f && (await f.evaluate(() => !!window.ergaLLM)) ? f : null;
    },
    10_000,
    "the page has window.ergaLLM"
  );
  expect(await frame!.evaluate(() => window.ergaLLM!.status())).toEqual({ on: true, model: "GPT-6 Luna", signedIn: true });
  expect(await frame!.evaluate(() => window.ergaLLM!.ask({ messages: [{ role: "user", content: '@script [{"model": true}]' }] }))).toEqual({
    text: "GPT-6 Luna",
  });
});
