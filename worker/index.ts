/// <reference types="vite/client" />
// erga.dev's front door. It shows the demo read-only at /, signs people in
// with GitHub, makes each of them a fresh copy of the demo to edit, and
// forwards everything under a document's address to that document's
// Durable Object (doc-host.ts):
//
//   /                          the demo, rendered, with an Edit button
//   /new                       a fresh copy of the demo for you (signs you in first)
//   /<owner>/<id>              the editor on that document (anyone signed in may edit)
//   /<owner>/<id>/<rest>       the document's own host: /api/..., /doc/..., the sockets
//   /auth/github[/callback]    signing in; /auth/logout signs out
//   /page.js, /style.css, ...  the editor's own files (static assets)

import { allowed, finishSignIn, isDev, page, safeNext, sessionOf, signOut, startSignIn, type Session } from "./auth";
import type { Env } from "./env";

export { DocHost } from "./doc-host";

/** The templates' files, by template then path ("demo" → { "index.html": "..." }). Text files only. */
const TEMPLATES: Record<string, Record<string, string>> = {};
for (const [path, text] of Object.entries(import.meta.glob("../templates/*/**", { query: "?raw", import: "default", eager: true }) as Record<string, string>)) {
  const [, name, rel] = /^\.\.\/templates\/([^/]+)\/(.+)$/.exec(path)!;
  (TEMPLATES[name] ??= {})[rel] = text;
}

const OWNER = /^[A-Za-z0-9-]{1,39}$/, ID = /^[a-z0-9]{8}$/;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ALPHABET[b % ALPHABET.length]).join("");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path == "/") return viewDemo();
    if (path == "/auth/github") return startSignIn(env, request);
    if (path == "/auth/github/callback") return finishSignIn(env, request);
    if (path == "/auth/logout") return signOut(request);
    if (path == "/new") return newDoc(env, request);
    if (path == "/page.js" || path == "/style.css" || path.startsWith("/fonts/")) return env.ASSETS.fetch(request);

    const [, owner, id, rest] = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path) ?? [];
    if (!owner || !OWNER.test(owner) || !ID.test(id)) return page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
    const doc = env.DOCS.getByName(`${owner.toLowerCase()}/${id}`);
    const session = await sessionOf(env, request);

    // The editor itself: sign in first, then the page that joins the document.
    if (!rest || rest == "/") {
      if (!session) return signInFirst(path);
      if (!(await doc.exists())) return page("Not found", "There's no document here. <a href=\"/\">Back to the start</a>.", 404);
      const editor = await env.ASSETS.fetch(new Request(new URL("/editor.html", url)));
      return new Response(editor.body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    // An external agent brings its share token, which the document checks; everyone else needs a session.
    if (!session && !rest.startsWith("/api/ext")) return new Response("Sign in first", { status: 401 });
    return forward(doc, request, url, rest, `${url.origin}/${owner}/${id}`, session);
  },
} satisfies ExportedHandler<Env>;

/** The demo as anyone sees it: just the page, and an Edit button. */
function viewDemo(): Response {
  const html = TEMPLATES.demo["index.html"].replace("</body>", `${EDIT_BUTTON}</body>`);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}

const EDIT_BUTTON = `<a href="/new" class="erga-edit-button">Edit</a>
<style>
  .erga-edit-button { position: fixed; top: 16px; right: 16px; z-index: 1000; padding: 7px 16px; border-radius: 999px;
    font: 600 14px/1.2 system-ui, -apple-system, sans-serif; text-decoration: none; color: #fff; background: #1b2330;
    box-shadow: 0 2px 10px rgba(20, 28, 40, .2); }
  .erga-edit-button:hover { background: #2f3b4d; }
  @media (prefers-color-scheme: dark) { .erga-edit-button { color: #12161d; background: #e4e8ee; } .erga-edit-button:hover { background: #fff; } }
</style>`;

/** A fresh copy of the demo for the signed-in person, at /<login>/<id>. */
async function newDoc(env: Env, request: Request): Promise<Response> {
  const session = await sessionOf(env, request);
  if (!session) return signInFirst("/new");
  if (!allowed(env, session.login) && !isDev(env, new URL(request.url))) return page("Invite only", "Erga is invite-only for now.", 403);
  // Local development may name the document (the test suite wants "test" in its address).
  const wanted = new URL(request.url).searchParams.get("id");
  for (let tries = 0; tries < 5; tries++) {
    const id = wanted && isDev(env, new URL(request.url)) && ID.test(wanted) ? wanted : newId();
    if (await env.DOCS.getByName(`${session.login.toLowerCase()}/${id}`).create(session.login, TEMPLATES.demo, "index.html")) {
      return new Response(null, { status: 302, headers: { Location: `/${session.login}/${id}` } });
    }
  }
  return page("Couldn't make a document", "Something went wrong picking an address. <a href=\"/new\">Try again</a>.", 500);
}

const signInFirst = (next: string) => new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(safeNext(next))}` } });

/**
 * Hands a request to the document's Durable Object, with the path inside
 * the document, its public address, and who's asking (never what the
 * browser claimed: those headers are replaced).
 */
function forward(doc: DurableObjectStub, request: Request, url: URL, rest: string, base: string, session: Session | null): Promise<Response> {
  const inner = new URL(rest + url.search, url.origin);
  const headers = new Headers(request.headers);
  headers.delete("x-erga-person");
  headers.set("x-erga-base", base);
  if (session) headers.set("x-erga-person", JSON.stringify({ id: session.login.toLowerCase(), name: session.name }));
  return doc.fetch(new Request(inner, { method: request.method, headers, body: request.body, redirect: "manual" }));
}
