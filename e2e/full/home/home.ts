// Helpers for the homepage tests (server/documents/landing.ts seedLanding, server/home/): / as served, the landing document, the homepage's state
// and deploys, and documents published through the server's API.
//
// On servers.short(), tests share the server's one homepage one after
// another: each starts from a fresh one (fresh(): landing_document reset, so
// the next / makes it again from assets/landing/) and puts it back after (the
// same, in test.afterEach), and finds the landing document's address from the
// server, never assumes it (a fresh one is /tester/landing-2 while an earlier
// one still holds /tester/landing).

import { until, type Server } from "../../helpers/fixtures";
import type { HomeState } from "../versions/versions";
import { postForm } from "../../helpers/form-post";

export type { HomeState };

export const get = (server: Server, path: string, init: RequestInit = {}) => fetch(server.root + path, { redirect: "manual", ...init });
export const post = (server: Server, path: string, body?: unknown, user?: string) =>
  get(server, `${path}${user ? `?user=${user}` : ""}`, { method: "POST", headers: { Origin: server.root, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** / as served: directly (from a deploy, with its controls), or the viewer's frame. */
export async function front(server: Server, user?: string) {
  const r = await get(server, `/${user ? `?user=${user}` : ""}`);
  const html = await r.text();
  return { html, direct: html.includes("<erga-controls"), timing: r.headers.get("server-timing") ?? "", headers: r.headers };
}
/** The viewer's document, and its owner, as its page names them: [, id, owner]. */
export const frameOf = (html: string) => { const id = /<meta name="erga-doc" content="([a-z0-9]{8})">/.exec(html)?.[1], owner = /<meta name="erga-address" content="\/([a-z0-9-]+)\//.exec(html)?.[1]; return id && owner ? [html, id, owner] as const : null; };
/** The document / shows: in the viewer's frame, or served directly (its controls name it). */
export const docOf = (html: string) => frameOf(html)?.[1] ?? /<erga-controls data-doc="([a-z0-9]{8})"/.exec(html)?.[1];
/** Edit's address on a page, if it has Edit. */
export const editOf = (html: string) => /href="([^"?]+)\?edit"/.exec(html)?.[1] ?? null;

/** The landing_document setting as /admin shows it (the document's address). */
export const landingSetting = async (server: Server) => (await (await get(server, "/admin")).text()).match(/data-key="landing_document"[\s\S]*?name="value"[^>]*value="([^"]*)"/)?.[1] ?? "";

/** Makes a document the homepage, as an admin does on /admin (landing_document): the setting's answer, or its error. */
export const setLanding = async (server: Server, id: string) =>
  (await (await get(server, "/admin/settings", { method: "POST", headers: { Origin: server.root }, body: new URLSearchParams({ key: "landing_document", value: JSON.stringify(id) }) })).json()) as { entry?: { value: unknown }; error?: string };

/** Unsets landing_document: the next / makes a fresh homepage from assets/landing/. */
export const resetLanding = (server: Server) => get(server, "/admin/settings", { method: "POST", headers: { Origin: server.root }, body: new URLSearchParams({ key: "landing_document", reset: "1" }) });

/** A fresh homepage from assets/landing/ (made by the first / after the reset): its id and address. */
export async function fresh(server: Server) {
  await resetLanding(server);
  const html = (await front(server)).html;
  const id = docOf(html);
  const address = editOf(html);
  if (!id || !address) throw new Error(`no landing document on /: ${html.slice(0, 600)}`);
  return { id, address };
}

/** Once / is served directly (the first deploy, which the first / started, is done). */
export const deployed = (server: Server, ms = 5_000) => until(async () => (await front(server)).direct, ms, "/ is served from a deploy");

/** GET /api/docs/<id>/home. */
export const home = async (server: Server, id: string, user?: string) => (await (await get(server, `/api/docs/${id}/home${user ? `?user=${user}` : ""}`)).json()) as HomeState;

/**
 * An admin-scope agent token of DEV_LOGIN's (only an admin's token with it may edit the homepage: server/directory/,
 * homeLimit; a documents token only views it). Asked again for a while: a server just started may still be setting up.
 */
export async function adminToken(server: Server) {
  return until<string | undefined>(async () => {
      const page = (await postForm(server.root, "/tokens/new", { label: "Home test", scope: "admin" })).page;
    return /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1];
  }, 10_000, "an admin token") as Promise<string>;
}

/** Publishes files with a token (POST /api/publish): a new document, or into `document`. */
export async function publish(server: Server, token: string, files: Record<string, string>, opts: { document?: string; title?: string } = {}) {
  const r = await get(server, "/api/publish", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ files, ...opts }) });
  const body = (await r.json()) as { ok: boolean; id?: string; url?: string; error?: string };
  if (!body.ok) throw new Error(`publishing: ${body.error}`);
  return body as { ok: true; id: string; url: string };
}
