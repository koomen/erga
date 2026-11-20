// Helpers for the publishing journeys (publishing.e2e.ts): / as someone signed out gets it, a document's publishing
// (ls), the operations that change it, a site made and published to a domain, requests to a custom domain, and the
// Publishing section of a document's settings.
//
// Trap: Node's fetch can't name site.localhost (a custom domain in the tests): `onDomain` sends the Host header with
// node:http. The browser reaches it.
import { request } from "node:http";
import type { Page } from "playwright-core";
import { agentClosed, until, type Server } from "../helpers/fixtures";
import { pressOn } from "../helpers/press";
import { runTool } from "../helpers/tools";

/** ls's publishing (server/operations/publishing.ts, publishingOf). */
export interface Publishing {
  domains: { domain: string; erga: boolean; document: { id: string; title: string; address: string } | null }[];
  domain: string | null;
  bars: boolean;
  state: string;
  at: string | null;
  version: number | null;
  serving: boolean;
  error: string | null;
  canPublish: boolean;
}
/** publish_document's answer: the publishing, and where its files are live. */
export interface Published {
  publishing: Publishing;
  live: { url: string; files: Record<string, string> } | null;
}

/** A name that no other test (nor a repeat of this one) uses: for logins and titles. */
export const unique = (name: string) => `${name}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

export const get = (server: Server, path: string, init: RequestInit = {}) => fetch(server.root + path, { redirect: "manual", ...init });

/**
 * Signed out, on the dev server (where a request without a cookie is DEV_LOGIN's): / is the published page only then.
 * The cookie's name carries the server's port (server/identity/cookies.ts).
 */
export const signedOut = (server: Server) => ({ Cookie: `erga_signed_out_${server.port}=1` });

/** / as served to someone signed out: its status, its text, and whether it has Erga's controls. */
export async function front(server: Server, path = "/") {
  const r = await get(server, path, { headers: signedOut(server) });
  const html = await r.text();
  return { status: r.status, html, controls: html.includes("<erga-controls") };
}
/** The document a viewer's page shows, as the page names it. */
export const frameOf = (html: string) => /<meta name="erga-doc" content="([a-z0-9]{8})">/.exec(html)?.[1];
/** The document a published page with Erga's controls is (its controls name it). */
export const docOf = (html: string) => /<erga-controls data-doc="([a-z0-9]{8})"/.exec(html)?.[1];

/** The Erga domain's name on a test server: its host. */
export const ergaOf = (server: Server) => new URL(server.root).host;

/** A document's publishing, as ls answers it to `user` (the dev server's ?user=; none: its own person); undefined: not theirs to see. */
export const publishingOf = async (server: Server, id: string, user?: string) =>
  (await runTool(server.root, "ls", { document: id }, user ? { user } : {})).result?.publishing as Publishing | undefined;

/** set_publishing ("Publish to" and the header bar in the settings), as `user`. */
export const setPublishing = (
  server: Server,
  document: string,
  args: { domain?: string; bars?: boolean; replace?: boolean },
  user?: string
) => runTool<{ publishing: Publishing }>(server.root, "set_publishing", { document, ...args }, user ? { user } : {});

/** publish_document (Publish in the settings), as `user`, from `origin` (the site's own, unless given): it answers when the publish is done. */
export const publish = (server: Server, document: string, user?: string, origin?: string) =>
  runTool<Published>(server.root, "publish_document", { document }, { ...(user ? { user } : {}), ...(origin ? { origin } : {}) });

/** Writes files into a document, as its person uploads them (the write tool, in person). */
export async function write(server: Server, document: string, files: Record<string, string>) {
  const r = await runTool(server.root, "write", { document, files });
  if (!r.ok) throw new Error(`write: ${r.error}`);
}

/** A project of DEV_LOGIN's with these files: its id, address and title. */
export async function makeSite(server: Server, files: Record<string, string>) {
  const title = unique("Site home ");
  const made = await runTool<{ id: string; address: string }>(server.root, "create_document", { title, files });
  if (!made.ok) throw new Error(`create_document: ${made.error}`);
  return { id: made.result!.id, address: made.result!.address, title };
}

/** A project of DEV_LOGIN's with these files, published to `domain` (also in another document's place): its id and address. */
export async function publishedSite(server: Server, files: Record<string, string>, domain: string) {
  const site = await makeSite(server, files);
  const set = await setPublishing(server, site.id, { domain, replace: true });
  if (!set.ok) throw new Error(`set_publishing: ${set.error}`);
  const done = await publish(server, site.id);
  if (done.result?.publishing.state != "published") throw new Error(`publish_document: ${done.error ?? done.result?.publishing.error}`);
  return site;
}

/** The default homepage (/_home, which the deploy's step made) on the Erga domain again, published. */
export async function homeAgain(server: Server) {
  await setPublishing(server, "/_home", { domain: ergaOf(server), replace: true });
  await publish(server, "/_home");
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

/** Opens / signed out, as the published page is served: someone signed in goes to /documents (server/app.ts). The tab stays signed out. */
export async function openRoot(page: Page, server: Server) {
  await page.context().addCookies([{ name: `erga_signed_out_${server.port}`, value: "1", url: server.root }]);
  await page.goto(`${server.root}/`);
}

/** The custom domains in the tests: the browser sends <anything>.localhost to this machine. */
export const SITE = "site.localhost",
  BLOG = "blog.localhost";
/** A custom domain's origin, on the server's port. */
export const originOf = (server: Server, domain: string) => `http://${domain}:${server.port}`;

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

/** A request to a custom domain (the server, with the domain in Host). */
export const onDomain = (
  server: Server,
  domain: string,
  path: string,
  o: { method?: string; headers?: Record<string, string>; body?: string } = {}
) =>
  new Promise<Answer>((done, failed) => {
    const r = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method: o.method ?? "GET",
        headers: { Host: `${domain}:${server.port}`, ...o.headers },
      },
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

// The Publishing section of a document's settings, in the editor, with real keys.

/** Opens a document's settings in the editor, with the gear, once the editor's controls are in (they fade in as it comes up). */
export async function openSettings(p: Page, at: string) {
  await agentClosed(p);
  await p.goto(at);
  const gear = () =>
    p.evaluate(() => {
      const g = document.getElementById("btn-settings"),
        r = g?.getBoundingClientRect();
      if (!g || !r?.width || getComputedStyle(g.closest(".chrome")!).opacity != "1") return null;
      const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      return document.elementFromPoint(at.x, at.y)?.closest("#btn-settings") == g ? at : null;
    });
  await until(gear, 10_000, "the gear can be clicked");
  await pressOn(p, "#btn-settings");
  // (=== false: the section is there, and shows. Before it is there, hidden is undefined.)
  await until(() => p.evaluate(() => document.getElementById("ds-pub")?.hidden === false), 5_000, "the settings show Publishing");
}
/** The Publishing section, as the person reads it. */
export const section = (p: Page) =>
  p.evaluate(() => {
    const $ = (id: string) => document.getElementById(id)!;
    const off = (id: string) => $(id).getAttribute("aria-disabled") == "true";
    return {
      to: $("ds-pub-domain").textContent!.trim(),
      toOff: off("ds-pub-domain"),
      menu: $("ds-pub-menu").hidden
        ? null
        : [...$("ds-pub-menu").querySelectorAll("li")].map((li) => [...li.children].map((c) => c.textContent).join(" | ")),
      ask: $("ds-pub-confirm").hidden ? null : $("ds-pub-ask").textContent,
      bars: [($("ds-bars-on") as HTMLInputElement).checked, ($("ds-bars-on") as HTMLInputElement).disabled],
      barsTip: $("ds-bars").dataset.tip ?? "",
      name: $("ds-pub-name").textContent,
      status: $("ds-status").textContent!.trim(),
      publish: [$("ds-publish").textContent, off("ds-publish"), $("ds-publish").classList.contains("newer")],
      publishTip: $("ds-publish").dataset.tip ?? "",
      tags: [...document.querySelectorAll("#ds-list .ds-tag")].map((t) => t.textContent),
    };
  });
/**
 * Once the section rests at `name` (the domain's, or "Not published"): its change's call has answered, so Publish is
 * not locked by it. (The section also hears of the change from the server, which may come first.)
 */
export const rests = (p: Page, name: string) =>
  until(
    async () => {
      const s = await section(p);
      return s.name == name && s.ask == null && (name == "Not published" || !s.publish[1]) ? s : null;
    },
    5_000,
    `the section rests at ${name}`,
    () => section(p)
  );

/**
 * "Publish to", with real keys: the menu opens, the arrows go `down` rows from the chosen one, and Enter chooses.
 * It is grey while a change's call runs (the section may show the change before that call answers): a press then does nothing.
 */
export async function choose(p: Page, down: number) {
  await until(async () => !(await section(p)).toOff, 5_000, "Publish to can be pressed");
  await pressOn(p, "#ds-pub-domain");
  await until(async () => (await section(p)).menu != null, 5_000, "the menu opens");
  for (let i = 0; i < Math.abs(down); i++) await p.keyboard.press(down > 0 ? "ArrowDown" : "ArrowUp");
  await p.keyboard.press("Enter");
}
