// The whole app (server/app.ts) on a Platform in memory, for the tests of what the server answers over HTTP: the
// directory and the tokens on bun:sqlite, each document a real Document (document/document.ts) on MemoryStorage with
// MemoryBlobs, as cloudflare/platform.ts and cloudflare/objects/document.ts wire them on Cloudflare. No socket, no
// browser, no model. It is local development's server (DEV_LOGIN "tester", an admin; ?user=Ada and /auth/github?as=
// sign anyone in), on http://localhost; `staging: true` makes it a staging instance: a server for admins only (its deploy names its primary).
//
// Trap: every server made here has the one origin (ROOT), so two of them alive in one test share what the app keeps
// by origin and address for a few seconds (who may see what: server/documents/view.ts). Give two servers' people
// different logins (`person` does).
//
// What it leaves out, because nothing here runs it: the news hub's sockets, the homepage's deploys (/ shows the viewer
// on the homepage project), each person's agent, comments, and the routes that live outside the app (the deploys', the
// dev server's).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { mockGithubId } from "../../dev/github-mock";
import { documentAgents } from "../../agents/document/session";
import { BLOB_HEADER, MemoryBlobs, serveBlob } from "../../document/blobs";
import { Document, type DocumentDeps } from "../../document/document";
import { MemoryStorage } from "../../document/storage";
import { app } from "../../server/app.ts";
import { Directory, type Route } from "../../server/directory/index.ts";
import { forgetDecisions } from "../../server/documents/index.ts";
import { respond } from "../../server/http.ts";
import { sessionOf } from "../../server/identity/index.ts";
import { Tokens } from "../../server/identity/tokens";
import { useAssets } from "../../server/pages/index.ts";
import type { Platform } from "../../server/platform";
import type { AssetManifest } from "../../shared/assets.ts";
import { memory } from "./memory-sql";
import { promised, type Promised } from "./promised";
import { testSandbox } from "./sandbox";

const ASSETS = new URL("../../assets/", import.meta.url).pathname;

/** Every text file under `dir`, by its path there. */
function textFiles(dir: string, under = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(dir, under))) {
    const rel = under ? `${under}/${name}` : name;
    if (statSync(join(dir, rel)).isDirectory()) Object.assign(out, textFiles(dir, rel));
    else out[rel] = readFileSync(join(dir, rel), "utf8");
  }
  return out;
}

/** The templates' files, as the Worker has them (cloudflare/platform.ts, TEMPLATES): read one time. */
let templates: Record<string, Record<string, string>> | null = null;
const templatesOf = () =>
  (templates ??= Object.fromEntries(readdirSync(join(ASSETS, "templates")).map((t) => [t, textFiles(join(ASSETS, "templates", t))])));

/** A build's list of the editor's files, as the pages name them (shared/assets.ts): no build is needed. */
export const MANIFEST: AssetManifest = {
  files: {
    "page.js": "/_erga/main-aaaa1111.js",
    "frame.js": "/_erga/frame-bbbb2222.js",
    "style.css": "/_erga/style-cccc3333.css",
    "editor.html": "/_erga/editor-dddd4444.html",
  },
  deps: { "page.js": ["/_erga/chunk-ffff6666.js"], "frame.js": ["/_erga/chunk-gggg7777.js"] },
  frame: ["/_erga/frame-bbbb2222.js", "/_erga/chunk-gggg7777.js"],
  integrity: {
    "/_erga/frame-bbbb2222.js": "sha384-frame",
    "/_erga/chunk-gggg7777.js": "sha384-chunk",
    "/_erga/main-aaaa1111.js": "sha384-main",
  },
  fonts: {
    css: "@font-face{font-family:'Inter';src:url(/_erga/fonts/inter-iiii9999.woff2) format('woff2')}",
    preload: "/_erga/fonts/inter-iiii9999.woff2",
    page: "",
  },
};

/** The homepage project's files (assets/landing/ is large: its fonts), small. */
const LANDING = { "index.html": "<!doctype html><html><head><title>Erga</title></head><body><h1>Erga</h1></body></html>" };

export const ROOT = "http://localhost";

export interface ServerOptions {
  /** A staging instance: a server for admins only (the deploy names its primary, SNAPSHOT_FROM). */
  staging?: boolean;
  /** The documents' timers (the versions' pause, the write delay): short unless said. */
  timing?: DocumentDeps["timing"];
}

/** A server in memory: `fetch` is its answer to a request (redirects not followed, as the old tests' `getter`). */
export function server(o: ServerOptions = {}) {
  const sql = memory();
  const hosts = new Map<string, Promised<Document> & { readonly self: Document }>();
  const blobs = new MemoryBlobs();
  const log: string[] = [];
  const dir = new Directory(sql, {
    admins: ["tester"],
    local: true,
    defaults: { public_sharing: true },
    credentialSecret: "local:secret",
    providers: ["github", "google"],
    // GitHub's public users API, as the pretend GitHub answers it (dev/github-mock.ts): every login is an account.
    lookup: async (_provider, login) => ({ subject: String(mockGithubId(login)), handle: login }),
    changed: async (key) => {
      if (key == "public_sharing") forgetDecisions();
    },
    permissionsChanged: async (id, permissions) => {
      forgetDecisions(id);
      if (permissions.length) await hosts.get(id)?.setPermissions(permissions.map((p) => ({ login: p.login, role: p.role })));
    },
  });
  /** A document's host, made the first time it is asked for (a Durable Object named by the document's id). */
  const host = (doc: { id: string }) => {
    let h = hosts.get(doc.id);
    if (!h) {
      const storage: MemoryStorage = new MemoryStorage(() => made.wake());
      const made = promised(
        new Document({
          storage,
          directory: dir,
          tabs: { count: () => 0, closeAll: () => {} },
          agents: documentAgents({ settings: async () => ({ missing: "no key in the tests" }), sandbox: testSandbox }),
          home: { forget: async () => {} },
          timing: o.timing ?? { idleMs: 40, maxMs: 400, writeDelay: 10 },
          background: (work) => void work.catch(() => {}),
          log: (line) => log.push(line),
          blobs,
          viewChanged: (id) => forgetDecisions(id),
          pageTemplate: templatesOf().doc["index.html"],
        })
      );
      hosts.set(doc.id, (h = made));
    }
    return h;
  };
  const hold = <A>(doc: Route, work: (d: Document) => Effect.Effect<A, unknown>): Promise<A> => {
    const d = host(doc).self;
    return Effect.runPromise(d.hold(work(d)));
  };
  const own = new Map<string, unknown>();
  const p: Platform = {
    directory: dir,
    sessionOf: (request) => sessionOf(p, request),
    templates: templatesOf(),
    landing: { files: async () => LANDING },
    assets: async (request) =>
      new URL(request.url).pathname == "/manifest.json" ? Response.json(MANIFEST) : new Response("Not found", { status: 404 }),
    dev: (url) => url.hostname == "localhost" || url.hostname == "127.0.0.1",
    pagesDomain: () => "localhost",
    pagesShared: () => null,
    secret: "session-secret",
    adminsOnly: !!o.staging,
    tokens: new Tokens(sql, "session-secret", dir),
    deploy: { version: null, facts: null, primary: o.staging ? "https://primary.example.com" : null, home: null, app: null },
    signIn: {
      mode: "oauth",
      apps: { github: { clientId: "", secret: "" }, google: { clientId: "", secret: "" } },
      origins: { github: null, google: null },
      devLogin: "tester",
      encryptionKey: "local:secret",
    },
    own: { get: async (k) => own.get(k) as never, put: async (k, v) => void own.set(k, v), delete: async (k) => void own.delete(k) },
    // The homepage has no deploy: / is the viewer on the homepage project.
    home: {
      status: async () => ({ state: "none" }) as never,
      deploy: async () => ({ state: "none" }) as never,
      homeChanged: async () => ({ state: "none" }) as never,
      ensure: async () => {},
      forget: async () => {},
      page: async () => null,
      file: async () => null,
    },
    news: { fetch: async () => new Response("No news in the tests", { status: 404 }) },
    personAgent: () => {
      throw new Error("no person's agent in the tests' server");
    },
    agentSettings: async () => ({ missing: "no key in the tests" }),
    edge: { cache: null, background: (work) => void work.catch(() => {}), homeRecheckMs: 0 },
    docs: {
      create: (doc, files, index, opts) => host(doc).create(doc.owner, doc.id, files, index, opts),
      keep: (doc) => host(doc).keep(),
      publish: (doc, files, remove, by, writer) => host(doc).publish(files, remove, by, writer),
      paths: (doc) => hold(doc, (d) => d.paths()),
      index: (doc) => host(doc).index(),
      snapshot: (doc) => hold(doc, (d) => d.snapshot()),
      versions: (doc, opts) => hold(doc, (d) => d.versionsState(opts)),
      restore: (doc, ref, by, path) => hold(doc, (d) => d.restore(ref, by, path)),
      version: (doc, ref) => hold(doc, (d) => d.version(ref)),
      versionFile: (doc, ref, path) => hold(doc, (d) => d.versionFile(ref, path)),
      tree: (doc) => hold(doc, (d) => d.call((c) => c.tree())),
      treeOp: async (doc, op) =>
        (await hold(doc, (d) => d.call((c) => c.treeOp(op)))) ?? { ok: false, status: 404, error: "There's no such document." },
      files: (doc) => hold(doc, (d) => d.call((c) => c.files())),
      rename: async (doc, person, patch) =>
        (await hold(doc, (d) => d.call((c) => c.rename(person, patch)))) ?? { ok: false, error: "There's no such document." },
      comments: async () => {
        throw new Error("no comments in the tests' server");
      },
      delete: (doc) => host(doc).delete(),
      list: async (owner, opts) =>
        (await dir.lists.list(owner, opts)).map((d) => ({
          id: d.id,
          owner: d.owner,
          slug: d.slug,
          title: d.title,
          titleSet: d.titleSet,
          slugSet: d.slugSet,
          created: d.created,
          modified: d.modified ?? d.created,
          role: d.role,
          shared: d.shared,
          ...(d.kind ? { kind: d.kind } : {}),
          ...(d.modified == null && d.expires != null ? { expires: d.expires } : {}),
        })),
      fetch: async (doc, request) => {
        const answer = await host(doc).handle(request);
        if (!answer.headers.has(BLOB_HEADER)) return answer;
        return (await Effect.runPromise(serveBlob(answer, request, blobs))) ?? answer;
      },
      view: (id, who, opts) => host({ id }).view(who, opts),
    },
  };
  useAssets(MANIFEST);
  // Every server here has the same origin, and the app remembers what it decided for an address by its origin
  // (server/documents/view.ts): a new server starts with none of the last one's answers.
  forgetDecisions();
  const route = app(() => Effect.succeed(null));
  /** The app's answer to a request, at a path of this server or a whole address (a document's pages origin). */
  const fetch = (at: string, init: RequestInit = {}) => respond(route, new Request(at.startsWith("/") ? ROOT + at : at, init), p);
  return { root: ROOT, platform: p, dir, sql, hosts, host, blobs, log, fetch };
}
export type Server = ReturnType<typeof server>;

const cookieOf = (r: Response, name: RegExp) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => name.test(c));

let people = 0;
/** A login no test of this process used before. */
export const freshLogin = (prefix = "w") => `${prefix}${(++people).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A tool's answer over HTTP (POST /api/tools/<name>). */
export interface ToolAnswer<T = any> {
  status: number;
  ok: boolean;
  result?: T;
  error?: string;
}

/** A tool's result as text, as an agent reads it: a document tool's text items, one per line; any other result as JSON. */
export function textOf(result: unknown): string {
  if (Array.isArray(result) && result.every((c) => c && typeof c == "object" && "type" in c))
    return result
      .filter((c) => c.type == "text")
      .map((c) => c.text ?? "")
      .join("\n");
  return typeof result == "string" ? result : JSON.stringify(result, null, 2);
}

/** Runs the operation `name` on `s`, as `as.cookie`, `as.user` (?user=) or `as.token`; none: the dev login, from this site. */
export async function runTool<T = any>(
  s: Server,
  name: string,
  args: Record<string, unknown> = {},
  as: { cookie?: string; user?: string; token?: string } = {}
): Promise<ToolAnswer<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (as.token) headers.Authorization = `Bearer ${as.token}`;
  else headers.Origin = ROOT;
  if (as.cookie) headers.Cookie = as.cookie;
  const r = await s.fetch(`/api/tools/${name}${as.user ? `?user=${encodeURIComponent(as.user)}` : ""}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  const body = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string };
  return { status: r.status, ok: r.ok && body.ok !== false, result: body.result, error: body.error };
}

/** A tool with an agent token, as an outside agent calls it: its status, its result as text (or the error), and that text as JSON if it is. */
export async function tool(s: Server, token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await runTool(s, name, args, { token });
  const text = r.ok ? textOf(r.result) : (r.error ?? "");
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, ok: r.ok, text, data, result: r.result };
}

/** Makes a token as the Settings dialog does (POST /tokens/new), as `cookie`'s person (none: the dev login): the token, or "" and the error. */
export async function mint(s: Server, cookie: string | null, fields: Record<string, string>) {
  const r = await s.fetch("/tokens/new", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ROOT, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(fields),
  });
  const text = await r.text();
  let body: { token?: string; error?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  return { token: body.token ?? "", error: body.error ?? "", status: r.status };
}

/** Signs in as `login` by local development's sign-in (none: the dev login, an admin): their session cookie. */
export async function signIn(s: Server, login: string | null, next = "/docs") {
  const r = await s.fetch(`/auth/github?${login ? `as=${login}&` : ""}next=${encodeURIComponent(next)}`);
  const cookie = cookieOf(r, /^erga_session(_\d+)?=/);
  if (!cookie) throw new Error(`signing in as ${login}: ${r.status}`);
  return { cookie, location: r.headers.get("location") };
}

/** The headers of a browser that signed out (local development: nobody, not the dev login). */
export const signedOut = () => ({ Cookie: "erga_signed_out=1" });

/** A fresh person on `s`, signed in by cookie, and what they do with their documents (the old tests' `person`). */
export async function person(s: Server, login = freshLogin()) {
  const { cookie } = await signIn(s, login);
  const get = (path: string, init: RequestInit = {}) =>
    s.fetch(path, { ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string>) } });
  const p = {
    login,
    cookie,
    origin: ROOT,
    get,
    /** Their list (/docs), without what is new at each answer (the script nonce, the live pages' time). */
    docs: async () => (await (await get("/docs")).text()).replace(/ nonce="[^"]*"/g, "").replace(/ data-live-at="\d+"/g, ""),
    /** Makes a document with /new: its id. */
    async make(query = ""): Promise<string> {
      const r = await get(`/new${query}`);
      const at = r.headers.get("location") ?? "";
      if (r.status != 302 || !at.startsWith(`/${login}/`)) throw new Error(`/new${query}: ${r.status} ${at}`);
      const name = ((await (await get(`${at.replace(/[?&]edit=?$/, "")}/api/doc`)).json()) as { docName: { id: string; address: string } })
        .docName;
      if (`${name.address}?edit` != at) throw new Error(`/new went to ${at}, and the document is at ${name.address}`);
      return name.id;
    },
    /** Shares a document (as its owner, or `as` someone) with someone; role "none" stops sharing it. */
    async share(id: string, who: string, role: "editor" | "commenter" | "viewer" | "none", as?: string) {
      const r = await runTool<{ permissions: { login: string; role: string }[] }>(
        s,
        "share_document",
        { document: id, login: who, role },
        as ? { user: as } : { cookie }
      );
      return { status: r.status, body: { permissions: r.result?.permissions, error: r.error } };
    },
    /** Runs an operation as this person, as their pages do; `as` someone else by ?user=. */
    tool: <T = any>(name: string, args: Record<string, unknown> = {}, as?: string) =>
      runTool<T>(s, name, args, as ? { user: as } : { cookie }),
    exists: async (id: string) => [200, 302].includes((await get(`/d/${id}`)).status),
    /** Where a path redirects to, or its status in brackets. */
    location: async (path: string) => {
      const r = await get(path);
      return r.status == 302 ? r.headers.get("location") : `(${r.status})`;
    },
    /** A document's row on the list (/docs), or "(not listed)". */
    row: (id: string, html: string) => html.split(/<li[ >]/).find((li) => li.includes(`value="${id}"`)) ?? "(not listed)",
    /** An agent token of theirs, made as Settings makes one. */
    async token(label = "Test token", scope = "documents") {
      const { token, error } = await mint(s, cookie, { label, scope });
      if (!token) throw new Error(`no token: ${error}`);
      return token;
    },
  };
  // Their first request with the cookie gives them a user's row, as opening their list does.
  if (!(await get("/docs")).ok) throw new Error(`${login} has no list`);
  return p;
}
export type Person = Awaited<ReturnType<typeof person>>;

/** An MCP request (POST /mcp) with a token, or none: its status, the 401's header, and the answer's body. */
export async function mcp(s: Server, token: string | null, body: unknown) {
  const r = await s.fetch("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, auth: r.headers.get("www-authenticate"), body: r.status == 200 ? ((await r.json()) as any) : null };
}
