/// <reference types="vite/client" />
// erga.dev's front door. It shows the demo read-only at /, signs people in
// with GitHub, makes them documents (blank, or a copy of the demo), lists
// each person's documents, and forwards everything under a document's
// address to that document's Durable Object (doc-host.ts):
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

import { allowed, finishSignIn, isDev, mintTestToken, page, safeNext, sessionOf, signOut, startSignIn, testSignIn, type Session } from "./auth";
import { UNEDITED_HOURS } from "./doc-host";
import type { Listed } from "./doc-list";
import type { Env } from "./env";

export { DocHost } from "./doc-host";
export { DocList } from "./doc-list";

/** The templates' files, by template then path ("demo" → { "index.html": "..." }). Text files only. */
const TEMPLATES: Record<string, Record<string, string>> = {};
for (const [path, text] of Object.entries(import.meta.glob("../templates/*/**", { query: "?raw", import: "default", eager: true }) as Record<string, string>)) {
  const [, name, rel] = /^\.\.\/templates\/([^/]+)\/(.+)$/.exec(path)!;
  (TEMPLATES[name] ??= {})[rel] = text;
}

const OWNER = /^[A-Za-z0-9-]{1,39}$/, ID = /^[a-z0-9]{8}$/;
/** Test documents: what test people may open, and where the scripted agent stands in for the model. */
const TEST_ID = /^test[a-z0-9]{4}$/;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ALPHABET[b % ALPHABET.length]).join("");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path == "/") return viewDemo(await sessionOf(env, request));
    if (path == "/auth/github") return startSignIn(env, request);
    if (path == "/auth/github/callback") return finishSignIn(env, request);
    if (path == "/auth/logout") return signOut(request);
    if (path == "/auth/test") return testSignIn(env, request);
    if (path == "/tokens") return tokens(env, request);
    if (path == "/new") return newDoc(env, request);
    if (path == "/docs") return listDocs(env, request);
    if (path == "/docs/delete" && request.method == "POST") return deleteDoc(env, request);
    if (path == "/page.js" || path == "/style.css" || path.startsWith("/fonts/")) return env.ASSETS.fetch(request);

    const [, owner, id, rest] = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path) ?? [];
    if (!owner || !OWNER.test(owner) || !ID.test(id)) return page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
    const doc = env.DOCS.getByName(`${owner.toLowerCase()}/${id}`);
    const session = await sessionOf(env, request);
    if (session?.test && !TEST_ID.test(id)) return page("Test documents only", "Test people can open only test documents.", 403);

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

/** The demo as anyone sees it: just the page, and an Edit button (which makes you a copy of it). */
function viewDemo(session: Session | null): Response {
  const docs = session && !session.test ? `<a href="/docs" class="erga-edit-button erga-docs-button">Your documents</a>` : "";
  const html = TEMPLATES.demo["index.html"].replace("</body>", `${docs}${EDIT_BUTTON}</body>`);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}

const EDIT_BUTTON = `<a href="/new?from=demo" class="erga-edit-button">Edit</a>
<style>
  .erga-edit-button { position: fixed; top: 16px; right: 16px; z-index: 1000; padding: 7px 16px; border-radius: 999px;
    font: 600 14px/1.2 system-ui, -apple-system, sans-serif; text-decoration: none; color: #fff; background: #1b2330;
    box-shadow: 0 2px 10px rgba(20, 28, 40, .2); }
  .erga-edit-button:hover { background: #2f3b4d; }
  .erga-docs-button { right: 84px; color: #1b2330; background: #fff; }
  .erga-docs-button:hover { background: #eef1f5; }
  @media (prefers-color-scheme: dark) {
    .erga-edit-button { color: #12161d; background: #e4e8ee; } .erga-edit-button:hover { background: #fff; }
    .erga-docs-button { color: #e4e8ee; background: #1a2029; } .erga-docs-button:hover { background: #232a35; }
  }
</style>`;

/** The templates /new?from= may copy; anything else makes a blank document. */
const FROM = new Set(["demo"]);

/** A new document for the signed-in person, at /<login>/<id>: blank (templates/doc), or a copy of the demo. */
async function newDoc(env: Env, request: Request): Promise<Response> {
  const session = await sessionOf(env, request);
  const params = new URL(request.url).searchParams;
  if (!session) return signInFirst(`/new${params.size ? `?${params}` : ""}`);
  const wanted = params.get("id");
  const from = params.get("from");
  const template = TEMPLATES[from && FROM.has(from) ? from : "doc"];
  // A test person makes (or reuses) a test document under the address of whoever minted their token.
  if (session.test) {
    if (!wanted || !TEST_ID.test(wanted)) return page("Test documents only", "Name the test document: /new?id=test1234.", 400);
    const owner = session.test.by;
    await env.DOCS.getByName(`${owner.toLowerCase()}/${wanted}`).create(owner, wanted, template, "index.html", { test: true });
    return new Response(null, { status: 302, headers: { Location: `/${owner}/${wanted}` } });
  }
  if (!allowed(env, session.login) && !isDev(env, new URL(request.url))) return page("Invite only", "Erga is invite-only for now.", 403);
  // Local development may name the document (the test suite wants "test" in its address),
  // and say how soon it goes if nobody edits it (?unedited=<ms>, for tests/worker.ts).
  const dev = isDev(env, new URL(request.url));
  const unedited = (dev && Number(params.get("unedited"))) || undefined;
  for (let tries = 0; tries < 5; tries++) {
    const id = wanted && dev && ID.test(wanted) ? wanted : newId();
    if (await env.DOCS.getByName(`${session.login.toLowerCase()}/${id}`).create(session.login, id, template, "index.html", { unedited })) {
      return new Response(null, { status: 302, headers: { Location: `/${session.login}/${id}` } });
    }
  }
  return page("Couldn't make a document", "Something went wrong picking an address. <a href=\"/new\">Try again</a>.", 500);
}

/** /tokens: a fresh test token for the signed-in person, and how to use it. */
async function tokens(env: Env, request: Request): Promise<Response> {
  const session = await sessionOf(env, request);
  if (!session) return signInFirst("/tokens");
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

/** /docs: the signed-in person's documents, most recently edited first. */
async function listDocs(env: Env, request: Request): Promise<Response> {
  const session = await sessionOf(env, request);
  if (!session) return signInFirst("/docs");
  if (session.test) return page("Not for test people", "Test people have no documents of their own.", 403);
  const docs = await env.LISTS.getByName(session.login.toLowerCase()).list();
  return new Response(docsPage(session, docs, Date.now()), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** POST /docs/delete (id=...): deletes one of the signed-in person's documents. */
async function deleteDoc(env: Env, request: Request): Promise<Response> {
  const session = await sessionOf(env, request);
  if (!session || session.test) return new Response("Sign in first", { status: 401 });
  // Only from this site's own pages (the session cookie is SameSite=Lax already).
  if (request.headers.get("origin") != new URL(request.url).origin) return new Response("Forbidden", { status: 403 });
  const id = String((await request.formData()).get("id") ?? "");
  if (!ID.test(id)) return new Response("No such document", { status: 404 });
  const login = session.login.toLowerCase();
  // Gone already (or never made): drop a stale entry all the same.
  if (!(await env.DOCS.getByName(`${login}/${id}`).delete(login))) await env.LISTS.getByName(login).remove(id);
  return new Response(null, { status: 303, headers: { Location: "/docs" } });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "12 days ago", or the date (the page's script redoes it in the reader's zone). */
function ago(t: number, now: number): string {
  const min = Math.round((now - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min == 1 ? "" : "s"} ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} hour${hours == 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days == 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The documents view, in the editor's own type and colours (style.css), light or dark with the system. */
function docsPage(session: Session, docs: Listed[], now: number): string {
  const rows = docs.map((d) => {
    const left = d.expires != null ? Math.max(1, Math.ceil((d.expires - now) / 3600000)) : null;
    const note = left != null ? `<span class="note" title="A document nobody edits is deleted ${UNEDITED_HOURS} hours after it's made">Unedited · deleted in ${left}h</span>` : "";
    const when = new Date(d.modified).toISOString();
    return `  <li>
    <a class="doc" href="/${esc(session.login)}/${esc(d.id)}"><span class="title">${esc(d.title)}</span>${note}<time datetime="${when}">${ago(d.modified, now)}</time></a>
    <form method="post" action="/docs/delete" data-title="${esc(d.title)}"><input type="hidden" name="id" value="${esc(d.id)}"><button class="delete" aria-label="Delete ${esc(d.title)}" title="Delete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button></form>
  </li>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Documents · Erga</title>
<link rel="stylesheet" href="/fonts/inter.css">
<link rel="stylesheet" href="/style.css">
<style>
  body { font-size: 15px; line-height: 1.5; }
  main { max-width: var(--column); margin: 0 auto; padding: 14vh 20px 40px; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
  h1 { margin: 0; font-size: 24px; font-weight: 650; letter-spacing: -0.015em; color: var(--fg-strong); }
  .new { flex: none; padding: 7px 14px; border-radius: 999px; background: var(--fg-strong); color: var(--bg); font-size: 13px; font-weight: 600; text-decoration: none; transition: opacity 150ms ease; }
  .new:hover { opacity: 0.85; }
  :is(.new, .doc, .delete, footer a):focus-visible { outline: 2px solid var(--caret); outline-offset: 2px; border-radius: 6px; }
  ol { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--rule); }
  li:first-child { border-top: 1px solid var(--rule); }
  .doc { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 12px; padding: 13px 2px; color: inherit; text-decoration: none; }
  .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: var(--fg-strong); }
  .doc:hover .title { text-decoration: underline; text-decoration-color: var(--mark); text-decoration-thickness: 1px; text-underline-offset: 0.2em; }
  .note { flex: none; font-size: 12.5px; color: var(--chrome); }
  time { flex: none; margin-left: auto; font-size: 13px; color: var(--soft); font-feature-settings: "tnum"; white-space: nowrap; }
  form { margin: 0; }
  .delete { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--chrome); cursor: pointer; opacity: 0; transition: opacity 150ms ease, color 150ms ease, background-color 150ms ease; }
  .delete svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  li:hover .delete, .delete:focus-visible { opacity: 1; }
  .delete:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  @media (hover: none) { .delete { opacity: 1; } }
  .empty { margin: 0; padding: 28px 2px; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); color: var(--soft); }
  footer { padding-top: 40px; display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--chrome); }
  footer a { color: inherit; text-decoration: none; }
  footer a:hover { color: var(--chrome-hover); }
  @media (max-width: 520px) { .note { display: none; } main { padding-top: 8vh; } }
</style>
<main>
  <header>
    <h1>Documents</h1>
    <a class="new" href="/new">New document</a>
  </header>
  ${docs.length ? `<ol>\n${rows}\n  </ol>` : `<p class="empty">No documents yet. A new one starts blank, and goes away after ${UNEDITED_HOURS} hours if you never edit it.</p>`}
  <footer><span>Signed in as ${esc(session.login)}</span><a href="/">The demo</a><a href="/auth/logout">Sign out</a></footer>
</main>
<script>
  // Times in the reader's own language and zone, and a question before deleting.
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const t of document.querySelectorAll("time")) {
    const d = new Date(t.dateTime), s = (d - Date.now()) / 1000;
    t.title = d.toLocaleString();
    if (s > -60) t.textContent = "just now";
    else if (s > -3600) t.textContent = rtf.format(Math.round(s / 60), "minute");
    else if (s > -86400) t.textContent = rtf.format(Math.round(s / 3600), "hour");
    else if (s > -30 * 86400) t.textContent = rtf.format(Math.round(s / 86400), "day");
    else t.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  for (const f of document.querySelectorAll("form[data-title]")) {
    f.addEventListener("submit", (e) => { if (!confirm("Delete \\u201c" + f.dataset.title + "\\u201d? This can't be undone.")) e.preventDefault(); });
  }
</script>
</html>`;
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
