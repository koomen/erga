// Helpers for the page model's journeys (window.ergaLLM, agents/page-llm.ts): what a page's own script gets from
// ergaLLM in the viewer's frame and on the homepage, the sign-in dialog as the viewer shows it, the owner's tool calls,
// and the homepage's project with an essay page. The model is the scripted one: a message "@script [...]" is its answer.

import type { Frame, Page } from "playwright-core";
import { expect, settle, until, type Server } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";
import { runTool } from "../helpers/tools";
import type {} from "../../client/common/page-llm";

export type Result = { text?: string; code?: string; message?: string };

/** A request to the server, its redirects not followed. */
export const get = (s: Server, path: string, init: RequestInit = {}) => fetch(s.root + path, { redirect: "manual", ...init });

/** A tool call as the owner (the test server's own person), which must pass. */
export async function owner<T = unknown>(s: Server, name: string, args: Record<string, unknown>): Promise<T> {
  const r = await runTool<T>(s.root, name, args);
  expect(r.error, `${name} ${JSON.stringify(args)}`).toBeUndefined();
  return r.result as T;
}

/** A new document from /new: its address in the viewer, its path and its id. */
export async function newDoc(s: Server) {
  const at = (await get(s, "/new")).headers.get("location")!.replace(/[?&]edit=?$/, "");
  const id = ((await (await get(s, `${at}/api/doc`)).json()) as { docName: { id: string } }).docName.id;
  return { id, path: at, address: s.root + at };
}

/** What a document's settings say of its page's model, as the owner's agent reads them (ls). */
export const pageLlmOf = async (s: Server, id: string) =>
  (await owner<{ access?: { pageLlm?: { on: boolean; model: string; who: string } } }>(s, "ls", { document: id })).access?.pageLlm;

/**
 * The cookie of a browser that signed out, on the test server (which signs in every other one). Its name carries the
 * server's port (server/identity/cookies.ts).
 */
export const signedOutCookie = (s: Server) => `erga_signed_out_${s.port}`;
export const signOut = (page: Page, s: Server) => page.context().addCookies([{ name: signedOutCookie(s), value: "1", url: s.root }]);

/** The document's page in the viewer's frame, once its script has ergaLLM. */
export const pageFrame = (page: Page) =>
  until(
    async () => {
      const f = await (await page.$("#frame"))?.contentFrame();
      return f && (await f.evaluate(() => !!window.ergaLLM)) ? f : null;
    },
    10_000,
    "the page has window.ergaLLM"
  ) as Promise<Frame>;

/** What a page's own script gets from ergaLLM.ask() with one user message: `where` is the page (the homepage) or its frame. */
export const askIn = (where: Page | Frame, content: string) =>
  where.evaluate(
    (content) =>
      window.ergaLLM!.ask({ system: "Be brief.", messages: [{ role: "user", content }], max_tokens: 800 }).then(
        (r): Result => r,
        (e: Error & { code?: string }): Result => ({ code: e.code, message: e.message })
      ),
    content
  );
/** The same in the viewer's frame, and ergaLLM.status() there. */
export const ask = async (page: Page, content: string) => askIn(await pageFrame(page), content);
export const status = async (page: Page) => (await pageFrame(page)).evaluate(() => window.ergaLLM!.status());

/** The sign-in dialog (client/common/sign-in-dialog.ts), as the tab shows it: how many, whether open, and its choices. */
export const signInState = (page: Page) =>
  page.evaluate(() => {
    const hosts = document.querySelectorAll("erga-sign-in");
    const d = hosts[0]?.shadowRoot?.querySelector("dialog");
    return {
      hosts: hosts.length,
      open: !!d?.open,
      choices: [...(d?.querySelectorAll<HTMLAnchorElement>("a.provider") ?? [])].map((a) => [a.textContent, a.getAttribute("href")]),
    };
  });
export const signInOpen = async (page: Page) => (await signInState(page)).open;

// The admin's limits on pages' models, on the Settings page (/admin/settings) and as the admin's agent reads them.

/** Today's use of pages' models, as the admin's agent reads it (the operation `settings`). */
export interface Use {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  limitUsd: number;
  limitUsed: string;
  costliest: { document: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }[];
}
const settings = (s: Server) => owner<{ settings: { key: string; value: unknown }[]; pageModelsToday: Use }>(s, "settings", {});
export const useToday = async (s: Server) => (await settings(s)).pageModelsToday;
/** A setting's value now. */
export const setting = async (s: Server, key: string) => (await settings(s)).settings.find((e) => e.key == key)?.value;
/** Puts a setting back to its default. */
export const resetSetting = (s: Server, key: string) => owner(s, "set_setting", { key, reset: true });

/** US dollars as the admin's view writes them (server/admin/page-llm.ts, usd). */
export const usd = (n: number) => (n > 0 && n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
/** What Haiku 5.5's tokens cost, in US dollars (PAGE_LLM_PRICES.haiku: $0.10 and $0.50 for a million). */
export const haikuCost = (input: number, output: number) => (input * 0.1 + output * 0.5) / 1_000_000;

/** A setting's row on the Settings page. */
export const row = (admin: Page, key: string) => admin.locator(`li.setting[data-key="${key}"]`);
/** The view of today's use on the Settings page, as the page shows it. */
export const usage = (admin: Page) => admin.locator("section.llm-use").innerText();

// The homepage (server/home/): / as served to someone signed out, and its project, published with an admin's token.

/** Makes a document the homepage (the setting landing_document); with no `id`, the homepage project (/_home) again. */
export const setLanding = (s: Server, id?: string) => owner(s, "set_setting", { key: "landing_document", value: id ?? "/_home" });

/** / as served to someone signed out. */
export const front = async (s: Server, path = "/") => (await get(s, path, { headers: { Cookie: `${signedOutCookie(s)}=1` } })).text();

const HOME = {
  "index.html": "<!doctype html><html><head><title>Home</title></head><body><h1>Home with an essay</h1></body></html>",
  "essays/essay.html": `<!doctype html><html><head><title>Essay</title><script>window.early = !!window.ergaLLM;</script></head><body><h1>The essay</h1></body></html>`,
};

/** Publishes files as a new document, with an admin's token (only that may edit the homepage): its id. */
export async function publish(s: Server, files: Record<string, string>, title?: string): Promise<string> {
  const token = await until(
    async () => (await newToken(s.root, { label: "Page model journey", scope: "admin" })).token || undefined,
    10_000,
    "an admin token"
  );
  const r = await get(s, "/api/publish", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ files, ...(title ? { title } : {}) }),
  });
  const body = (await r.json()) as { ok: boolean; id?: string; error?: string };
  if (!body.ok) throw new Error(`publishing: ${body.error}`);
  return body.id!;
}

/** A homepage with an essay page, whose model all viewers may call: its id. */
export async function homeWithEssay(s: Server): Promise<string> {
  const id = await publish(s, HOME, "Home with an essay");
  await setLanding(s, id);
  await expect.poll(async () => (await front(s)).includes("Home with an essay")).toBe(true);
  await owner(s, "share_document", { document: id, page_llm: true, page_llm_who: "all" });
  return id;
}

/** The page token in a homepage page as served signed out (server/home/llm-token.ts). */
export const tokenIn = async (s: Server, path: string) => /"(eyJ2Ijp7ImRvYyI6[\w-]+\.[\w-]+)"/.exec(await front(s, path))?.[1];

/** POST /api/llm signed out, as a script elsewhere might: `headers` over this site's Origin. The answer, with its status. */
export const call = (s: Server, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  get(s, "/api/llm", {
    method: "POST",
    headers: { Cookie: `${signedOutCookie(s)}=1`, Origin: s.root, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ messages: [{ role: "user", content: '@script [{"text": "Hi."}]' }], ...body }),
  }).then(async (r) => ({ status: r.status, ...((await r.json()) as Result & { error?: string }) }));
