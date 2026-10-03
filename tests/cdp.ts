// Minimal Chrome DevTools Protocol driver for the tests: launches headless
// Chrome, opens pages and sends real input events.
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { availableParallelism, tmpdir } from "os";
import { join } from "path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const ROOT = new URL("..", import.meta.url).pathname;
/**
 * Where scripts that exist to take pictures (screenshots.ts, smoke.ts,
 * multi-shot.ts) put them: a temp folder, printed when written, so nothing
 * lands in the repo and the OS cleans up. ERGA_SHOTS puts them elsewhere.
 */
export const SHOTS = process.env.ERGA_SHOTS || join(process.env.TMPDIR || tmpdir(), "erga-shots");

export class Browser {
  private constructor(private proc: Subprocess, private port: number, private profile: string) {}

  /**
   * Starts a headless Chrome on a port it picks itself (port 0, read back
   * from DevToolsActivePort): with many browsers starting at once, a random
   * port of our own would sometimes collide, and two test workers would
   * silently share one browser and its storage.
   */
  static async launch(): Promise<Browser> {
    const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "edtest-"));
    const proc = spawn([CHROME, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--allow-file-access-from-files",
      "--disable-features=Translate,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
      // Tests run many tabs at once: a tab in the background must keep its
      // timers and frames running as if it were in front.
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "about:blank"], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 600; i++) {
      try {
        const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
        if (port) { await fetch(`http://127.0.0.1:${port}/json/version`); return new Browser(proc, port, profile); }
      } catch { /* not up yet */ }
      await Bun.sleep(25);
    }
    proc.kill();
    throw new Error("Chrome did not start");
  }

  /** A tab, in the default context or in one from `context()`. */
  async page(context?: string): Promise<Page> {
    let url: string;
    if (context) {
      const { targetId } = await (await this.browserLevel()).send("Target.createTarget", { url: "about:blank", browserContextId: context });
      url = `ws://127.0.0.1:${this.port}/devtools/page/${targetId}`;
    } else {
      url = (await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" })).json()).webSocketDebuggerUrl;
    }
    const page = new Page(url);
    await page.ready;
    return page;
  }

  /**
   * A fresh browser context, like a private window: its own storage and
   * cookies, so tabs in it don't share localStorage with other tests' tabs on
   * the same origin (every document on a deployment is one origin).
   */
  async context(): Promise<string> {
    return (await (await this.browserLevel()).send("Target.createBrowserContext", { disposeOnDetach: false })).browserContextId;
  }

  private browser?: Promise<Page>;
  /** The browser-level DevTools connection (for contexts and targets). */
  private browserLevel(): Promise<Page> {
    return (this.browser ??= (async () => {
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json();
      const conn = new Page(webSocketDebuggerUrl);
      await conn.ready;
      return conn;
    })());
  }

  close() {
    this.proc.kill();
    try { rmSync(this.profile, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Runs `items` across `workers` headless Chromes, one item at a time each.
 * Separate browsers, not tabs, because pages on the same file:// origin share
 * localStorage, which the editor tests seed and read. Results keep `items`' order.
 */
export async function pool<T, R>(items: T[], run: (item: T, browser: Browser) => Promise<R>, workers = Math.min(8, Math.max(2, availableParallelism() - 2))): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    const browser = await Browser.launch();
    try { while (next < items.length) { const i = next++; out[i] = await run(items[i], browser); } }
    finally { browser.close(); }
  }));
  return out;
}

export const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};

export class Page {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, (v: any) => void>();
  private listeners = new Map<string, ((params: any) => void)[]>();
  onEvent(method: string, f: (params: any) => void) { this.listeners.set(method, [...(this.listeners.get(method) ?? []), f]); }
  errors: string[] = [];
  ready: Promise<void>;
  /** Frames on other sites (each its own DevTools session), as auto-attached after `open`. */
  private frames = new Set<string>();
  /** The one among them that holds the page editor (frame.ts), once found. */
  private editorFrame: string | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (m) => {
      const d = JSON.parse(m.data as string);
      // Events from a frame's session are only collected for errors, below; the page's own listeners don't see them.
      if (d.method && !d.sessionId) for (const f of this.listeners.get(d.method) ?? []) f(d.params);
      if (d.method == "Target.attachedToTarget" && d.params.targetInfo.type == "iframe") {
        this.frames.add(d.params.sessionId);
        this.send("Runtime.enable", {}, 10_000, d.params.sessionId).catch(() => {});
      } else if (d.method == "Target.detachedFromTarget") {
        this.frames.delete(d.params.sessionId);
        if (this.editorFrame == d.params.sessionId) this.editorFrame = null;
      }
      if (d.id && this.pending.has(d.id)) { this.pending.get(d.id)!(d); this.pending.delete(d.id); }
      else if (d.method == "Runtime.exceptionThrown") this.errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
      else if (d.method == "Runtime.consoleAPICalled" && d.params.type == "error") this.errors.push("console.error: " + d.params.args.map((a: any) => a.value ?? a.description).join(" "));
    };
    this.ready = new Promise((r) => (this.ws.onopen = () => r()));
  }

  /** A DevTools command; never waits forever (a stuck browser fails the test rather than hanging it). */
  send(method: string, params: any = {}, timeoutMs = 30_000, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const i = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(i); reject(new Error(`${method}: no answer from the browser in ${timeoutMs / 1000}s`)); }, timeoutMs);
      this.pending.set(i, (d) => { clearTimeout(timer); d.error ? reject(new Error(method + ": " + JSON.stringify(d.error))) : resolve(d.result); });
      this.ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async eval<T = any>(expr: string, sessionId?: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, 30_000, sessionId);
    if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + "\n" + expr);
    return r.result.value;
  }

  /**
   * Evaluates in the page editor's frame (frame.ts), which runs on the
   * document's own origin, out of the shell's reach: `document` there is the
   * frame's, and the page itself is `document.getElementById("page")`.
   */
  async frame<T = any>(expr: string): Promise<T> {
    for (let tries = 0; ; tries++) {
      const session = this.editorFrame ?? await this.findEditorFrame();
      if (session) {
        const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, 30_000, session).catch(() => null);
        if (r) {
          if (r.exceptionDetails) throw new Error("frame eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + "\n" + expr);
          return r.result.value;
        }
        this.editorFrame = null; // gone (reloaded): look again
      }
      if (tries > 100) throw new Error("the page editor's frame never appeared");
      await Bun.sleep(50);
    }
  }

  private async findEditorFrame(): Promise<string | null> {
    for (const s of this.frames) {
      const ok = await this.eval<boolean>("!!window.ergaFrame", s).catch(() => false);
      if (ok) return (this.editorFrame = s);
    }
    return null;
  }

  async open(url: string, opts: { width?: number; height?: number; dark?: boolean; clear?: boolean; doc?: string; scale?: number; timescale?: number } = {}) {
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    // The page editor's frame is on another site: its own session (see `frame`).
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    // The page editor's timers run this much faster (src/page/editor.ts, `ms`); kept across reloads.
    if (opts.timescale) await this.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__ergaTimescale = ${opts.timescale}` });
    await this.send("Emulation.setDeviceMetricsOverride", { width: opts.width ?? 1300, height: opts.height ?? 860, deviceScaleFactor: opts.scale ?? 1, mobile: false });
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: opts.dark ? "dark" : "light" }] });
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    if (opts.clear !== false || opts.doc != null) {
      // Seed storage from a blank page on the same (file://) origin, so no
      // editor instance is around to autosave over it on pagehide.
      await this.navigate(`file://${ROOT}tests/blank.html`);
      await this.eval(`localStorage.clear(); ${opts.doc != null ? `localStorage.setItem("erga:doc:v1", ${JSON.stringify(opts.doc)}); localStorage.setItem("erga:view:v1", JSON.stringify({anchor: 0, head: 0, scrollY: 0}));` : ""} true`);
    }
    await this.navigate(url);
    await this.eval("document.fonts.ready.then(() => true)");
    await this.settle();
  }

  /** Navigates and waits for the load event (not a fixed pause). */
  async navigate(url: string) {
    const loaded = new Promise<void>((resolve) => {
      const done = () => { this.listeners.set("Page.loadEventFired", (this.listeners.get("Page.loadEventFired") ?? []).filter((f) => f != done)); resolve(); };
      this.onEvent("Page.loadEventFired", done);
    });
    await this.send("Page.navigate", { url });
    await Promise.race([loaded, Bun.sleep(10_000)]);
  }

  /**
   * Lets the page catch up with input just sent: two animation frames, so
   * selectionchange, input handlers and the next paint have all run (with
   * a timeout in case frames are throttled).
   */
  async settle() {
    await this.eval(`new Promise((r) => { const t = setTimeout(r, 100); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(true); })); })`);
  }

  async key(key: string, modifiers = 0) {
    const k = KEYS[key];
    let code: string, keyCode: number, text: string | undefined;
    if (k) ({ code, keyCode, text } = k);
    else if (/^[a-z]$/i.test(key)) { code = "Key" + key.toUpperCase(); keyCode = key.toUpperCase().charCodeAt(0); text = key; }
    else if (/^[0-9]$/.test(key)) { code = "Digit" + key; keyCode = key.charCodeAt(0); text = key; }
    else {
      const map: Record<string, [string, number]> = { "/": ["Slash", 191], "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220], " ": ["Space", 32], ".": ["Period", 190], ",": ["Comma", 188], "-": ["Minus", 189], "=": ["Equal", 187], "`": ["Backquote", 192] };
      [code, keyCode] = map[key] ?? ["", 0];
      text = key;
    }
    const plain = !(modifiers & (MOD.Ctrl | MOD.Meta | MOD.Alt));
    const sendText = plain && text ? (modifiers & MOD.Shift && text.length == 1 ? text.toUpperCase() : text) : undefined;
    let keyName = key;
    if (modifiers & MOD.Shift && key.length == 1) keyName = key.toUpperCase();
    // No nativeVirtualKeyCode: on macOS it makes Chrome build a native key
    // event (and it wants a Mac key code, not this Windows one), which AppKit
    // answers with the system beep whenever the page doesn't handle the key.
    await this.send("Input.dispatchKeyEvent", { type: sendText ? "keyDown" : "rawKeyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers, text: sendText, unmodifiedText: sendText });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
  }

  async type(text: string, delay = 0) {
    for (const ch of text) {
      if (ch == "\n") await this.key("Enter");
      else await this.send("Input.insertText", { text: ch });
      if (delay) await Bun.sleep(delay);
    }
  }

  async mouse(type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number, extra: any = {}) {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: type == "mouseMoved" && !extra.buttons ? "none" : "left", ...extra });
  }

  async click(x: number, y: number, clickCount = 1, modifiers = 0) {
    await this.mouse("mouseMoved", x, y);
    for (let c = 1; c <= clickCount; c++) {
      await this.mouse("mousePressed", x, y, { clickCount: c, modifiers, buttons: 1 });
      await this.mouse("mouseReleased", x, y, { clickCount: c, modifiers });
    }
    await this.settle();
  }

  async drag(x1: number, y1: number, x2: number, y2: number, steps = 8) {
    await this.mouse("mouseMoved", x1, y1);
    await this.mouse("mousePressed", x1, y1, { clickCount: 1, buttons: 1 });
    for (let i = 1; i <= steps; i++) await this.mouse("mouseMoved", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, { buttons: 1, button: "left" });
    await this.mouse("mouseReleased", x2, y2, { clickCount: 1 });
    await this.settle();
  }

  async screenshot(path: string) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    await Bun.write(path, Buffer.from(r.data, "base64"));
  }

  close() { this.ws.close(); }
}
