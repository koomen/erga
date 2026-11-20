// The Document LLM API as the server's admin has it (the settings document_llm_api, document_llm_models_off,
// document_llm_guests): what a document's author reads and may set (share_document, on an in-memory directory), and
// what the document's script gets from the route (agents/page-llm.ts, on the whole app in memory, with the scripted
// model).

import { expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import { ADMIN_OFF, Directory, modelOff } from "../server/directory/index.ts";
import { allTools, runTool } from "../agents/tools";
import type { AgentConfig } from "../agents/models";
import { type Caller, OperationError } from "../server/operations/index.ts";
import type { Platform } from "../server/platform";
import { PAGE_LLM_OFF_AT_FIRST } from "../shared/models";
import { person, ROOT, runTool as overHttp, server } from "./helpers/app";
import { memory } from "./helpers/memory-sql";

const root = { login: "root", admin: true };
const tool = (name: string) => allTools().find((t) => t.name == name)!;
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as OperationError;
  }
  throw new Error("it didn't fail");
};
const cfg = (o: Partial<AgentConfig>): AgentConfig => ({
  own: {},
  server: {},
  mode: "server",
  off: [],
  model: "opus",
  effort: "high",
  ...o,
});

test("a document's author: the models the admin left on; a chosen model that goes off, and the API off, are said; nobody turns on what is off", async () => {
  const dir = new Directory(memory(), { defaults: { anyone_access: "public", public_sharing: true }, admins: ["root"] });
  await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Plan", created: 1 });
  let keys = cfg({ server: { anthropic: Redacted.make("k1"), openai: Redacted.make("k2") }, off: ["sonnet"] });
  const ada: Caller = { dir, who: { login: "ada" }, platform: { agentSettings: async () => keys } as unknown as Platform };
  const share = async (args: Record<string, unknown>) =>
    ((await runTool(tool("share_document"), { document: "plan", ...args }, ada)) as { llmApi: Record<string, unknown> }).llmApi;
  // At first: every model of a provider with a key, but the fast modes (the agents' own list of models doesn't count here).
  expect(await dir.config.get("document_llm_models_off")).toEqual(PAGE_LLM_OFF_AT_FIRST);
  expect(await share({ llm_api: true, llm_api_model: "sonnet", llm_api_who: "all" })).toEqual({
    enabled: true,
    on: true,
    model: "sonnet",
    models: ["haiku", "sonnet", "opus", "opus-fast", "fable", "gpt-6-luna", "gpt-6.1-terra", "gpt-6.2-sol", "gpt-6.2-astra"],
    who: "all",
    guests: true,
  });
  // The admin switches Sonnet off (and the fast modes on): the document keeps its choice, and its author reads why
  // it doesn't work. Nobody chooses it now.
  await dir.config.set(root, "document_llm_models_off", ["sonnet"]);
  let now = await share({ llm_api_who: "all" });
  expect(now.note).toBe(modelOff("sonnet"));
  expect(now.note).toBe(
    "This server's admin turned Sonnet 5.5 off for the Document LLM API. The document's author can choose another model."
  );
  expect([now.model, (now.models as string[]).includes("sonnet"), (now.models as string[]).includes("fable-fast")]).toEqual([
    "sonnet",
    false,
    true,
  ]);
  let e = await failure(share({ llm_api_model: "sonnet" }));
  expect([e.status, e.message]).toEqual([409, modelOff("sonnet")]);
  // A model whose provider has no key: the same rule, in other words.
  keys = cfg({ server: { anthropic: Redacted.make("k1") } });
  e = await failure(share({ llm_api_model: "gpt-6-luna" }));
  expect([e.status, e.message]).toEqual([409, "The server has no API key that runs GPT-6 Luna for the Document LLM API."]);
  expect((await share({ llm_api_model: "haiku" })).note).toBeUndefined();
  // Each person brings their own keys: the server's keys run nothing, for documents too.
  keys = cfg({ server: { anthropic: Redacted.make("k1") }, mode: "own" });
  expect(await share({ llm_api_who: "all" })).toMatchObject({
    models: [],
    note: "The server has no API key that runs Haiku 5.5 for the Document LLM API.",
  });
  keys = cfg({ server: { anthropic: Redacted.make("k1") } });
  // Viewers who aren't signed in: the admin's switch alone (a published site's visitors, also while users can't share
  // publicly).
  await dir.config.set(root, "document_llm_guests", false);
  now = await share({ llm_api_who: "all" });
  expect([now.guests, now.note]).toEqual([
    false,
    "On this server, viewers who aren't signed in can't use the Document LLM API: they sign in first.",
  ]);
  expect((await share({ llm_api_who: "signed_in" })).note).toBeUndefined();
  await dir.config.set(root, "document_llm_guests", true);
  await dir.config.set(root, "public_sharing", false);
  now = await share({ llm_api_who: "all" });
  expect([now.guests, now.note]).toEqual([true, undefined]);
  // The admin turns the API off: the author reads it; the document may turn its own off, and nobody turns one on.
  await dir.config.set(root, "document_llm_api", false);
  expect(await share({ llm_api_model: "opus" })).toMatchObject({ enabled: false, on: true, note: ADMIN_OFF });
  expect(await share({ llm_api: false })).toMatchObject({ enabled: false, on: false, note: ADMIN_OFF });
  e = await failure(share({ llm_api: true }));
  expect([e.status, e.message]).toEqual([409, "This server's admin turned the Document LLM API off."]);
});

test("a document's script: it gets the model's answer; with the API off, its model off, or a spend limit of 0, a clear error (off)", async () => {
  const s = server();
  // The scripted model stands in for every provider's.
  s.platform.agentSettings = async () => cfg({ model: "script" });
  const { config } = s.platform.directory,
    root = { login: "tester", admin: true };
  const ada = await person(s);
  const doc = await ada.make();
  expect((await overHttp(s, "share_document", { document: doc, llm_api: true }, { cookie: ada.cookie })).status).toBe(200);
  const ask = async () => {
    const r = await ada.get("/api/llm", {
      method: "POST",
      headers: { Origin: ROOT, "Content-Type": "application/json" },
      body: JSON.stringify({ document: doc, messages: [{ role: "user", content: "Hi" }] }),
    });
    return [r.status, (await r.json()) as { text?: string; error?: string; code?: string }] as const;
  };
  const on = async () => ((await (await ada.get(`/api/llm?document=${doc}`, { headers: { Origin: ROOT } })).json()) as { on: boolean }).on;
  let [status, body] = await ask();
  expect([status, typeof body.text, await on()]).toEqual([200, "string", true]);
  // The admin switches the document's model off: the error says so, in words for the document's author too.
  await config.set(root, "document_llm_models_off", ["haiku"]);
  expect(await ask()).toEqual([403, { code: "off", error: modelOff("haiku") }]);
  expect(await on()).toBe(false);
  // Another model: it answers again.
  expect((await overHttp(s, "share_document", { document: doc, llm_api_model: "sonnet" }, { cookie: ada.cookie })).status).toBe(200);
  [status, body] = await ask();
  expect([status, typeof body.text]).toEqual([200, "string"]);
  // A daily spend limit of 0, and the admin's switch: off.
  await config.set(root, "document_llm_daily_usd", 0);
  expect(await ask()).toEqual([403, { code: "off", error: ADMIN_OFF }]);
  await config.set(root, "document_llm_daily_usd", 5);
  expect((await ask())[0]).toBe(200);
  await config.set(root, "document_llm_api", false);
  expect(await ask()).toEqual([403, { code: "off", error: "This server's admin turned the Document LLM API off." }]);
  expect(await on()).toBe(false);
});

test("the Agents and models page: the Document LLM API's section; unauthenticated viewers' switch is the admin's also while users can't share publicly, with a note; no secret of the deploy's", async () => {
  const s = server();
  const { config } = s.platform.directory,
    root = { login: "tester", admin: true };
  const page = async () => (await s.fetch("/admin/agents")).text();
  await config.set(root, "public_sharing", false);
  const html = await page();
  expect(html).toContain(`<h3 class="sub-head" id="llm-api-head">Document LLM API</h3>`);
  expect(html).toContain(`<p class="lede">An LLM API that users can expose to their documents.</p>`);
  expect(html).toContain(`<h3 class="sub-head" id="llm-use-head">Document LLM API Usage</h3>`);
  expect(html).toMatch(/<strong>This Month<\/strong> <span class="pct">\w+ \d{4}, UTC<\/span>/);
  expect(html).not.toMatch(/SECRETS_KEY"|deploy-secret|Pages' models|pages' models/);
  // Published sites are always public: the switch holds for them, on as it starts, whatever public sharing is.
  const guests = html.slice(html.indexOf(`data-key="document_llm_guests"`), html.indexOf(`data-key="document_llm_daily_usd"`));
  expect(guests).toContain(
    `<p class="desc">Where the author lets all viewers use it: on a published site always; in a document opened by its link, only while users can share publicly.</p>`
  );
  expect(guests).toMatch(/id="set-document_llm_guests" aria-label="[^"]*" data-kind="switch" checked><span/);
});
