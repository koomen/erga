// Helpers for the admin agent's tests: the panel beside /admin's pages (src/page/factory-agent.ts) in the test's
// tab, messages to it on the scripted model ("text @script [steps]", agent.ts), the conversation the server keeps
// (worker/factory.ts, /api/admin/agent/*), and this clone's commit as the pretend Artifacts' staging and main
// (dev/git-server.ts), which the source and deploy tools read.
//
// The conversation is the admin's (DEV_LOGIN, "tester"), one for each server: a test on a worker's shared server
// starts a new one first (fresh), so it never sees another test's turns.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ensureBare } from "../../dev/git-server";
import { cleanEnv, ROOT } from "../env";
import { expect, until, type Page, type Server } from "../fixtures";

export interface Item { kind: string; name?: string; status?: string; path?: string; detail?: string; text?: string }

/** The tab's admin pages note each event stream they open, so a test can wait for the panel's (it has no other sign). */
const NOTE_STREAMS = () => {
  const ES = window.EventSource;
  const opened: EventSource[] = ((window as any).__eventStreams = []);
  window.EventSource = class extends ES { constructor(url: string | URL, init?: EventSourceInit) { super(url, init); opened.push(this); } };
};

const pushed = new Set<string>();
/** This clone's HEAD as staging and main in the server's pretend Artifacts, once for each server. */
export function stagingFromHere(s: Server) {
  if (pushed.has(s.state)) return;
  const bare = join(s.state, "artifacts", "erga", "erga.git");
  ensureBare(bare);
  const r = spawnSync("git", ["push", "-q", bare, "HEAD:refs/heads/staging", "HEAD:refs/heads/main"], { cwd: ROOT, env: cleanEnv(), encoding: "utf8", timeout: 60_000 });
  expect(r.status, `pushing this clone as staging and main: ${r.stderr}`).toBe(0);
  pushed.add(s.state);
}

/** Starts a new conversation for the admin, as "New conversation" does. */
export async function fresh(s: Server) {
  const r = await fetch(`${s.root}/api/admin/agent/conversation`, { method: "DELETE", headers: { Origin: s.root } });
  expect(r.ok).toBe(true);
}

/** The admin agent's panel on one of /admin's pages, in `page`. */
export function panel(page: Page, s: Server) {
  let noted = false;
  const p = {
    page,
    eval: <T = any>(expr: string) => page.evaluate(expr) as Promise<T>,
    /** Opens `path` and waits until the agent can take a message and its event stream is open. */
    async open(path = "/admin/factory") {
      if (!noted) { await page.addInitScript(NOTE_STREAMS); noted = true; }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(s.root + path);
      await p.ready();
    },
    ready: (ms = 10_000) => until(() => p.eval<boolean>(`document.getElementById("agent-send")?.title == "Type a message to send it." && !!window.__eventStreams?.some((e) => e.readyState == 1)`), ms, "the admin agent is on, its event stream open"),
    /** Sends a message from the panel's box. */
    send: (text: string) => p.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); document.getElementById("agent-send").click(); return true; })()`),
    /** The panel's conversation, as text. */
    chat: () => p.eval<string>(`document.getElementById("agent-log").textContent`),
    /** How many times the panel shows `text` (a scripted message holds its reply too, so a reply that came shows twice). */
    times: async (text: string) => (await p.chat()).split(text).length - 1,
    /** The conversation the server keeps. */
    conversation: async () => ((await (await fetch(`${s.root}/api/admin/agent/conversation`)).json()) as { log: { busy: boolean; items: Item[] } }).log,
    /** Sends `text` with a script of `steps` and a last reply `done`; waits for the reply and returns the turn's tool calls. */
    async say(text: string, steps: unknown[], done: string, ms = 15_000) {
      const before = (await p.conversation()).items.length;
      await p.send(`${text} @script ${JSON.stringify([...steps, { text: done }])}`);
      await until(async () => (await p.times(done)) >= 2, ms, `the reply "${done}"`).catch(async (e) => { throw new Error(`${(e as Error).message}\n${await p.chat()}`); });
      let log = await p.conversation();
      await until(async () => !(log = await p.conversation()).busy, 5000, "the turn ends");
      return log.items.slice(before).filter((i) => i.kind == "tool");
    },
  };
  return p;
}
export type Panel = ReturnType<typeof panel>;
