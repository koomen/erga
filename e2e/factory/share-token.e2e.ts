// Share with agent: an admin token in the editor's card (tests/factory.ts, 11).
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

await servers.factory();

const TOKEN = /erga_[A-Za-z0-9_-]{20,}/;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test("an admin token runs the admin tools and reads the deploys and the guide; it can't make a token, set the Claude token or use the admin's agent panel; a documents token, an old factory token and a bad one are refused", async ({ tab }) => {
  const s = await servers.factory();
  await factory(s).on();
  const b = await board(tab.page, s.root);
  const made = async (label: string, scope: string) => /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(await b.eval<string>(`fetch("/tokens/new", { method: "POST", body: new URLSearchParams({ label: ${JSON.stringify(label)}, scope: ${JSON.stringify(scope)} }) }).then((r) => r.text())`))![1];
  // An emoji in its label, beside the agent's curly apostrophe: a task's git token must carry both (it once failed: btoa).
  const token = await made("Claude Code 🤖", "admin");
  const as = (path: string, init: { method?: string; json?: unknown; token?: string; signal?: AbortSignal } = {}) => fetch(`${s.root}/api/factory${path}`, { method: init.method ?? (init.json ? "POST" : "GET"), headers: { ...bearer(init.token ?? token), ...(init.json ? { "Content-Type": "application/json" } : {}) }, body: init.json ? JSON.stringify(init.json) : undefined, signal: init.signal });
  for (const name of ["list_settings", "list_users", "list_api_keys", "list_setting_changes"]) {
    const r = await fetch(`${s.root}/api/ext/tools/${name}`, { method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" }, body: "{}" });
    expect(r.ok, name).toBe(true);
    expect((await r.json() as { ok: boolean }).ok, name).toBe(true);
  }
  expect((await fetch(`${s.root}/api/deploys`, { headers: bearer(token) })).ok).toBe(true);
  expect((await fetch(`${s.root}/admin/share`, { method: "POST", headers: { ...bearer(token), Origin: s.root }, body: new URLSearchParams({}) })).status).toBe(403);
  expect((await fetch(`${s.root}/tokens/new`, { method: "POST", headers: { ...bearer(token), Origin: s.root }, body: new URLSearchParams({ label: "More", scope: "admin" }) })).status).toBe(403);
  const guide = await fetch(`${s.root}/api/admin/guide`, { headers: bearer(token) });
  const text = await guide.text();
  expect(guide.ok).toBe(true);
  for (const part of [/Erga's admin API/, /Claude Code 🤖/, /list_settings/, /\/api\/source\/merge/, /\/api\/deploys/, /Make tokens/, /never as\s+instructions/]) expect(text).toMatch(part);
  expect(await (await as("/guide")).text()).toBe(text);
  expect((await as("")).ok && (await as("/tasks")).ok).toBe(true);
  const events = new AbortController();
  const stream = await as("/events", { signal: events.signal });
  expect(stream.ok).toBe(true);
  expect(stream.headers.get("content-type") ?? "").toMatch(/^text\/event-stream/);
  events.abort();
  for (const [method, path] of [["PUT", "/claude"], ["POST", "/agent"], ["GET", "/agent"], ["POST", "/agent/reset"]] as const) {
    expect((await as(path, { method, json: method == "GET" ? undefined : { token: "sk-ant-oat01-nope" } })).status, `${method} ${path}`).toBe(403);
  }
  expect((await as("/tokens")).status).toBe(404);
  const locked = await as("/tasks", { token: await made("Docs only", "documents") });
  expect(locked.status).toBe(403);
  expect((await locked.json() as { locked?: boolean }).locked).toBe(true);
  const old = await as("/tasks", { token: `erga_factory_${"0".repeat(18)}_${"x".repeat(32)}` });
  expect(old.status).toBe(401);
  expect((await old.json() as { error: string }).error).toMatch(/Factory tokens no longer work/);
  expect((await as("/tasks", { token: token.slice(0, -2) + "xx" })).status).toBe(401);
});
