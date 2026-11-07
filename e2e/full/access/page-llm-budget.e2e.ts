// The admin's limits on pages' models (agents/page-llm.ts), on the Settings page (/admin/settings): the daily spend limit in US
// dollars (page_llm_daily_usd), which stops every page's call at today's estimated cost and turns them off at 0, with
// the view of today's use under the settings; and the switch "Guests can call pages' models" (page_llm_guests), which
// gives every signed-out visitor sign_in. Each test has a server of its own: the settings and the day's use are the
// whole server's. The scripted model: no real one.
import { expect, test, until, type Page, type Server } from "../../helpers/fixtures";
import { runTool } from "../../helpers/tools";
import { newDoc } from "./access";
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

const status = async (page: Page) => (await pageFrame(page)).evaluate(() => window.ergaLLM!.status());
const ask = async (page: Page, content: string) =>
  (await pageFrame(page)).evaluate(
    (content) =>
      window.ergaLLM!.ask({ messages: [{ role: "user", content }] }).then(
        (r): Result => r,
        (e: Error & { code?: string }): Result => ({ code: e.code, message: e.message })
      ),
    content
  );

/** A setting's value now, as the admin's agent reads it. */
const setting = async (s: Server, key: string) =>
  (await runTool<{ settings: { key: string; value: unknown }[] }>(s.root, "settings")).result?.settings.find((e) => e.key == key)?.value;

/** A document whose page may call Haiku 5.5, and its address in the viewer. */
async function llmDoc(s: Server, who: "signed_in" | "all" = "signed_in") {
  const made = await newDoc(s.root);
  expect((await runTool(s.root, "share_document", { document: made.id, page_llm: true, page_llm_who: who })).status).toBe(200);
  return { ...made, address: (s.root + made.at).replace(/[?&]edit=?$/, "") };
}

/** The view of today's use on /admin, as the page shows it. */
const usage = (page: Page) => page.locator("section.llm-use").innerText();

test("the daily spend limit stops pages' calls at today's estimated cost; the view shows the use; 0 turns them off", async ({ tab }) => {
  const page = tab.page;
  const s = await tab.own({ env: { ERGA_AGENT_MODEL: "script" } });
  const doc = await llmDoc(s);

  // The admin page: the limit, $5 at first, and no calls yet.
  await page.goto(`${s.root}/admin/settings`);
  const row = page.locator('li.setting[data-key="page_llm_daily_usd"]');
  expect(await row.locator(".key").innerText()).toBe("Pages' models: daily spend limit");
  expect(await row.locator("input[name=value]").inputValue()).toBe("5");
  expect(await row.locator(".unit").innerText()).toBe("US$");
  expect(await usage(page)).toContain("$0.00 of $5.00 today (0%)");
  expect(await usage(page)).toContain("No calls today.");

  // The admin sets one cent: what 20,000 of Haiku 5.5's output tokens cost ($0.50 for a million).
  await row.locator("input[name=value]").fill("0.01");
  await row.locator(".save").click();
  await expect.poll(() => setting(s, "page_llm_daily_usd")).toBe(0.01);

  await page.goto(doc.address);
  expect(await ask(page, '@script [{"text": "One.", "tokens": 20000}]')).toEqual({ text: "One." });
  const stopped = await ask(page, '@script [{"text": "Two."}]');
  expect(stopped.code).toBe("limit");
  expect(stopped.message).toContain("spend limit for today");

  // The view: one call, its tokens and cost, all of the limit, and the document.
  await page.goto(`${s.root}/admin/settings`);
  const shown = await usage(page);
  expect(shown).toContain("$0.010 of $0.01 today (100%)");
  expect(shown).toContain("Pages' calls stop until midnight UTC.");
  expect(await page.locator(".use-totals").innerText()).toMatch(
    /Calls\s+1\s+Input tokens\s+0\s+Output tokens\s+20,000\s+Estimated cost\s+\$0\.010/
  );
  expect(await page.locator(".use-docs tbody tr").count()).toBe(1);
  expect(await page.locator(".use-docs tbody tr").innerText()).toMatch(/1\s+0\s+20,000\s+\$0\.010/);
  // The admin's agent reads the same.
  const read = await runTool<{ pageModelsToday: object }>(s.root, "settings");
  expect(read.result?.pageModelsToday).toMatchObject({
    calls: 1,
    inputTokens: 0,
    outputTokens: 20000,
    costUsd: 0.01,
    limitUsd: 0.01,
    limitUsed: "100%",
  });

  // 0: pages' models are off.
  await page.locator('li.setting[data-key="page_llm_daily_usd"] input[name=value]').fill("0");
  await page.locator('li.setting[data-key="page_llm_daily_usd"] .save').click();
  await expect.poll(() => setting(s, "page_llm_daily_usd")).toBe(0);
  await page.reload();
  expect(await usage(page)).toContain("Pages' models are off");
  await page.goto(doc.address);
  expect(await status(page)).toMatchObject({ on: false });
  expect((await ask(page, "Hi")).code).toBe("off");
});

test("the guest switch: off, every signed-out visitor gets sign_in, where the owner lets all viewers call the model", async ({ tab }) => {
  const page = tab.page;
  const s = await tab.own({ env: { ERGA_AGENT_MODEL: "script" } });
  const doc = await llmDoc(s, "all");
  expect((await runTool(s.root, "share_document", { document: doc.id, login: "*", role: "viewer" })).status).toBe(200);
  const url = new URL(s.root);
  const signedOut = [{ name: `erga_signed_out_${url.port}`, value: "1", domain: url.hostname, path: "/" }];
  await page.context().addCookies(signedOut);
  await page.goto(doc.address);
  expect(await ask(page, '@script [{"text": "Hello, guest."}]')).toEqual({ text: "Hello, guest." });

  // The admin turns the switch off, on /admin.
  await page.context().clearCookies();
  await page.goto(`${s.root}/admin/settings`);
  const guests = page.locator("#set-page_llm_guests");
  expect(await page.locator('li.setting[data-key="page_llm_guests"] .key').innerText()).toBe("Guests can call pages' models");
  expect(await guests.isChecked()).toBe(true);
  await guests.click();
  await expect.poll(() => setting(s, "page_llm_guests")).toBe(false);

  // Signed out: sign_in. Signed in: the model still answers.
  await page.context().addCookies(signedOut);
  await page.goto(doc.address);
  expect((await ask(page, '@script [{"text": "Hello, guest."}]')).code).toBe("sign_in");
  await page.context().clearCookies();
  await page.goto(doc.address);
  expect(await ask(page, '@script [{"text": "Hello, Ada."}]')).toEqual({ text: "Hello, Ada." });
});

test("a switch flipped twice during its save: the server ends with the last value shown", async ({ tab }) => {
  const page = tab.page;
  const s = await tab.own({ env: { ERGA_AGENT_MODEL: "script" } });
  await page.goto(`${s.root}/admin/settings`);
  const guests = page.locator("#set-page_llm_guests");
  expect(await guests.isChecked()).toBe(true);
  // A slow network: each save takes a moment, so the second flip comes during the first save.
  const saves: string[] = [];
  await page.route("**/api/tools/set_setting*", async (route) => {
    saves.push(route.request().postData() ?? "");
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await guests.click();
  await guests.click();
  expect(await guests.isChecked()).toBe(true);
  // The second save goes once the first ended (the server has false then), and puts back true.
  await expect.poll(() => saves.length).toBe(2);
  await expect.poll(() => setting(s, "page_llm_guests")).toBe(true);
  await expect.poll(() => page.locator('li.setting[data-key="page_llm_guests"] .hint').innerText()).toBe("Saved.");
  await page.reload();
  expect(await page.locator("#set-page_llm_guests").isChecked()).toBe(true);
});
