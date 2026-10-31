// Helpers for the app's tests:
// a fresh person signed in on the worker's scripted-model server, so their list starts empty and nothing they make
// meets another test's; their documents made, named, shared and joined; agent tokens and the tools over HTTP.
//
// Settings are the server's, not a person's: a test that changes one puts it back (`resetting`), so the tests that
// share the worker's server after it find the defaults.

import "./no-storage";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Participant } from "../suite/client";
import type { Doc } from "../suite/target";
import { ROOT } from "../../helpers/env";
import { expect, servers, type Server } from "../../helpers/fixtures";
import { postForm } from "../../helpers/form-post";
import { runTool, textOf } from "../../helpers/tools";

export { servers };

export interface Name { id: string; owner: string; title: string; slug: string; address: string; titleSet: boolean; slugSet: boolean }

export const template = (name: string) => readFileSync(join(ROOT, `assets/templates/${name}/index.html`), "utf8");

let people = 0;
/** A login no one has used on any server yet. */
export const freshLogin = (prefix = "w") => `${prefix}${Date.now().toString(36)}${(++people).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const sessionCookie = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => /^erga_session(_\d+)?=/.test(c));

/** Signs in as `login` (none: the dev server's DEV_LOGIN, "tester", an admin by the deploy) with a session cookie. */
export async function signIn(s: Server, login: string | null, next = "/docs") {
  const r = await fetch(`${s.root}/auth/github?${login ? `as=${login}&` : ""}next=${encodeURIComponent(next)}`, { redirect: "manual" });
  const cookie = sessionCookie(r);
  if (!cookie) throw new Error(`signing in at ${s.root}: ${r.status}`);
  return { cookie, location: r.headers.get("location") };
}

/** A fresh person on server `s`, signed in by cookie, and what they do with their documents. */
export async function person(s: Server, login = freshLogin()) {
  const base = s.root, origin = new URL(base).origin;
  const { cookie } = await signIn(s, login);
  const get = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string>) } });
  const p = {
    login, cookie, base, origin, get,
    // (Without its script nonce, new at each answer (server/security.ts), and when the server made it (live pages: data-live-at).)
    docs: async () => (await (await get("/docs")).text()).replace(/ nonce="[^"]*"/g, "").replace(/ data-live-at="\d+"/g, ""),
    /** As someone else, by the dev server's ?user= (no cookie needed). */
    as: (who: string, path: string, init?: RequestInit) => get(`${path}${path.includes("?") ? "&" : "?"}user=${who}`, init),
    /** A document's title and address, from its host. */
    nameOf: async (id: string): Promise<Name> => (await runTool<Name>(base, "get_title", { document: id }, { cookie, origin })).result!,
    /** Renames a document, as the editor's title card does (rename_document): its answer, or the error, as a response's. */
    rename: async (id: string, patch: { title?: string; slug?: string }) => {
      const r = await runTool<Name>(base, "rename_document", { document: id, ...patch }, { cookie, origin });
      return { ok: r.ok, status: r.status, json: async () => (r.ok ? r.result : { error: r.error }) };
    },
    /** Makes a document with /new and returns its id, checking that /new sends its maker to its editor, at its canonical address. */
    async make(query = ""): Promise<string> {
      const r = await get(`/new${query}`);
      const at = r.headers.get("location") ?? "";
      expect(r.status, `/new${query}`).toBe(302);
      expect(at.startsWith(`/${login}/`), at).toBe(true);
      const name = ((await (await get(`${at.replace(/[?&]edit=?$/, "")}/api/doc`)).json()) as { docName: Name }).docName;
      expect(`${name.address}?edit`).toBe(at);
      return name.id;
    },
    /** Shares a document (as its owner, or `as` someone) with someone ("*": anyone with the link); role "none" stops sharing it. */
    async share(id: string, who: string, role: "editor" | "viewer" | "none", as?: string) {
      const r = await runTool<{ permissions: { login: string; role: string }[] }>(
        base,
        "share_document",
        { document: id, login: who, role },
        as ? { user: as, origin } : { cookie, origin }
      );
      return { status: r.status, body: { permissions: r.result?.permissions, error: r.error } };
    },
    /** Runs an operation as this person, as their pages do (POST /api/tools/<name>); `as` someone else by ?user=. */
    tool: <T = any>(name: string, args: Record<string, unknown> = {}, as?: string) =>
      runTool<T>(base, name, args, as ? { user: as, origin } : { cookie, origin }),
    /** A participant in a document's room, as the suite's client joins one (the dev server's ?user= says who). */
    join(id: string, name = "Ada"): Promise<Participant> {
      const doc = { base: `${base}/d/${id}`, path: "index.html", roomUrl: `${base.replace(/^http/, "ws")}/d/${id}/api/room`, roomName: "doc", headersFor: () => ({}) } as unknown as Doc;
      return Participant.join(doc, name);
    },
    exists: async (id: string) => [200, 302].includes((await get(`/d/${id}`)).status),
    /** Where a path redirects to, or its status in brackets. */
    location: async (path: string) => { const r = await get(path); return r.status == 302 ? r.headers.get("location") : `(${r.status})`; },
    /** A document's row on the list (/docs), or "(not listed)". */
    row: (id: string, html: string) => html.split(/<li[ >]/).find((li) => li.includes(`value="${id}"`)) ?? "(not listed)",
    /** An agent token of theirs, made at /tokens (scope: documents, or admin for an admin). */
    async token(label = "Test token", scope = "documents") {
      const { page } = await postForm(base, "/tokens/new", { label, scope }, cookie);
      const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1] ?? "";
      expect(token, page.slice(0, 300)).toBeTruthy();
      return token;
    },
  };
  // Their first request with the cookie gives them a user's row, as opening their list does.
  expect((await get("/docs")).ok).toBe(true);
  return p;
}
export type Person = Awaited<ReturnType<typeof person>>;

/** Replaces the page's first heading's text. */
export const retitle = (p: Participant, from: string, to: string) => p.edit((t) => { const i = t.toString().indexOf(`<h1>${from}`); t.delete(i + 4, from.length); t.insert(i + 4, to); });

/** The server's tools over HTTP with an agent token: status, text, the text as JSON if it is. */
export function tools(base: string, token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await runTool(base, name, args, { token });
    const text = r.ok ? textOf(r.result) : "";
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, text: text || r.error || "", data, body: r };
  };
  return {
    auth,
    call,
    names: async () =>
      ((await (await fetch(`${base}/api/tools`, { headers: auth })).json()) as { tools: { name: string }[] }).tools.map((t) => t.name),
    mcpNames: async () =>
      (
        (await (
          await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          })
        ).json()) as any
      ).result.tools.map((t: { name: string }) => t.name) as string[],
    guide: async () => (await fetch(`${base}/llms.txt`, { headers: auth })).text(),
  };
}

/** The admin (DEV_LOGIN, "tester"): a cookie, and an admin-scope token's tools. */
export async function admin(s: Server) {
  const a = await person(s, "tester");
  const t = tools(s.root, await a.token("Admin test", "admin"));
  return { ...a, ...t };
}

/** Runs `f`, then puts setting `key` back to its default, however `f` ends. */
export async function resetting<T>(s: Server, key: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } finally {
    await runTool(s.root, "reset_setting", { key });
  }
}
