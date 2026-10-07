// Helpers for the factory's tests: its API as the admin (DEV_LOGIN, "tester"),
// tasks made and waited for, the board in the test's tab, and the local
// repository the factory works on (dev/factory.ts). Each test turns the factory
// on itself and makes its own tasks, so it never depends on another test's,
// only on the worker's factory server (fixtures.ts, servers.factory).

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { branches } from "../../dev/factory";
import { cleanEnv } from "../env";
import { expect, servers, settle, until, type FactoryServer, type Page } from "../fixtures";

export { servers };

/** How long a simulated VM takes to do a task, at most: a clone, an install from Bun's cache, a change, a preview, a screenshot, a push. */
export const TASK_MS = 60_000;

export interface Task {
  id: number; title: string; status: string; branch: string; commit: string; base: string; url: string; vm: string;
  error?: string; summary: string; screenshots: { file: string }[]; log: { at: string; message: string }[];
  startAfter: number[]; mergeAfter: number[]; blockedBy?: { start?: number[]; stuck?: number[]; reason: string }; mergeCommit: string; by: string;
}

export function factory(s: FactoryServer) {
  const root = s.root;
  const api = async (path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) => {
    const r = await fetch(`${root}/api/factory${path}`, { method: init.method ?? (init.json ? "POST" : "GET"), headers: { Origin: root, ...(init.json ? { "Content-Type": "application/json" } : {}), ...init.headers }, body: init.json ? JSON.stringify(init.json) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const f = {
    root, server: s, api,
    repo: join(s.state, "factory", "erga.git"),
    task: async (id: number) => (await api(`/tasks/${id}`)).body as Task,
    status: async (id: number) => (await f.task(id)).status,
    setting: (value: string) => fetch(`${root}/admin/settings`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "factory", value: JSON.stringify(value) }) }),
    /** The factory on (each test that makes tasks says so itself). */
    async on() { expect((await f.setting("on")).ok).toBe(true); },
    /** A new task by the API: its id. */
    async make(title: string, description = "A note on the front page.", deps: Record<string, unknown> = {}) {
      const r = await api("/tasks", { json: { title, description, ...deps } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as number;
    },
    /** Waits until each task has `status` (and `also`, if given); the last log lines on failure. */
    async until(ids: number | number[], status: string | string[], ms = TASK_MS, also?: (t: Task) => boolean) {
      const want = ([] as string[]).concat(status);
      const all = ([] as number[]).concat(ids);
      await until(async () => { for (const id of all) { const t = await f.task(id); if (!want.includes(t.status) || (also && !also(t))) return false; } return true; }, ms, `task ${all.join(", ")} ${want.join(" or ")}`)
        .catch(async (e) => { throw new Error(`${(e as Error).message}\n${JSON.stringify(await Promise.all(all.map(async (id) => { const t = await f.task(id); return { id, status: t.status, error: t.error, log: t.log.slice(-6).map((l) => l.message) }; })), null, 1)}`); });
    },
    branches: () => branches(s.state),
    git: (...args: string[]) => spawnSync("git", ["-C", f.repo, ...args], { encoding: "utf8", env: cleanEnv() }).stdout,
    /** The simulated VMs a task has had (their folders). */
    vmsOf(id: number) { const dir = join(s.state, "factory", "vms"); return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(`task-${id}-`)) : []; },
    /** The next task id the factory will give. */
    async nextId() { return Math.max(0, ...((await api("/tasks")).body as Task[]).map((t) => t.id)) + 1; },
  };
  return f;
}

/** The board, /admin/factory, in `page`. */
export async function board(page: Page, root: string, size = { width: 1400, height: 900 }) {
  await page.setViewportSize(size);
  await page.goto(`${root}/admin/factory`);
  await until(() => page.evaluate(`!!document.querySelector('[data-col="queued"]')`), 15_000, "the board renders");
  return {
    page,
    click: (selector: string) => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no " + ${JSON.stringify(selector)}); el.click(); return true; })()`),
    fill: (selector: string, value: string) => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`),
    column: (col: string) => page.evaluate(`document.querySelector('[data-col="${col}"]')?.innerText ?? ""`) as Promise<string>,
    eval: <T = any>(expr: string) => page.evaluate(expr) as Promise<T>,
    settle: () => settle(page),
  };
}
export type Board = Awaited<ReturnType<typeof board>>;
