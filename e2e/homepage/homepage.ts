// Helpers for the homepage's journeys (homepage.e2e.ts): / as someone signed out gets it, the landing_document setting,
// the homepage's state and its deploys, a site made the homepage, and requests to the homepage's own domain.
//
// Trap: Node's fetch can't name home.localhost (the homepage's own domain in the tests): `onHome` sends the Host header
// with node:http. The browser reaches it.
// Trap: / is served in two ways, and both are right: the viewer on the homepage's document (a frame: `frameOf`), until
// its first deploy is done, then the deployed page itself with Erga's controls (`direct`). `docOf` reads both.
import { request } from "node:http";
import type { Page } from "playwright-core";
import { until, type Server } from "../helpers/fixtures";
import { runTool } from "../helpers/tools";

export interface HomeState {
  isHome: boolean;
  canDeploy: boolean;
  deploy: { state: string; version: number | null; at: string | null; error?: string | null };
}
/** deploy_homepage's answer: the deploy, and where its files are live. */
export interface Redeployed {
  deploy: { state: string; version: number | null; error: string | null };
  live: { url: string; files: Record<string, string> } | null;
}

/** A name that no other test (nor a repeat of this one) uses: for logins and titles. */
export const unique = (name: string) => `${name}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

export const get = (server: Server, path: string, init: RequestInit = {}) => fetch(server.root + path, { redirect: "manual", ...init });

/**
 * Signed out, on the dev server (where a request without a cookie is DEV_LOGIN's): / is the homepage only then. The
 * cookie's name carries the server's port (server/identity/cookies.ts).
 */
export const signedOut = (server: Server) => ({ Cookie: `erga_signed_out_${server.port}=1` });

/** / as served to someone signed out: its text, and whether it is the deployed page with Erga's controls. */
export async function front(server: Server) {
  const html = await (await get(server, "/", { headers: signedOut(server) })).text();
  return { html, direct: html.includes("<erga-controls") };
}
/** The viewer's document, and its owner, as its page names them: [, id, owner] (the homepage project's: "_home"). */
export const frameOf = (html: string) => {
  const id = /<meta name="erga-doc" content="([a-z0-9]{8})">/.exec(html)?.[1],
    owner = /<meta name="erga-address" content="\/([a-z0-9-]+\/|_home")/.exec(html)?.[1].replace(/[/"]$/, "");
  return id && owner ? ([html, id, owner] as const) : null;
};
/** The document / shows: in the viewer's frame, or served directly (its controls name it). */
export const docOf = (html: string) => frameOf(html)?.[1] ?? /<erga-controls data-doc="([a-z0-9]{8})"/.exec(html)?.[1];

/** The landing_document setting as /admin/settings shows it (the document's address). */
export const landingSetting = async (server: Server) =>
  (await (await get(server, "/admin/settings")).text()).match(/data-key="landing_document"[\s\S]*?name="value"[^>]*value="([^"]*)"/)?.[1] ??
  "";

/** Makes a document the homepage, as an admin does on /admin/settings (landing_document): the tool's answer. */
export const setLanding = (server: Server, id: string) => runTool(server.root, "set_setting", { key: "landing_document", value: id });
/** Makes the homepage project (/_home, which the deploy's step made) the homepage again. */
export const projectHome = (server: Server) => setLanding(server, "/_home");

/** The homepage's state, as ls answers it to `user` (the dev server's ?user=; none: its own person); not the homepage: { isHome: false }. */
export const homeOf = async (server: Server, id: string, user?: string) =>
  ((await runTool(server.root, "ls", { document: id }, user ? { user } : {})).result?.homepage ?? { isHome: false }) as HomeState;

/** deploy_homepage (Deploy in the settings), as `user`, from `origin` (the site's own, unless given): it answers when the deploy is done. */
export const redeploy = (server: Server, user?: string, origin?: string) =>
  runTool<Redeployed>(server.root, "deploy_homepage", {}, { ...(user ? { user } : {}), ...(origin ? { origin } : {}) });

/** Writes files into a document, as its person publishes them (the write tool, in person). */
export async function write(server: Server, document: string, files: Record<string, string>) {
  const r = await runTool(server.root, "write", { document, files });
  if (!r.ok) throw new Error(`write: ${r.error}`);
}

/** A project of DEV_LOGIN's with these files: its id and address. */
export async function makeSite(server: Server, files: Record<string, string>) {
  const made = await runTool<{ id: string; address: string }>(server.root, "create_document", {
    title: unique("Site home "),
    kind: "project",
    files,
  });
  if (!made.ok) throw new Error(`create_document: ${made.error}`);
  return { id: made.result!.id, address: made.result!.address };
}

/** A project of DEV_LOGIN's with these files, made the homepage, once its first deploy is done: its id and address. */
export async function siteHome(server: Server, files: Record<string, string>) {
  const site = await makeSite(server, files);
  const set = await setLanding(server, site.id);
  if (!set.ok) throw new Error(`landing_document: ${set.error}`);
  await until(async () => (await homeOf(server, site.id)).deploy.state == "deployed", 10_000, "the homepage's first deploy is done");
  return site;
}

/**
 * The document's events ({ type } messages, the text frames on a tab's socket: /d/<id>/api/room?events=1), as a list
 * that fills as they come.
 */
export async function events(server: Server, id: string) {
  const seen: { type: string }[] = [];
  const ws = new WebSocket(`${server.root.replace(/^http/, "ws")}/d/${id}/api/room?events=1`);
  ws.onmessage = (e) => {
    if (typeof e.data == "string") seen.push(JSON.parse(e.data));
  };
  await until(() => ws.readyState == WebSocket.OPEN, 5_000, "the event socket opens");
  return Object.assign(seen, { close: () => ws.close(), of: (type: string) => seen.filter((m) => m.type == type) });
}

/** Opens / signed out, as the homepage is served: someone signed in goes to /docs (server/app.ts). The tab stays signed out. */
export async function openHome(page: Page, server: Server) {
  await page.context().addCookies([{ name: `erga_signed_out_${server.port}`, value: "1", url: server.root }]);
  await page.goto(`${server.root}/`);
}

/** The homepage's own domain in the tests: the browser sends <anything>.localhost to this machine. */
export const HOME = "home.localhost";
/** That domain's origin, on the server's port. */
export const homeOrigin = (server: Server) => `http://${HOME}:${server.port}`;

export interface Answer {
  status: number;
  location: string | null;
  setCookie: string[];
  csp: string | null;
  /** The body as the server sent it. */
  text: string;
  /** The body without the page model's script, which each HTML page of the site gets first. */
  page: string;
}

/** A request to the homepage's own domain (the server, with the domain in Host). */
export const onHome = (server: Server, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Promise<Answer>((done, failed) => {
    const r = request(
      { host: "127.0.0.1", port: server.port, path, method: o.method ?? "GET", headers: { Host: `${HOME}:${server.port}`, ...o.headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (c: string) => (text += c));
        res.on("end", () =>
          done({
            status: res.statusCode ?? 0,
            location: res.headers.location ?? null,
            setCookie: res.headers["set-cookie"] ?? [],
            csp: (res.headers["content-security-policy"] as string) ?? null,
            text,
            page: text.replace(/<script>\(\(\)=>[^]*?<\/script>/, ""),
          })
        );
      }
    );
    r.on("error", failed);
    r.end(o.body);
  });

/** What a page's script gets from ergaLLM.ask(): the answer's text, or the refusal's code. */
export const ask = (page: Page, content: string) =>
  page.evaluate(
    (content) =>
      (window as any).ergaLLM.ask({ messages: [{ role: "user", content }] }).then(
        (r: { text?: string }) => r,
        (e: Error & { code?: string }) => ({ code: e.code, message: e.message })
      ) as Promise<{ text?: string; code?: string; message?: string }>,
    content
  );
/** The page model's state, as the page's script reads it. */
export const llmStatus = (page: Page) =>
  page.evaluate(() => (window as any).ergaLLM.status() as { on: boolean; model: string; signedIn: boolean });
