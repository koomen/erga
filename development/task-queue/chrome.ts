// Live mode's Chrome window (AGENTS.md, "Live mode"): a visible Chrome of its
// own, with its own profile and DevTools port, never the user's everyday
// browser. The queue launches it for `tq live`, records it on the task
// (chrome: {pid, port, profile, target}), reattaches to it on the next
// `tq live`, reads what it shows for `tq look`, and closes it when the task
// is merged or discarded.
//
// TASK_QUEUE_CHROME picks the browser binary; TASK_QUEUE_CHROME_HEADLESS=1
// launches it headless (the queue's own tests).

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const CHROME = process.env.TASK_QUEUE_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface LiveChrome {
  pid: number;
  /** Its DevTools port: http://127.0.0.1:<port>/json lists its tabs. */
  port: number;
  /** Its own profile (user data dir). */
  profile: string;
  /** The tab it opened on the task's dev server. */
  target?: string;
}

interface Target { id: string; type: string; url: string; title: string; webSocketDebuggerUrl?: string }

/** Answers on its DevTools port. */
export async function alive(c: LiveChrome | undefined): Promise<boolean> {
  if (!c) return false;
  try { return (await fetch(`http://127.0.0.1:${c.port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

/** Starts a Chrome window on `url`, with `profile` as its own user data dir, in a process group of its own (it outlives the queue). */
export async function launch(profile: string, url: string): Promise<LiveChrome> {
  mkdirSync(profile, { recursive: true });
  const portFile = join(profile, "DevToolsActivePort");
  rmSync(portFile, { force: true }); // last time's
  const headless = process.env.TASK_QUEUE_CHROME_HEADLESS == "1";
  const child = spawn(CHROME, [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--window-size=1280,900", ...(headless ? ["--headless=new"] : []), url,
  ], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 400; i++) {
    await Bun.sleep(50);
    let port = 0;
    try { port = Number(readFileSync(portFile, "utf8").split("\n")[0]); } catch {}
    if (port && (await alive({ pid: child.pid!, port, profile }))) {
      const c: LiveChrome = { pid: child.pid!, port, profile };
      c.target = (await pages(c)).find((p) => p.url.startsWith(new URL(url).origin))?.id ?? (await pages(c))[0]?.id;
      return c;
    }
  }
  try { process.kill(child.pid!, "SIGKILL"); } catch {}
  throw new Error(`Chrome didn't start (${CHROME})`);
}

/** Its tabs (real pages, not devtools or extensions). */
export async function pages(c: LiveChrome): Promise<Target[]> {
  const list: Target[] = await (await fetch(`http://127.0.0.1:${c.port}/json/list`)).json();
  return list.filter((t) => t.type == "page" && !t.url.startsWith("devtools://") && !t.url.startsWith("chrome-extension://"));
}

/**
 * Brings it to the front on a tab of the dev server at `url`'s origin (the one it opened, or any), opening
 * `url` in a new tab if none is left. Returns the tab's id.
 */
export async function reattach(c: LiveChrome, url: string): Promise<string> {
  const origin = new URL(url).origin;
  const tabs = await pages(c);
  let tab = tabs.find((t) => t.id == c.target && t.url.startsWith(origin)) ?? tabs.find((t) => t.url.startsWith(origin));
  if (!tab) tab = await (await fetch(`http://127.0.0.1:${c.port}/json/new?${encodeURI(url)}`, { method: "PUT" })).json() as Target;
  await fetch(`http://127.0.0.1:${c.port}/json/activate/${tab.id}`);
  return tab.id;
}

/** Closes it (the whole browser), and drops its profile. */
export async function close(c: LiveChrome | undefined): Promise<void> {
  if (!c) return;
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${c.port}/json/version`, { signal: AbortSignal.timeout(1500) })).json();
    const s = await Session.open(webSocketDebuggerUrl);
    await s.send("Browser.close").catch(() => {});
    s.close();
  } catch {}
  for (let i = 0; i < 40 && running(c.pid); i++) await Bun.sleep(50);
  if (running(c.pid)) { try { process.kill(c.pid, "SIGTERM"); } catch {} }
  setTimeout(() => { if (running(c.pid)) try { process.kill(c.pid, "SIGKILL"); } catch {} rmSync(c.profile, { recursive: true, force: true }); }, 3000);
}

const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export interface Look {
  url: string;
  title: string;
  /** The tab shown (focused, else visible, else the first). */
  target: string;
  /** Every tab: url and title. */
  tabs: { url: string; title: string; target: string; shown: boolean }[];
  /** Text selected in it, in any of its frames. */
  selection?: string;
  /** Its console, latest last (errors and warnings always, everything with `console`). */
  console?: string[];
  /** Where the screenshot went, with `shot`. */
  screenshot?: string;
}

/** What the window shows the user: the tab in front, its URL, title, selection, console and, given a path, a screenshot. */
export async function look(c: LiveChrome, opts: { shot?: string; console?: boolean } = {}): Promise<Look> {
  const tabs = await pages(c);
  if (!tabs.length) throw new Error("the window has no tabs open");
  const states = await Promise.all(tabs.map(async (t) => {
    const s = await Session.open(t.webSocketDebuggerUrl!).catch(() => null);
    if (!s) return { t, score: 0 };
    try {
      const r = await s.send("Runtime.evaluate", { expression: "({v: document.visibilityState == 'visible', f: document.hasFocus()})", returnByValue: true });
      const v = r.result?.value ?? {};
      return { t, score: (v.f ? 2 : 0) + (v.v ? 1 : 0) };
    } catch { return { t, score: 0 }; } finally { s.close(); }
  }));
  const best = states.reduce((a, b) => (b.score > a.score ? b : a));
  const tab = best.t;
  const s = await Session.open(tab.webSocketDebuggerUrl!);
  try {
    const out: Look = { url: tab.url, title: tab.title, target: tab.id, tabs: tabs.map((t) => ({ url: t.url, title: t.title, target: t.id, shown: t.id == tab.id })) };
    // The console so far: Console and Log replay what they have collected on enable, Runtime its exceptions.
    const messages: { level: string; text: string }[] = [];
    s.on("Console.messageAdded", (p) => messages.push({ level: p.message.level, text: p.message.text }));
    s.on("Log.entryAdded", (p) => messages.push({ level: p.entry.level, text: `${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ""}` }));
    s.on("Runtime.exceptionThrown", (p) => messages.push({ level: "error", text: p.exceptionDetails.exception?.description ?? p.exceptionDetails.text }));
    await Promise.all([s.send("Console.enable").catch(() => {}), s.send("Log.enable").catch(() => {}), s.send("Runtime.enable").catch(() => {})]);
    // The selection, in whichever frame has one: each frame (and each frame in another process) in a world of our own.
    out.selection = (await selections(s)).filter(Boolean).join("\n---\n") || undefined;
    await Bun.sleep(100);
    const shown = messages.filter((m) => opts.console || ["error", "warning"].includes(m.level)).map((m) => `${m.level}: ${m.text}`);
    if (shown.length) out.console = shown.slice(-30);
    if (opts.shot) {
      const { data } = await s.send("Page.captureScreenshot", { format: "png" });
      await Bun.write(opts.shot, Buffer.from(data, "base64"));
      out.screenshot = opts.shot;
    }
    return out;
  } finally { s.close(); }
}

const SELECTED = `(() => { const a = document.activeElement; if (a && typeof a.selectionStart == "number" && a.selectionEnd > a.selectionStart) return a.value.slice(a.selectionStart, a.selectionEnd); return String(getSelection() ?? ""); })()`;

async function selections(s: Session): Promise<string[]> {
  const found: string[] = [];
  const inFrames = async (session?: string) => {
    const { frameTree } = await s.send("Page.getFrameTree", {}, session);
    const ids: string[] = [];
    const walk = (n: any) => { ids.push(n.frame.id); for (const c of n.childFrames ?? []) walk(c); };
    walk(frameTree);
    for (const frameId of ids) {
      try {
        const { executionContextId } = await s.send("Page.createIsolatedWorld", { frameId, worldName: "tq-look" }, session);
        const r = await s.send("Runtime.evaluate", { expression: SELECTED, contextId: executionContextId, returnByValue: true }, session);
        if (r.result?.value) found.push(String(r.result.value));
      } catch {}
    }
  };
  await inFrames();
  // Frames from other sites run in processes of their own: attach to each.
  const attached: string[] = [];
  s.on("Target.attachedToTarget", (p) => { if (p.targetInfo.type == "iframe") attached.push(p.sessionId); });
  await s.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  await Bun.sleep(100);
  for (const id of attached) await inFrames(id).catch(() => {});
  return found;
}

/** A DevTools connection (flat sessions: messages for an attached frame carry its sessionId). */
class Session {
  private seq = 0;
  private waiting = new Map<number, { ok: (r: any) => void; no: (e: Error) => void }>();
  private handlers = new Map<string, ((p: any) => void)[]>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id != null) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? w?.no(new Error(m.error.message)) : w?.ok(m.result);
      } else for (const h of this.handlers.get(m.method) ?? []) h(m.params);
    };
    ws.onclose = () => { for (const w of this.waiting.values()) w.no(new Error("closed")); this.waiting.clear(); };
  }
  static open(url: string): Promise<Session> {
    return new Promise((ok, no) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { no(new Error("DevTools didn't answer")); ws.close(); }, 5000);
      ws.onopen = () => { clearTimeout(timer); ok(new Session(ws)); };
      ws.onerror = () => { clearTimeout(timer); no(new Error(`couldn't reach ${url}`)); };
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.seq;
    return new Promise((ok, no) => {
      this.waiting.set(id, { ok, no });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.waiting.delete(id)) no(new Error(`${method}: no answer`)); }, 10000);
    });
  }
  on(method: string, f: (p: any) => void) { this.handlers.set(method, [...(this.handlers.get(method) ?? []), f]); }
  close() { try { this.ws.close(); } catch {} }
}
