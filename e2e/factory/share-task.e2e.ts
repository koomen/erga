// Share with agent: an admin token in the editor's card (tests/factory.ts, 11).
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

await servers.factory();

const TOKEN = /erga_[A-Za-z0-9_-]{20,}/;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test("an outside agent with an admin token queues a task with a dependency, as the admin's agent; changes its dependencies; the task's VM pushes with its git token; it sends instructions and discards, under the admin's name; the change log credits the admin", { timeout: TASK_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const b = await board(tab.page, s.root);
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(await b.eval<string>(`fetch("/tokens/new", { method: "POST", body: new URLSearchParams({ label: "Claude Code 🤖", scope: "admin" }) }).then((r) => r.text())`))![1];
  const as = (path: string, init: { method?: string; json?: unknown } = {}) => fetch(`${s.root}/api/factory${path}`, { method: init.method ?? (init.json ? "POST" : "GET"), headers: { ...bearer(token), ...(init.json ? { "Content-Type": "application/json" } : {}) }, body: init.json ? JSON.stringify(init.json) : undefined });
  const dep = await f.make("Before the shared agent's task");
  expect((await as(`/tasks/${dep}`)).ok).toBe(true);
  const r = await as("/tasks", { json: { title: "Shared agent's task", description: "From outside.", startAfter: [dep] } });
  const t = await r.json() as { id: number; by: string; startAfter: number[] };
  expect(r.status).toBe(201);
  expect(t.by).toBe("tester, via a shared agent (Claude Code 🤖)");
  expect(t.startAfter).toEqual([dep]);
  expect((await as(`/tasks/${t.id}`, { method: "PATCH", json: { startAfter: null, mergeAfter: [dep] } })).status).toBe(200);
  // Free of its start dependency, it starts: its VM's git token carries the agent's name, and the stand-in pushes with it.
  await f.until(t.id, "complete");
  expect(f.branches()[(await f.task(t.id)).branch]).toBeTruthy();
  await f.until(dep, "complete");
  expect((await as(`/tasks/${dep}/revise`, { json: { instructions: "One more word." } })).status).toBe(200);
  const discarded = await as(`/tasks/${t.id}/discard`, { method: "POST", json: {} });
  expect(discarded.status).toBe(200);
  expect((await f.task(t.id)).log.some((l) => l.message == "Discarded by tester, via a shared agent (Claude Code 🤖)")).toBe(true);
  await tab.page.goto(`${s.root}/admin/changes`);
  await until(() => b.eval(`!!document.querySelector("li.change")`), 10_000, "the change log");
  const line = await b.eval<{ by: string; via: string | null; what: string } | undefined>(`[...document.querySelectorAll("li.change")].map((li) => ({ by: li.querySelector(".by").textContent, via: li.querySelector(".via")?.dataset.via ?? null, what: li.querySelector(".what").textContent.replace(/\\s+/g, " ").trim() })).find((l) => l.what.startsWith("task #${t.id} added: Shared agent's task"))`);
  expect(line?.by).toBe("tester");
  expect(line?.via).toBe("a shared agent (Claude Code 🤖)");
});
