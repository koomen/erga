// Helpers for the versions and settings tests (versions.ts, worker/doc-host.ts,
// src/page/settings.ts), on servers.short(): people signed in by cookie, a
// document's versions and publishing over the HTTP API, an agent token and its
// tools, and someone in the document's room (a headless Yjs participant, as an
// editor's tab is: tests/suite/client.ts).

import { request } from "node:http";
import type * as Y from "yjs";
import { Participant } from "../../tests/suite/client";
import type { Doc } from "../../tests/suite/target";
import { until, type Server } from "../fixtures";

export { Participant };

export interface V { id: string; n: number; at: string; authors: string[]; description: string | null }
export interface State { current: V; published: { mode: string; version: V }; versions: V[]; total: number; canEdit: boolean; pending: boolean }
export interface HomeState { isHome: boolean; canSet: boolean; blocked: string | null; deploy: { state: string; version: number | null; at: string | null; scheduledFor?: string | null; error?: string | null }; error?: string }

/** A login of this test's own, so nothing it makes is anyone else's. */
export const someone = (prefix: string) => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

export type Get = (path: string, init?: RequestInit) => Promise<Response>;

/** Someone signed in on `server` (worker/auth.ts, /auth/github?as=): requests carrying their session cookie. */
export async function person(server: Server, as: string) {
  const r = await fetch(`${server.root}/auth/github?as=${as}&next=/docs`, { redirect: "manual" });
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => /^erga_session(_\d+)?=/.test(c));
  if (!cookie) throw new Error(`signing in as ${as}: ${r.status}`);
  const get: Get = (path, init = {}) => fetch(server.root + path, { redirect: "manual", ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string>) } });
  const origin = server.root;
  return {
    login: as.toLowerCase(), cookie, get,
    /** A blank document of theirs (/new): its address and id. */
    async newDoc() {
      const at = (await get("/new")).headers.get("location")!.replace(/(\/edit|#edit)$/, "");
      const { id } = (await (await get(`${at}/api/name`)).json()) as { id: string };
      return { address: at, id };
    },
    versions: async (id: string, q = "") => (await (await get(`/api/docs/${id}/versions${q}`)).json()) as State,
    home: async (id: string) => (await (await get(`/api/docs/${id}/home`)).json()) as HomeState,
    publish: (id: string, body: unknown, headers: Record<string, string> = { Origin: origin }) =>
      get(`/api/docs/${id}/publish`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } }),
    restore: (id: string, version: string, body?: unknown) =>
      get(`/api/docs/${id}/versions/${version}/restore`, { method: "POST", headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }),
    share: (id: string, login: string, role: string) => get("/docs/share", { method: "POST", body: new URLSearchParams({ id, login, role }), headers: { Origin: origin } }),
    /** An agent token of theirs (/tokens/new). */
    async token(label: string, scope?: string) {
      const page = await (await get("/tokens/new", { method: "POST", body: new URLSearchParams({ label, ...(scope ? { scope } : {}) }), headers: { Origin: origin } })).text();
      const t = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1];
      if (!t) throw new Error(`no token: ${page.slice(0, 300)}`);
      return t;
    },
    /** Joins a document's room as an editor's tab does. */
    join: (id: string, name = as) => Participant.join(roomOf(server, id, { Cookie: cookie }), name),
  };
}
export type Person = Awaited<ReturnType<typeof person>>;

/** A document's room, for a Participant (with these headers: a session cookie, or none for DEV_LOGIN). */
export function roomOf(server: Server, id: string, headers: Record<string, string> = {}): Doc {
  const ws = server.root.replace(/^http/, "ws");
  return { base: `${server.root}/d/${id}`, path: "index.html", roomUrl: `${ws}/d/${id}/api/room`, roomName: "doc", headers, headersFor: () => headers } as unknown as Doc;
}

/** An agent tool over the server's API (/api/ext/tools/<name>), with a token, on one document. */
export function tools(server: Server, token: string, document: string) {
  return async (name: string, args: object) => {
    const res = await fetch(`${server.root}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ document, ...args }) });
    const body = (await res.json()) as { ok: boolean; content?: { text?: string }[]; error?: string };
    return { status: res.status, ok: body.ok, text: body.content?.map((c) => c.text ?? "").join("\n") ?? body.error ?? "" };
  };
}

/** The document's events ({ type } messages on /d/<id>/api/events), as a list that fills as they come. */
export async function events(server: Server, id: string, cookie?: string) {
  const seen: { type: string; [k: string]: unknown }[] = [];
  const ws = new WebSocket(`${server.root.replace(/^http/, "ws")}/d/${id}/api/events`, (cookie ? { headers: { Cookie: cookie } } : undefined) as unknown as string[]);
  ws.onmessage = (e) => { seen.push(JSON.parse(String(e.data))); };
  await until(() => ws.readyState == WebSocket.OPEN, 5_000, "the event socket opens");
  return Object.assign(seen, { close: () => ws.close(), of: (type: string) => seen.filter((m) => m.type == type) });
}

/**
 * A GET on a document's pages origin (<id>-<owner>.localhost:<port>): browsers send <anything>.localhost to this
 * machine; Node's fetch doesn't, and won't send another Host, so this goes to 127.0.0.1 with the page's host. Never
 * follows a redirect.
 */
export function pagesFetch(u: string): Promise<{ status: number; location: string | null; text(): Promise<string> }> {
  const url = new URL(u);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: url.port, path: url.pathname + url.search, headers: { Host: url.host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => { const body = Buffer.concat(chunks).toString("utf8"); resolve({ status: res.statusCode ?? 0, location: (res.headers.location as string | undefined) ?? null, text: async () => body }); });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`no answer from ${u}`)));
    req.end();
  });
}

/** An edit in the room, cut into a version of its own at once: a publish of what's published already cuts what's pending. */
export async function cut(owner: Person, id: string, ada: Participant, edit: (t: Y.Text) => void) {
  const before = (await owner.versions(id)).total;
  ada.edit(edit);
  await until(async () => (await owner.versions(id)).pending, 5_000, "the edit reaches the room");
  const { published } = await owner.versions(id);
  const r = await owner.publish(id, published.mode == "latest" ? { mode: "latest" } : { mode: "manual", versionId: published.version.id });
  if (!r.ok) throw new Error(`cutting a version: ${r.status} ${await r.text()}`);
  await until(async () => (await owner.versions(id)).total == before + 1, 5_000, "the version is cut");
}

/** Text put into the page's heading. */
export const intoHeading = (text: string) => (t: Y.Text) => t.insert(t.toString().indexOf("</h1>"), text);

/** Sends the document's agent a scripted turn (the script model: `@script [steps]`), as `who`. */
export const scripted = (who: Person, id: string, steps: unknown[], text = "") =>
  who.get(`/d/${id}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `${text}@script ${JSON.stringify(steps)}` }) });
