/// <reference types="vite/client" />
// erga.dev's front door. It signs people in with GitHub and serves the
// app's own routes (front.ts), the same in local development: the demo
// read-only at /, new documents (blank, or a copy of the demo), each
// person's list, and everything under a document's address forwarded to
// that document's Durable Object (doc-host.ts):
//
//   /                          the demo, rendered, with an Edit button (and your documents, signed in)
//   /new                       a blank document for you (signs you in first); /new?from=demo a copy of the demo
//   /docs                      your documents (doc-list.ts), latest edit first; POST /docs/delete deletes one
//   /<owner>/<id>              the editor on that document (anyone signed in may edit)
//   /<owner>/<id>/<rest>       the document's own host: /api/..., /doc/..., the sockets
//   /auth/github[/callback]    signing in; /auth/logout signs out
//   /tokens                    a test token, for running the test suite against erga.dev
//   /auth/test?token=&as=      a test person (Ada, Bo...) signed in with one; they open only test documents
//   /page.js, /style.css, ...  the editor's own files (static assets)
//
// In local development only, the dev server (dev/plugin.ts) links files on
// disk to documents, proving itself with ERGA_LINK_SECRET:
//
//   POST /__erga/link              makes (or finds) the document for a file or folder, for whoever's signed in
//   /<owner>/<id>/api/mirror       the WebSocket that keeps that document and the files on disk the same

import { frontDoor, ID, OWNER, page, type Platform } from "../front";
import { allowed, finishSignIn, isDev, mintTestToken, sessionOf, signOut, startSignIn, testSignIn } from "./auth";
import type { Env } from "./env";

export { DocHost } from "./doc-host";
export { DocList } from "./doc-list";

/** The templates' files, by template then path ("demo" → { "index.html": "..." }). Text files only. */
const TEMPLATES: Record<string, Record<string, string>> = {};
for (const [path, text] of Object.entries(import.meta.glob("../templates/*/**", { query: "?raw", import: "default", eager: true }) as Record<string, string>)) {
  const [, name, rel] = /^\.\.\/templates\/([^/]+)\/(.+)$/.exec(path)!;
  (TEMPLATES[name] ??= {})[rel] = text;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    const assets = path == "/page.js" || path == "/frame.js" || path == "/style.css" || path.startsWith("/fonts/");
    // A document's pages origin (front.ts, pagesDoor) serves its frame and files, and nothing of this site's.
    if (url.hostname.endsWith(".erga-pages.dev") || url.hostname.endsWith(".localhost")) return assets ? env.ASSETS.fetch(request) : frontDoor(request, platform(env));
    if (path == "/auth/github") return startSignIn(env, request);
    if (path == "/auth/github/callback") return finishSignIn(env, request);
    if (path == "/auth/logout") return signOut(request);
    if (path == "/auth/test") return testSignIn(env, request);
    if (path == "/tokens") return tokens(env, request);
    if (assets) return env.ASSETS.fetch(request);
    if (path == "/__erga/link" || path.endsWith("/api/mirror")) return linked(env, request, url);
    return frontDoor(request, platform(env));
  },
} satisfies ExportedHandler<Env>;

/**
 * The front door (front.ts) on Cloudflare: people sign in with GitHub, a
 * document is a Durable Object named "<owner>/<id>" (doc-host.ts), and
 * each person's list is one named by their login (doc-list.ts).
 */
const platform = (env: Env): Platform => {
  const doc = (owner: string, id: string) => env.DOCS.getByName(`${owner.toLowerCase()}/${id}`);
  return {
    sessionOf: (request) => sessionOf(env, request),
    templates: TEMPLATES,
    editor: (request) => env.ASSETS.fetch(new Request(new URL("/editor.html", request.url))),
    mayCreate: (session, url) => allowed(env, session.login) || isDev(env, url),
    dev: (url) => isDev(env, url),
    // Locally (vite dev) each document's page runs on <id>-<owner>.localhost, which browsers send to this machine.
    pagesDomain: (url) => (url.hostname == "localhost" || url.hostname.endsWith(".localhost") || url.hostname == "127.0.0.1" ? "localhost" : "erga-pages.dev"),
    secret: env.SESSION_SECRET,
    docs: {
      create: (owner, id, files, index, opts) => doc(owner, id).create(owner, id, files, index, opts),
      exists: (owner, id) => doc(owner, id).exists(),
      delete: (owner, id) => doc(owner, id).delete(owner),
      unlist: (owner, id) => env.LISTS.getByName(owner.toLowerCase()).remove(id),
      list: (owner) => env.LISTS.getByName(owner.toLowerCase()).list(),
      fetch: (owner, id, request) => doc(owner, id).fetch(request),
    },
  };
};

/**
 * The dev server's routes, refused unless it's local development and the
 * request carries the dev server's secret (?link=).
 */
async function linked(env: Env, request: Request, url: URL): Promise<Response> {
  if (!isDev(env, url) || !env.ERGA_LINK_SECRET || url.searchParams.get("link") != env.ERGA_LINK_SECRET) return new Response("Not found", { status: 404 });
  if (url.pathname == "/__erga/link" && request.method == "POST") {
    const session = await sessionOf(env, request);
    const body = await request.json() as { id?: string; index?: string; path?: string; only?: boolean; owner?: string };
    // Whoever's signed in, unless the dev server names the owner (linking again what it linked last run).
    const owner = body.owner ?? session?.login;
    if (!owner || !OWNER.test(owner) || session?.test || !body.id || !ID.test(body.id) || !body.index || !body.path) return new Response("Bad link", { status: 400 });
    await env.DOCS.getByName(`${owner.toLowerCase()}/${body.id}`).link(owner, body.id, body.index, { path: body.path, only: !!body.only });
    return Response.json({ owner, id: body.id });
  }
  const [, owner, id] = /^\/([^/]+)\/([^/]+)\/api\/mirror$/.exec(url.pathname) ?? [];
  if (!owner || !OWNER.test(owner) || !ID.test(id) || request.headers.get("upgrade")?.toLowerCase() != "websocket") return new Response("Not found", { status: 404 });
  return env.DOCS.getByName(`${owner.toLowerCase()}/${id}`).fetch(new Request(new URL(`/api/mirror${url.search}`, url.origin), request));
}

/** /tokens: a fresh test token for the signed-in person, and how to use it. */
async function tokens(env: Env, request: Request): Promise<Response> {
  const session = await sessionOf(env, request);
  if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent("/tokens")}` } });
  if (session.test) return page("Not for test people", "Sign in as yourself to make a test token.", 403);
  const { token, expires } = await mintTestToken(env, session.login);
  const origin = new URL(request.url).origin;
  return page("Test token", `This token signs in test people (Ada, Bo, ...) who can open only test documents under
<b>/${session.login}/test…</b>, where a scripted agent stands in for the model, so the test suite runs here for free.
It lasts until ${expires.toUTCString()}. Each visit makes a new one.</p>
<p><code style="word-break:break-all;user-select:all">${token}</code></p>
<p>Run the suite against ${origin}:</p>
<p><code style="word-break:break-all;user-select:all">ERGA_TEST_TOKEN=${token} bun run test:prod</code>`, 200);
}
