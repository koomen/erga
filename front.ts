// The front door: the app around the documents, the same on erga.dev
// (worker/index.ts) and the local host (open.ts). It's written against web
// Requests and Responses, and the platform supplies the rest (`Platform`):
// who's signed in, the templates, and the documents themselves (Durable
// Objects hosted, folders on disk locally, docs.ts).
//
//   /                          the demo, rendered, with an Edit button (and your documents, signed in)
//   /new                       a blank document for you (signs you in first); /new?from=demo a copy of the demo
//   /docs                      your documents, latest edit first; POST /docs/delete deletes one
//   /<owner>/<id>              the editor on that document (anyone signed in may edit)
//   /<owner>/<id>/<rest>       the document's own host (host.ts): /api/..., /doc/..., the sockets
//
// Signing in, the editor's own files and the WebSockets stay with each
// platform. The rule for when an unedited document goes (`afterUnedited`)
// is here; when to apply it is the platform's (an alarm hosted, a timer
// locally).

/** Who's signed in. */
export interface Session {
  login: string;
  name: string;
  /** A test person, signed in with a test token minted by `by` (hosted only). */
  test?: { by: string };
  /** Locally, the name a tab gave in ?user=, carried along in the links it follows. */
  as?: string;
}

/** A document as its owner's list shows it. */
export interface Listed {
  id: string;
  title: string;
  created: number;
  /** When a file last changed (when it was made, if never). */
  modified: number;
  /** When it goes away if nobody edits it (only while it's never been edited). */
  expires?: number;
  /** Locally, a document opened from disk: where its folder is. Deleting it only takes it off the list. */
  path?: string;
}

/** What the front door needs from the platform it runs on. */
export interface Platform {
  /** Who's asking, if anyone is signed in (locally, someone always is). */
  sessionOf(request: Request): Promise<Session | null>;
  /** The templates' text files, by template then path ("demo" → { "index.html": "..." }). */
  templates: Record<string, Record<string, string>>;
  /** The editor's page, served at each document's address. */
  editor(request: Request): Promise<Response>;
  /** Whether a person may make documents (hosted: those in ALLOWED_USERS). */
  mayCreate(session: Session, url: URL): boolean;
  /** Local development: /new may name the document (?id=) and shorten its unedited time (?unedited=<ms>). */
  dev(url: URL): boolean;
  docs: {
    /** Makes a document from a template's files; false if that address is taken. */
    create(owner: string, id: string, files: Record<string, string>, index: string, opts: { test?: boolean; unedited?: number }): Promise<boolean>;
    exists(owner: string, id: string): Promise<boolean>;
    /** Deletes one of `owner`'s documents; false if they have none by that id. */
    delete(owner: string, id: string): Promise<boolean>;
    /** Drops a stale entry from `owner`'s list. */
    unlist(owner: string, id: string): Promise<void>;
    /** `owner`'s documents, most recently changed first. */
    list(owner: string): Promise<Listed[]>;
    /** Hands a request to the document's host, its path already the one inside the document. */
    fetch(owner: string, id: string, request: Request): Promise<Response>;
  };
}

/** How long a new document lasts if nobody ever edits it. */
export const UNEDITED_HOURS = 24;
export const HOUR = 60 * 60 * 1000;

/**
 * When a document's unedited time is up: one that's been edited (or is a
 * test document) stays, one open somewhere waits an hour more, so it isn't
 * pulled from under someone about to type, and any other goes.
 */
export function afterUnedited(doc: { modified?: number; test?: boolean }, open: boolean, now: number): "keep" | "delete" | number {
  if (doc.modified || doc.test) return "keep";
  return open ? now + HOUR : "delete";
}

export const OWNER = /^[A-Za-z0-9-]{1,39}$/, ID = /^[a-z0-9]{8}$/;
/** Test documents: what test people may open, and where the scripted agent stands in for the model. */
export const TEST_ID = /^test[a-z0-9]{4}$/;
export const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ALPHABET[b % ALPHABET.length]).join("");

/** The front door's answer to a request, for any path (a page saying so when there's nothing there). */
export async function frontDoor(request: Request, platform: Platform): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path == "/") return viewDemo(platform, await platform.sessionOf(request));
  if (path == "/new") return newDoc(platform, request);
  if (path == "/docs") return listDocs(platform, request);
  if (path == "/docs/delete" && request.method == "POST") return deleteDoc(platform, request);

  const [, owner, id, rest] = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path) ?? [];
  if (!owner || !OWNER.test(owner) || !ID.test(id)) return page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  const session = await platform.sessionOf(request);
  if (session?.test && !TEST_ID.test(id)) return page("Test documents only", "Test people can open only test documents.", 403);

  // The editor itself: sign in first, then the page that joins the document.
  if (!rest || rest == "/") {
    if (!session) return signInFirst(path);
    if (!(await platform.docs.exists(owner, id))) return page("Not found", "There's no document here. <a href=\"/\">Back to the start</a>.", 404);
    const editor = await platform.editor(request);
    return new Response(editor.body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  // An external agent brings its share token, which the document checks; everyone else needs a session.
  if (!session && !rest.startsWith("/api/ext")) return new Response("Sign in first", { status: 401 });
  return platform.docs.fetch(owner, id, forwarded(request, url, rest, `${url.origin}/${owner}/${id}`, session));
}

/** A link on this site, keeping the name a local tab gave (?user=) if it gave one. */
const link = (path: string, session: Session | null) =>
  session?.as ? `${path}${path.includes("?") ? "&" : "?"}user=${encodeURIComponent(session.as)}` : path;

/** The demo as anyone sees it: just the page, and an Edit button (which makes you a copy of it). */
function viewDemo(platform: Platform, session: Session | null): Response {
  const docs = session && !session.test ? `<nav class="erga-docs-nav" aria-label="Documents"><a href="${esc(link("/docs", session))}" class="erga-edit-button erga-docs-button">‹ Documents</a></nav>` : "";
  const edit = `<a href="${esc(link("/new?from=demo", session))}" class="erga-edit-button">Edit</a>`;
  const html = platform.templates.demo["index.html"].replace("</body>", `${docs}${edit}${EDIT_BUTTON_STYLE}</body>`);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}

const EDIT_BUTTON_STYLE = `
<style>
  .erga-edit-button { position: fixed; top: 16px; right: 16px; z-index: 1000; padding: 7px 16px; border-radius: 999px;
    font: 600 14px/1.2 system-ui, -apple-system, sans-serif; text-decoration: none; color: #fff; background: #1b2330;
    box-shadow: 0 2px 10px rgba(20, 28, 40, .2); }
  .erga-edit-button:hover { background: #2f3b4d; }
  .erga-docs-button { right: auto; left: 16px; color: #1b2330; background: #fff; }
  .erga-docs-button:hover { background: #eef1f5; }
  @media (prefers-color-scheme: dark) {
    .erga-edit-button { color: #12161d; background: #e4e8ee; } .erga-edit-button:hover { background: #fff; }
    .erga-docs-button { color: #e4e8ee; background: #1a2029; } .erga-docs-button:hover { background: #232a35; }
  }
</style>`;

/** The templates /new?from= may copy; anything else makes a blank document. */
const FROM = new Set(["demo"]);

/** A new document for the signed-in person, at /<login>/<id>: blank (templates/doc), or a copy of the demo. */
async function newDoc(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  const url = new URL(request.url);
  const params = url.searchParams;
  if (!session) return signInFirst(`/new${params.size ? `?${params}` : ""}`);
  // Another site may not make documents for you (nor an unconfirmed sign-in on the way back from GitHub).
  if (request.method == "POST" ? request.headers.get("origin") != url.origin : fromElsewhere(request)) {
    return confirmAction("New document", params.get("from") == "demo" ? "Make your copy of the demo" : "Make a new document", `/new${url.search}`);
  }
  const wanted = params.get("id");
  const from = params.get("from");
  const template = platform.templates[from && FROM.has(from) ? from : "doc"];
  // A test person makes (or reuses) a test document under the address of whoever minted their token.
  if (session.test) {
    if (!wanted || !TEST_ID.test(wanted)) return page("Test documents only", "Name the test document: /new?id=test1234.", 400);
    const owner = session.test.by;
    await platform.docs.create(owner, wanted, template, "index.html", { test: true });
    return new Response(null, { status: 302, headers: { Location: `/${owner}/${wanted}` } });
  }
  if (!platform.mayCreate(session, url)) return page("Invite only", "Erga is invite-only for now.", 403);
  // Local development may name the document (the test suite wants "test" in its address),
  // and say how soon it goes if nobody edits it (?unedited=<ms>, for tests/worker.ts).
  const dev = platform.dev(url);
  const unedited = (dev && Number(params.get("unedited"))) || undefined;
  for (let tries = 0; tries < 5; tries++) {
    const id = wanted && dev && ID.test(wanted) ? wanted : newId();
    if (await platform.docs.create(session.login, id, template, "index.html", { unedited })) {
      return new Response(null, { status: 302, headers: { Location: link(`/${session.login}/${id}`, session) } });
    }
  }
  return page("Couldn't make a document", "Something went wrong picking an address. <a href=\"/new\">Try again</a>.", 500);
}

/** /docs: the signed-in person's documents, most recently edited first. */
async function listDocs(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session) return signInFirst("/docs");
  if (session.test) return page("Not for test people", "Test people have no documents of their own.", 403);
  const docs = await platform.docs.list(session.login);
  return new Response(docsPage(session, docs, Date.now()), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** POST /docs/delete (id=...): deletes one of the signed-in person's documents. */
async function deleteDoc(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session || session.test) return new Response("Sign in first", { status: 401 });
  // Only from this site's own pages (the session cookie is SameSite=Lax already).
  if (request.headers.get("origin") != new URL(request.url).origin) return new Response("Forbidden", { status: 403 });
  const id = String((await request.formData()).get("id") ?? "");
  if (!ID.test(id)) return new Response("No such document", { status: 404 });
  // Gone already (or never made): drop a stale entry all the same.
  if (!(await platform.docs.delete(session.login, id))) await platform.docs.unlist(session.login, id);
  return new Response(null, { status: 303, headers: { Location: link("/docs", session) } });
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

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
    const note = d.path != null ? `<span class="note" title="${esc(d.path)}">On disk</span>`
      : left != null ? `<span class="note" title="A document nobody edits is deleted ${UNEDITED_HOURS} hours after it's made">Unedited · deleted in ${left}h</span>` : "";
    const when = new Date(d.modified).toISOString();
    // One opened from disk only comes off the list: its files stay where they are.
    const [remove, label] = d.path != null ? ["Remove from the list", `Remove ${esc(d.title)} from the list`] : ["Delete", `Delete ${esc(d.title)}`];
    return `  <li>
    <a class="doc" href="${esc(link(`/${session.login}/${d.id}`, session))}"><span class="title">${esc(d.title)}</span>${note}<time datetime="${when}">${ago(d.modified, now)}</time></a>
    <form method="post" action="${esc(link("/docs/delete", session))}" data-title="${esc(d.title)}"${d.path != null ? " data-disk" : ""}><input type="hidden" name="id" value="${esc(d.id)}"><button class="delete" aria-label="${label}" title="${remove}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button></form>
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
    <a class="new" href="${esc(link("/new", session))}">New document</a>
  </header>
  ${docs.length ? `<ol>\n${rows}\n  </ol>` : `<p class="empty">No documents yet. A new one starts blank, and goes away after ${UNEDITED_HOURS} hours if you never edit it.</p>`}
  <footer><span>Signed in as ${esc(session.login)}</span><a href="${esc(link("/", session))}">The demo</a><a href="/auth/logout">Sign out</a></footer>
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
    const q = "disk" in f.dataset ? "Take \\u201c" + f.dataset.title + "\\u201d off your list? Its files stay where they are." : "Delete \\u201c" + f.dataset.title + "\\u201d? This can't be undone.";
    f.addEventListener("submit", (e) => { if (!confirm(q)) e.preventDefault(); });
  }
</script>
</html>`;
}

/**
 * Only paths on this site: "/koomen/abc", never "//elsewhere" or a full URL.
 * No backslashes or control characters either: browsers read "/\elsewhere"
 * as "//elsewhere", and drop tabs and newlines ("/\t/elsewhere").
 */
export const safeNext = (next: string | null) => (next && next.startsWith("/") && !/[\\\x00-\x1f\x7f]/.test(next) && !next.startsWith("//") ? next : "/");

/**
 * A request that another site started (its link, form or image), as the
 * browser reports it. Clients that don't say (scripts, tests) aren't
 * browsers carrying someone's cookie, so they count as this site.
 */
export const fromElsewhere = (request: Request) => {
  const site = request.headers.get("sec-fetch-site");
  return site != null && site != "same-origin" && site != "none";
};

/**
 * For an action another site may not take on someone's behalf: asks them to
 * confirm it with a button, which posts back from this site.
 */
export const confirmAction = (title: string, button: string, action: string) =>
  page(title, `<form method="post" action="${esc(action)}"><button style="font:inherit;font-weight:600;padding:8px 16px;border:0;border-radius:10px;background:#1b2330;color:#fff;cursor:pointer">${esc(button)}</button></form>`, 200);

const signInFirst = (next: string) => new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(safeNext(next))}` } });

/**
 * A request for the document's host: the path inside the document, its
 * public address, and who's asking (never what the browser claimed: those
 * headers are replaced).
 */
function forwarded(request: Request, url: URL, rest: string, base: string, session: Session | null): Request {
  const inner = new URL(rest + url.search, url.origin);
  const headers = new Headers(request.headers);
  headers.delete("x-erga-person");
  headers.set("x-erga-base", base);
  if (session) headers.set("x-erga-person", JSON.stringify({ id: session.login.toLowerCase(), name: session.name }));
  return new Request(inner, { method: request.method, headers, body: request.body, redirect: "manual" });
}

/**
 * A page's title, as the list shows it: its first top-level heading (what
 * people edit on the page), else an HTML page's <title>. Null if it has neither.
 */
export function titleOf(text: string, path: string): string | null {
  const clean = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim().slice(0, 120) || null;
  if (path.endsWith(".md")) {
    const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text);
    return heading ? clean(heading[1].replace(/[*_`]/g, "")) : null;
  }
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(text), title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  return (h1 && clean(h1[1])) || (title && clean(title[1])) || null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] == "#" ? String.fromCodePoint(parseInt(e[1] == "x" || e[1] == "X" ? e.slice(2) : e.slice(1), e[1] == "x" || e[1] == "X" ? 16 : 10)) : ENTITIES[e.toLowerCase()] ?? m);

/** A small page for when there's nothing to show, or something about signing in goes wrong. */
export function page(title: string, html: string, status: number): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Erga</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 16px;color:#1b2330;background:#f7f8fa}h1{font-size:1.4rem}a{color:#1f5f8b}
@media(prefers-color-scheme:dark){body{color:#e4e8ee;background:#12161d}a{color:#7fb6e0}}</style><h1>${title}</h1><p>${html}</p>`, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
