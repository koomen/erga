// Who did it (#69, attribution.ts), on the worker's factory server: tester (DEV_LOGIN) acts
// in person, through the editor's agent, with an admin token (a shared agent), through the admin agent, and with
// Share with agent's token. Each test makes its own token, label, users and values, so it finds its own changes
// in the server's one change log.

import { expect, type FactoryServer } from "../fixtures";

export const unique = () => crypto.randomUUID().slice(0, 8);

export function who(s: FactoryServer) {
  const root = s.root;
  /** As tester, in person: their browser session, from this site's pages. */
  const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init, headers: { Origin: root, ...(init.headers as Record<string, string>) } });
  const post = (path: string, json: unknown) => get(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });
  const w = {
    get, post,
    /** A new admin token, labelled `label`. */
    async mint(label: string) {
      const page = await (await get("/tokens/new", { method: "POST", body: new URLSearchParams({ label, scope: "admin" }) })).text();
      return /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)![1];
    },
    /** Share with agent's admin token. */
    async shareToken() { return ((await (await get("/admin/share", { method: "POST", body: new URLSearchParams({}) })).json()) as { token: string }).token; },
    /** A tool of the server's API, with an agent token: its result. */
    async tool(token: string, name: string, args: unknown = {}) {
      const r = await fetch(`${root}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
      const body = await r.json() as any;
      expect(r.ok, `${name}: ${JSON.stringify(body)}`).toBe(true);
      const text = body.content?.[0]?.text;
      try { return JSON.parse(text); } catch { return text ?? body; }
    },
    /** The settings' change log, newest first, read with `token`. */
    async changes(token: string) { return (await w.tool(token, "list_setting_changes", { limit: 50 })).changes as { by: string; via?: string; changes: any[] }[]; },
    /** A setting set in person, on /admin. */
    async setInPerson(key: string, value: unknown) { expect((await get("/admin/settings", { method: "POST", body: new URLSearchParams({ key, value: JSON.stringify(value) }) })).ok).toBe(true); },
    /** A new document of tester's: its id. */
    async newDoc() {
      const at = (await get("/new")).headers.get("location")!.replace(/(\/edit|#edit)$/, "");
      return ((await (await get(`${at.startsWith("http") ? at.slice(root.length) : at}/api/name`)).json()) as { id: string }).id;
    },
    async versions(id: string) { return (await (await get(`/api/docs/${id}/versions?limit=20`)).json() as { versions: { n: number; authors: string[] }[] }).versions; },
    /** Says `script` (the scripted model's steps) to the admin agent. */
    async adminAgent(script: unknown[]) { const r = await post("/api/factory/agent", { text: "@script " + JSON.stringify(script) }); expect(r.ok, await r.text()).toBe(true); },
  };
  return w;
}

/** A setting no other test reads, and a value of its own. */
export const SETTING = "delete_docs_after_hours";
export const freshHours = () => 100 + Math.floor(Math.random() * 5000);
