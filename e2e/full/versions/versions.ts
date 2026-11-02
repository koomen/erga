// Helpers for the versions and settings tests (document/versions.ts, cloudflare/objects/document.ts,
// client/pages/settings.ts), on servers.short(): people signed in by cookie, a
// document's versions over the HTTP API, an agent token and its
// tools, and someone in the document's room (a headless Yjs participant, as an
// editor's tab is: e2e/full/suite/client.ts).

import { request } from "node:http";
import type * as Y from "yjs";
import { Participant } from "../suite/client";
import type { Doc } from "../suite/target";
import { until, type Server } from "../../helpers/fixtures";
import { newToken } from "../../helpers/new-token";
import { runTool, textOf } from "../../helpers/tools";

export { Participant };

export interface V { id: string; n: number; at: string; authors: string[]; description: string | null }
export interface State { current: V; versions: V[]; total: number; canEdit: boolean; pending: boolean }
export interface HomeState { isHome: boolean; canDeploy: boolean; locked?: boolean; deploy: { state: string; version: number | null; at: string | null; scheduledFor?: string | null; error?: string | null }; error?: string }

/** A login of this test's own, so nothing it makes is anyone else's. */
export const someone = (prefix: string) => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

export type Get = (path: string, init?: RequestInit) => Promise<Response>;

/** Someone signed in on `server` (server/identity/sign-in.ts, /auth/github?as=): requests carrying their session cookie. */
export async function person(server: Server, as: string) {
  const r = await fetch(`${server.root}/auth/github?as=${as}&next=/docs`, { redirect: "manual" });
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => /^erga_session(_\d+)?=/.test(c));
  if (!cookie) throw new Error(`signing in as ${as}: ${r.status}`);
  const get: Get = (path, init = {}) => fetch(server.root + path, { redirect: "manual", ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string>) } });
  const origin = server.root;
  return {
    login: as.toLowerCase(),
    cookie,
    get,
    origin,
    /** A blank document of theirs (/new): its address and id. */
    async newDoc() {
      const at = (await get("/new")).headers.get("location")!.replace(/(\/edit|[?&]edit)$/, "");
      const { id } = ((await (await get(`${at}/api/doc`)).json()) as { docName: { id: string } }).docName;
      return { address: at, id };
    },
    /** Its versions, as the settings list them (versions; `q`: before and limit). */
    versions: async (id: string, q: { before?: string; limit?: number } = {}) =>
      (await runTool(server.root, "versions", { document: id, ...q }, { cookie, origin })).result as State,
    /** The homepage's state, as ls answers it; not the homepage: { isHome: false }. */
    home: async (id: string) =>
      ((await runTool(server.root, "ls", { document: id }, { cookie, origin })).result?.homepage ?? { isHome: false }) as HomeState,
    /** Brings a version back, as the settings' Edit does (restore_version; `body.path`: one file). */
    restore: async (id: string, version: string, body?: { path?: string }) => {
      const r = await runTool(server.root, "restore_version", { document: id, version, ...body }, { cookie, origin });
      return { ok: r.ok, status: r.status, json: async () => (r.ok ? r.result : { error: r.error }) };
    },
    share: (id: string, login: string, role: string) =>
      runTool(server.root, "share_document", { document: id, login, role }, { cookie, origin }),
    /** An agent token of theirs (/tokens/new). */
    async token(label: string, scope?: string) {
      const { token, error } = await newToken(server.root, { label, ...(scope ? { scope } : {}) }, cookie);
      if (!token) throw new Error(`no token: ${error}`);
      return token;
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

/** An agent tool over the server's API (/api/tools/<name>), with a token, on one document. */
export function tools(server: Server, token: string, document: string) {
  return async (name: string, args: object) => {
    const r = await runTool(server.root, name, { document, ...args }, { token });
    return { status: r.status, ok: r.ok, text: r.ok ? textOf(r.result) : (r.error ?? "") };
  };
}

/** The document's events ({ type } messages, the text frames on a tab's socket: /d/<id>/api/room?events=1), as a list that fills as they come. */
export async function events(server: Server, id: string, cookie?: string) {
  const seen: { type: string; [k: string]: unknown }[] = [];
  const ws = new WebSocket(`${server.root.replace(/^http/, "ws")}/d/${id}/api/room?events=1`, (cookie ? { headers: { Cookie: cookie } } : undefined) as unknown as string[]);
  ws.onmessage = (e) => { if (typeof e.data == "string") seen.push(JSON.parse(e.data)); };
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

/** An edit in the room, a version of its own: cut once the edits pause (SHORT.idle). */
export async function cut(owner: Person, id: string, ada: Participant, edit: (t: Y.Text) => void) {
  const before = (await owner.versions(id)).total;
  ada.edit(edit);
  await until(async () => (await owner.versions(id)).total == before + 1, 5_000, "the version is cut");
}

/** Text put into the page's heading. */
export const intoHeading = (text: string) => (t: Y.Text) => t.insert(t.toString().indexOf("</h1>"), text);

/** Sends `who`'s agent a scripted turn (the script model: `@script [steps]`) from document `id`'s page, as `who`. */
export const scripted = (who: Person, id: string, steps: unknown[], text = "") =>
  who.get("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: who.origin },
    body: JSON.stringify({ text: `${text}@script ${JSON.stringify(steps)}`, doc: id }),
  });
