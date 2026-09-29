// Minimal Chrome DevTools Protocol driver for the tests: launches headless
// Chrome, opens pages and sends real input events.
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const ROOT = new URL("../..", import.meta.url).pathname; // wip/
export const urlFor = (which: "editor" | "editor-cm") => `file://${ROOT}${which}/index.html`;

export class Browser {
  private constructor(private proc: Subprocess, private port: number, private profile: string) {}

  static async launch(port = 9400 + Math.floor(Math.random() * 400)): Promise<Browser> {
    const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "edtest-"));
    const proc = spawn([CHROME, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--allow-file-access-from-files",
      "--disable-features=Translate", "about:blank"], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`);
        return new Browser(proc, port, profile);
      } catch { await Bun.sleep(100); }
    }
    throw new Error("Chrome did not start");
  }

  async page(): Promise<Page> {
    const t = await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" })).json();
    const page = new Page(t.webSocketDebuggerUrl);
    await page.ready;
    return page;
  }

  close() {
    this.proc.kill();
    try { rmSync(this.profile, { recursive: true, force: true }); } catch {}
  }
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

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (m) => {
      const d = JSON.parse(m.data as string);
      if (d.method) for (const f of this.listeners.get(d.method) ?? []) f(d.params);
      if (d.id && this.pending.has(d.id)) { this.pending.get(d.id)!(d); this.pending.delete(d.id); }
      else if (d.method == "Runtime.exceptionThrown") this.errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
      else if (d.method == "Runtime.consoleAPICalled" && d.params.type == "error") this.errors.push("console.error: " + d.params.args.map((a: any) => a.value ?? a.description).join(" "));
    };
    this.ready = new Promise((r) => (this.ws.onopen = () => r()));
  }

  send(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const i = ++this.id;
      this.pending.set(i, (d) => (d.error ? reject(new Error(method + ": " + JSON.stringify(d.error))) : resolve(d.result)));
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }

  async eval<T = any>(expr: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + "\n" + expr);
    return r.result.value;
  }

  async open(url: string, opts: { width?: number; height?: number; dark?: boolean; clear?: boolean; doc?: string; scale?: number } = {}) {
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    await this.send("Emulation.setDeviceMetricsOverride", { width: opts.width ?? 1300, height: opts.height ?? 860, deviceScaleFactor: opts.scale ?? 1, mobile: false });
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: opts.dark ? "dark" : "light" }] });
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    if (opts.clear !== false || opts.doc != null) {
      // Seed storage from a blank page on the same (file://) origin, so no
      // editor instance is around to autosave over it on pagehide.
      await this.send("Page.navigate", { url: `file://${ROOT}editor/tests/blank.html` });
      await Bun.sleep(100);
      await this.eval(`localStorage.clear(); ${opts.doc != null ? `localStorage.setItem("scratchwork-editor:doc:v1", ${JSON.stringify(opts.doc)}); localStorage.setItem("scratchwork-editor:view:v1", JSON.stringify({anchor: 0, head: 0, scrollY: 0}));` : ""} true`);
    }
    await this.send("Page.navigate", { url });
    await Bun.sleep(200);
    await this.eval("document.fonts.ready.then(() => true)");
    await Bun.sleep(250);
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
    await this.send("Input.dispatchKeyEvent", { type: sendText ? "keyDown" : "rawKeyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers, text: sendText, unmodifiedText: sendText });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
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
    await Bun.sleep(60);
  }

  async drag(x1: number, y1: number, x2: number, y2: number, steps = 8) {
    await this.mouse("mouseMoved", x1, y1);
    await this.mouse("mousePressed", x1, y1, { clickCount: 1, buttons: 1 });
    for (let i = 1; i <= steps; i++) await this.mouse("mouseMoved", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, { buttons: 1, button: "left" });
    await this.mouse("mouseReleased", x2, y2, { clickCount: 1 });
    await Bun.sleep(60);
  }

  async screenshot(path: string) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    await Bun.write(path, Buffer.from(r.data, "base64"));
  }

  close() { this.ws.close(); }
}
