// The homepage's model (window.ergaLLM) on the homepage's own domain, with the Erga domain's rules: page_llm and its
// model, the page's token for a guest, the limits. Erga's paths there are under /_erga/ (server/app.ts): the model
// (agents/page-llm.ts, homeDomainLlmApi), and a sign-in through the Erga domain that gives the own domain a cookie of
// its own (server/identity/home-pass.ts). Here the own domain is home.localhost and the Erga domain 127.0.0.1: one
// server answers both. The scripted model: no real one.
import { request } from "node:http";
import { expect, servers, test, type Server } from "../../helpers/fixtures";
import { runTool } from "../../helpers/tools";
import { adminToken, get, home, publish, resetLanding, setLanding, signedOut } from "./home";
import type {} from "../../../client/common/page-llm";

const HOME = "home.localhost";
const own = () =>
  servers.of("home-domain-llm", {
    env: {
      ERGA_AGENT_MODEL: "script",
      ERGA_HOME_RECHECK_MS: "0",
      ERGA_DEPLOY: JSON.stringify({ home: HOME, app: { kind: "domain", hostname: "127.0.0.1" } }),
    },
  });
await own();
test.afterEach(async () => {
  await resetLanding(await own());
});

const files = {
  "index.html": "<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>",
  "essays/essay.html": `<!doctype html><html><head><title>Essay</title><script>window.early = !!window.ergaLLM;</script></head><body><h1>The essay</h1></body></html>`,
  "_erga/x.html": "<h1>Not served</h1>",
};

/** The site made the homepage, deployed, with page_llm on: its server and id. */
async function site() {
  const server = await own();
  const { id } = await publish(server, await adminToken(server), files, { title: "Home" });
  expect((await setLanding(server, id)).error).toBeUndefined();
  await expect.poll(async () => (await home(server, id)).deploy.state, { timeout: 10_000 }).toBe("deployed");
  expect((await runTool(server.root, "share_document", { document: id, page_llm: true })).error).toBeUndefined();
  return { server, id };
}

type Answer = { status: number; location: string | null; setCookie: string[]; text: string };

/** A request to the own domain (fetch here can't name it: the Host header, with node:http). */
const onHome = (server: Server, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Promise<Answer>((done, failed) => {
    const port = new URL(server.root).port;
    const r = request(
      { host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: { Host: `${HOME}:${port}`, ...o.headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (c: string) => (text += c));
        res.on("end", () =>
          done({ status: res.statusCode ?? 0, location: res.headers.location ?? null, setCookie: res.headers["set-cookie"] ?? [], text })
        );
      }
    );
    r.on("error", failed);
    r.end(o.body);
  });

const origin = (server: Server) => `http://${HOME}:${new URL(server.root).port}`;

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

test("on its own domain, the site's pages have ergaLLM; a guest may call it, and signing in comes back to the page", async ({ tab }) => {
  const { server } = await site();
  const p = tab.page;
  await p.goto(`${origin(server)}/essays/essay`);
  expect(await p.locator("h1").textContent()).toBe("The essay");
  // Before the page's own scripts.
  expect(await p.evaluate(() => (window as unknown as { early: boolean }).early)).toBe(true);
  expect(await p.evaluate(() => window.ergaLLM!.status())).toEqual({ on: true, model: expect.any(String), signedIn: false });
  expect(await ask(p, '@script [{"text": "Hello, guest."}]')).toEqual({ text: "Hello, guest." });

  // Signing in: the dialog's button goes through the Erga domain (signed in there: the dev login) and back here.
  await p.evaluate(() => window.ergaLLM!.signIn());
  const button = p.locator("erga-sign-in .provider").first();
  await expect.poll(() => button.isVisible()).toBe(true);
  expect(await button.getAttribute("href")).toMatch(/^\/_erga\/auth\/\w+\?next=%2Fessays%2Fessay$/);
  await Promise.all([p.waitForURL(`${origin(server)}/essays/essay`), button.click()]);
  expect(await p.locator("h1").textContent()).toBe("The essay");
  expect(await p.evaluate(() => window.ergaLLM!.status())).toMatchObject({ on: true, signedIn: true });
  expect(await ask(p, '@script [{"text": "Hello, signed in."}]')).toEqual({ text: "Hello, signed in." });
  // The cookie is the own domain's alone.
  const cookies = await p.context().cookies(origin(server));
  expect(cookies.map((c) => c.name)).toContain(`erga_visitor_${new URL(server.root).port}`);
  expect(cookies.find((c) => c.name.startsWith("erga_visitor"))).toMatchObject({ httpOnly: true, sameSite: "Lax" });
});

test("on its own domain, /_erga/ is Erga's: the model for the homepage only, a pass that must be good, nothing else", async () => {
  const { server, id } = await site();
  const json = { "Content-Type": "application/json", Origin: origin(server) };
  const body = (o: Record<string, unknown>) => JSON.stringify({ messages: [{ role: "user", content: '@script [{"text": "Hi."}]' }], ...o });
  const token = /"(home-llm:[a-z0-9]+:\d+\.[\w-]+)"/.exec((await onHome(server, "/essays/essay")).text)?.[1];
  expect(token).toBeTruthy();
  // The site's files under /_erga/ never answer.
  expect((await onHome(server, "/_erga/x.html")).status).toBe(404);
  expect((await onHome(server, "/_erga/x")).status).toBe(404);
  // A guest, from the page, with its token: answered. From another site, or with no token: no.
  const ip = { "cf-connecting-ip": "203.0.113.9" };
  const llm = (o: Record<string, unknown>, headers: Record<string, string> = {}) =>
    onHome(server, "/_erga/api/llm", { method: "POST", headers: { ...json, ...ip, ...headers }, body: body(o) });
  expect(await llm({ document: id, token })).toMatchObject({ status: 200, text: JSON.stringify({ text: "Hi." }) });
  expect((await llm({ document: id, token }, { Origin: "https://elsewhere.example" })).status).toBe(403);
  expect((await llm({ document: id, token }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await llm({ document: id })).status).toBe(403);

  // The pass: the Erga domain gives one to someone signed in there, and sends it to the own domain only.
  const pass = await get(server, "/auth/home-pass?provider=github&next=%2F%2Felsewhere.example");
  const to = new URL(pass.headers.get("location")!);
  expect(to.origin).toBe(origin(server));
  expect(to.pathname).toBe("/_erga/pass");
  expect(to.searchParams.get("next")).toBe("/");
  // Signed out there: the provider's sign-in first, back to the pass.
  const out = await get(server, "/auth/home-pass?provider=github&next=%2Fessays%2Fessay", { headers: signedOut(server) });
  expect(out.headers.get("location")).toBe(
    `/auth/github?next=${encodeURIComponent("/auth/home-pass?provider=github&next=%2Fessays%2Fessay")}`
  );
  // The own domain sends its sign-in there.
  expect((await onHome(server, "/_erga/auth/github?next=%2Fessays%2Fessay")).location).toBe(
    `${server.root}/auth/home-pass?provider=github&next=%2Fessays%2Fessay`
  );
  // A pass that isn't this server's, or is old: no cookie.
  const good = to.searchParams.get("pass")!;
  for (const bad of [good.replace(/\.[\w-]+$/, ".AAAA"), good.replace(/:\d+\./, `:${Date.now() - 120_000}.`)]) {
    const r = await onHome(server, `/_erga/pass?pass=${encodeURIComponent(bad)}&next=%2F`);
    expect(r.status).toBe(403);
    expect(r.setCookie).toEqual([]);
  }
  const signedIn = await onHome(server, `${to.pathname}${to.search}`);
  expect(signedIn).toMatchObject({ status: 302, location: "/" });
  const cookie = signedIn.setCookie[0].split(";")[0];
  expect(cookie).toMatch(/^erga_visitor_\d+=/);

  // With the cookie: signed in, for the homepage's model; another document's, never, even one the person may open.
  const status = await onHome(server, `/_erga/api/llm?document=${id}`, { headers: { Cookie: cookie } });
  expect(JSON.parse(status.text)).toMatchObject({ on: true, signedIn: true });
  expect(await llm({ document: id }, { Cookie: cookie })).toMatchObject({ status: 200, text: JSON.stringify({ text: "Hi." }) });
  const other = await publish(server, await adminToken(server), { "index.html": "<h1>Other</h1>" });
  expect((await runTool(server.root, "share_document", { document: other.id, page_llm: true })).error).toBeUndefined();
  expect(await llm({ document: other.id }, { Cookie: cookie })).toMatchObject({ status: 403 });
  // The Erga domain's session never counts here.
  const session = (await get(server, `/api/llm?document=${id}`).then((r) => r.json())) as { signedIn: boolean };
  expect(session.signedIn).toBe(true);
  expect(JSON.parse((await onHome(server, `/_erga/api/llm?document=${id}`)).text)).toMatchObject({ signedIn: false });
});
