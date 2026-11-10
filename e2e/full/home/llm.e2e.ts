// The homepage's model (window.ergaLLM, client/inline/home-llm.ts) on every HTML page of the homepage's project, for a
// visitor signed out too (agents/page-llm.ts), from its own pages only: this site's Origin, and the page's token
// (server/home/llm-token.ts). A signed-out visitor has a limit of their own, by IP address. The scripted model: no real one.
import { expect, servers, test, type Server } from "../../helpers/fixtures";
import { adminToken, front, get, openHome, publish, resetLanding, setLanding, signedOut } from "./home";
import { runTool } from "../../helpers/tools";
import type {} from "../../../client/common/page-llm";

await servers.short();
test.afterEach(async () => {
  await resetLanding(await servers.short());
});

const files = {
  "index.html": "<!doctype html><html><head><title>Home</title></head><body><h1>Home with an essay</h1></body></html>",
  "essays/essay.html": `<!doctype html><html><head><title>Essay</title><script>window.early = !!window.ergaLLM;</script></head><body><h1>The essay</h1></body></html>`,
};

/** A homepage with an essay page, page_llm as `on`: its id. */
async function homeWithEssay(server: Server, on: boolean) {
  const { id } = await publish(server, await adminToken(server), files, { title: "Home with an essay" });
  expect((await setLanding(server, id)).error).toBeUndefined();
  await expect.poll(async () => (await front(server)).html.includes("Home with an essay")).toBe(true);
  expect((await runTool(server.root, "share_document", { document: id, page_llm: on, page_llm_who: "all" })).error).toBeUndefined();
  return id;
}

type Result = { text?: string; code?: string; message?: string };

/** What the open page's script gets from ergaLLM.ask(). */
const ask = (page: import("playwright-core").Page, content: string) =>
  page.evaluate(
    (content) =>
      window.ergaLLM!.ask({ messages: [{ role: "user", content }] }).then(
        (r): Result => r,
        (e: Error & { code?: string }): Result => ({ code: e.code, message: e.message })
      ),
    content
  );

/** POST /api/llm signed out, as a script elsewhere might: `headers` over this site's Origin, from IP address `ip`. */
const call = (server: Server, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  get(server, "/api/llm", {
    method: "POST",
    headers: { ...signedOut(server), Origin: server.root, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ messages: [{ role: "user", content: '@script [{"text": "Hi."}]' }], ...body }),
  }).then(async (r) => ({ status: r.status, ...((await r.json()) as Result & { error?: string }) }));

/** The page token in a homepage page as served signed out. */
const tokenIn = async (server: Server, path: string) =>
  /"(eyJ2Ijp7ImRvYyI6[\w-]+\.[\w-]+)"/.exec(await (await get(server, path, { headers: signedOut(server) })).text())?.[1];

test("signed out, every page of the homepage's project has ergaLLM, which answers where page_llm is on", async ({ tab }) => {
  const server = await servers.short();
  const id = await homeWithEssay(server, false);
  const p = tab.page;
  await openHome(p, server.root);
  expect((await ask(p, "Hi")).code).toBe("off");
  await p.goto(`${server.root}/essays/essay.html`);
  expect(await p.locator("h1").textContent()).toBe("The essay");
  // Before the page's own scripts.
  expect(await p.evaluate(() => (window as unknown as { early: boolean }).early)).toBe(true);
  expect(await p.evaluate(() => window.ergaLLM!.status())).toEqual({ on: false, model: null, signedIn: false });
  expect((await ask(p, "Hi")).code).toBe("off");
  expect((await runTool(server.root, "share_document", { document: id, page_llm: true })).error).toBeUndefined();
  expect(await ask(p, '@script [{"text": "Hello from the essay."}]')).toEqual({ text: "Hello from the essay." });
  await openHome(p, server.root);
  expect(await ask(p, '@script [{"text": "Hello from home."}]')).toEqual({ text: "Hello from home." });
});

test("signed out, the homepage's model refuses a call from elsewhere, without its page's token, or over the visitor's hour", async () => {
  const server = await servers.short();
  const id = await homeWithEssay(server, true);
  const token = await tokenIn(server, "/essays/essay.html");
  expect(token).toBeTruthy();
  expect(await tokenIn(server, "/")).toBeTruthy();
  const ip = { "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 250)}` };
  // From the page: answered.
  expect(await call(server, { document: id, token }, ip)).toEqual({ status: 200, text: "Hi." });
  // From another site: Origin, or the browser's Sec-Fetch-Site.
  expect((await call(server, { document: id, token }, { ...ip, Origin: "https://elsewhere.example" })).status).toBe(403);
  expect((await call(server, { document: id, token }, { ...ip, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  // No token, or one that isn't this server's.
  expect(await call(server, { document: id }, ip)).toMatchObject({ status: 403, error: "Reload this page to use its model." });
  expect((await call(server, { document: id, token: token!.replace(/\.[\w-]+$/, ".AAAA") }, ip)).status).toBe(403);
  expect((await call(server, { document: id, token: "AAAA.AAAA" }, ip)).status).toBe(403);
  // Signed-in viewers only (share_document page_llm_who): sign_in, even from the page.
  expect((await runTool(server.root, "share_document", { document: id, page_llm_who: "signed_in" })).error).toBeUndefined();
  expect(await call(server, { document: id, token }, ip)).toMatchObject({ status: 401, code: "sign_in" });
  expect((await runTool(server.root, "share_document", { document: id, page_llm_who: "all" })).error).toBeUndefined();
  // Another document's model: signed out, only where it's shared with anyone and open to all viewers.
  const other = await publish(server, await adminToken(server), { "index.html": "<h1>Other</h1>" });
  expect((await runTool(server.root, "share_document", { document: other.id, page_llm: true })).error).toBeUndefined();
  expect((await runTool(server.root, "share_document", { document: other.id, login: "*", role: "viewer" })).error).toBeUndefined();
  expect(await call(server, { document: other.id, token }, ip)).toMatchObject({ status: 401, code: "sign_in" });
  // Open to all viewers: still not with the homepage's token, which is for its own document.
  expect((await runTool(server.root, "share_document", { document: other.id, page_llm_who: "all" })).error).toBeUndefined();
  expect(await call(server, { document: other.id, token }, ip)).toMatchObject({ status: 403, error: "Reload this page to use its model." });
  // One answer that used the visitor's whole hour (PAGE_LLM_LIMITS.guest.tokens: 30,000); then "limit".
  const long = { document: id, token, messages: [{ role: "user", content: '@script [{"text": "Long.", "tokens": 30000}]' }] };
  expect(await call(server, long, ip)).toEqual({ status: 200, text: "Long." });
  expect(await call(server, { document: id, token }, ip)).toMatchObject({ status: 429, code: "limit" });
  // Another visitor (another IP address) still may.
  expect(await call(server, { document: id, token }, { "cf-connecting-ip": "198.51.100.7" })).toEqual({ status: 200, text: "Hi." });
});
