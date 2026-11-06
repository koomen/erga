// The Chrome DevTools Protocol, over a browser binding (cloudflare/browser.ts): Cloudflare Browser Rendering's, or
// the dev server's Chrome behind the same calls. The binding gives a session (POST /v1/devtools/browser) and a
// WebSocket to it (/v1/devtools/browser/<session>); on the socket go CDP's JSON messages, a page's with its
// sessionId (Target.attachToTarget, flatten). Only what view_page needs (cloudflare/render.ts), in the calls
// @cloudflare/puppeteer made for it.

/** Cloudflare's browser binding: its fetch answers the calls below on any host. */
export interface BrowserBinding {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

const HOST = "https://fake.host";

async function json<T>(r: Response, what: string): Promise<T> {
  const text = await r.text();
  if (r.status != 200) throw new Error(`Unable to ${what}: code: ${r.status}: message: ${text}`);
  return JSON.parse(text) as T;
}

/** The browser sessions open now; one with a connectionId has a connection already. */
export const sessions = async (b: BrowserBinding) =>
  (await json<{ sessions: { sessionId: string; connectionId?: string }[] }>(await b.fetch(`${HOST}/v1/sessions`), "fetch sessions"))
    .sessions;

/** A new session, kept `keepAlive` ms after its last use, and a connection to it. */
export async function launch(b: BrowserBinding, keepAlive: number): Promise<Browser> {
  const r = await b.fetch(`${HOST}/v1/devtools/browser?keep_alive=${keepAlive}`, { method: "POST" });
  return connect(b, (await json<{ sessionId: string }>(r, "create a new browser")).sessionId);
}

/** A connection to a session. */
export async function connect(b: BrowserBinding, sessionId: string): Promise<Browser> {
  const r = await b.fetch(`${HOST}/v1/devtools/browser/${sessionId}`, { headers: { Upgrade: "websocket" } });
  const ws = (r as Response & { webSocket?: WebSocket & { accept(): void } }).webSocket;
  if (!ws) throw new Error(`Unable to connect to session ${sessionId}: code: ${r.status}: message: ${await r.text()}`);
  ws.accept();
  return new Browser(ws);
}

type Params = Record<string, any>;

export class Browser {
  connected = true;
  private next = 1;
  private calls = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private listeners = new Set<(method: string, params: Params, session?: string) => void>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(typeof e.data == "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer));
      if (m.id == null) for (const f of this.listeners) f(m.method, m.params, m.sessionId);
      else {
        const call = this.calls.get(m.id);
        this.calls.delete(m.id);
        if (m.error) call?.fail(new Error(`${m.error.message}${m.error.data ? ` ${m.error.data}` : ""}`));
        else call?.ok(m.result);
      }
    });
    ws.addEventListener("close", () => this.closed());
  }

  private closed(): void {
    this.connected = false;
    for (const c of this.calls.values()) c.fail(new Error("The browser's connection closed."));
    this.calls.clear();
  }

  send(method: string, params: Params = {}, session?: string): Promise<any> {
    if (!this.connected) return Promise.reject(new Error("The browser's connection closed."));
    const id = this.next++;
    return new Promise((ok, fail) => {
      this.calls.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
    });
  }

  /** Each event (of a page: its session), until the answer is called. */
  on(f: (method: string, params: Params, session?: string) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** A browser context of its own (cookies, storage, cache), gone with this connection. */
  async newContext(): Promise<string> {
    return (await this.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId;
  }

  async newPage(context?: string): Promise<Page> {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank", ...(context ? { browserContextId: context } : {}) });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await Promise.all(["Page.enable", "Runtime.enable", "Log.enable"].map((m) => page.send(m)));
    await page.send("Page.setLifecycleEventsEnabled", { enabled: true });
    return page;
  }

  disconnect(): void {
    this.ws.close();
    this.closed();
  }
}

/** An exception's message, as puppeteer gave it: without its stack, and without its class's name in front. */
function exceptionMessage(d: Params): string {
  const e = d.exception;
  if (!e) return d.text;
  if ((e.type != "object" || e.subtype != "error") && !e.objectId) return String(e.value ?? e.unserializableValue ?? e.description);
  const lines: string[] = e.description?.split("\n    at ") ?? [];
  const size = Math.min(d.stackTrace?.callFrames.length ?? 0, lines.length - 1);
  lines.splice(-size, size);
  const message = lines.join("\n");
  return e.className && message.startsWith(`${e.className}: `) ? message.slice(e.className.length + 2) : message;
}

/** A console message's text: its arguments, a value as it is and an object by its description. */
const consoleText = (args: Params[]) =>
  args.map((a) => (a.objectId ? (a.description ?? a.type) : String(a.value ?? a.unserializableValue ?? a.description))).join(" ");

export class Page {
  /** The loads that are done (their loaderId), and the one goto waits for. */
  private loads = new Set<string>();
  private waiting: { loader: string; done: () => void } | null = null;
  /** Its listeners on the browser's connection, which outlives the page: close (or detach) removes them. */
  private offs: (() => void)[] = [];

  constructor(
    private readonly browser: Browser,
    private readonly targetId: string,
    private readonly session: string
  ) {
    this.on((method, p) => {
      if (method != "Page.lifecycleEvent" || p.name != "load") return;
      this.loads.add(p.loaderId);
      const w = this.waiting;
      if (w && w.loader == p.loaderId) w.done();
    });
  }

  send(method: string, params: Params = {}): Promise<any> {
    return this.browser.send(method, params, this.session);
  }

  /** Each of this page's events, until the answer is called (or the page closes). */
  on(f: (method: string, params: Params) => void): () => void {
    const off = this.browser.on((method, params, session) => {
      if (session == this.session) f(method, params);
    });
    this.offs.push(off);
    return off;
  }

  /** Stops hearing the page's events. */
  detach(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /**
   * Each frame of the page on another site (its own target, its own process): `f` gets it as a Page, before its
   * scripts run (it starts paused, and goes on once `f` is done). Another kind of target (a worker) just goes on.
   */
  async onFrames(f: (frame: Page, url: string) => Promise<void>): Promise<void> {
    this.on((method, p) => {
      if (method != "Target.attachedToTarget") return;
      const child = new Page(this.browser, p.targetInfo.targetId, p.sessionId);
      void (async () => {
        if (p.targetInfo.type == "iframe") await f(child, p.targetInfo.url).catch(() => {});
        else child.detach();
        await child.send("Runtime.runIfWaitingForDebugger").catch(() => {});
      })();
    });
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  /** The page's uncaught errors, and its console's messages and log entries (their level, their text). */
  onErrors(error: (message: string) => void, console: (level: string, text: string) => void): void {
    this.on((method, p) => {
      if (method == "Runtime.exceptionThrown") error(exceptionMessage(p.exceptionDetails));
      else if (method == "Runtime.consoleAPICalled") console(p.type, consoleText(p.args));
      else if (method == "Log.entryAdded") console(p.entry.level, p.entry.text);
    });
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      mobile: false,
      width,
      height,
      deviceScaleFactor: 1,
      screenOrientation: width > height ? { angle: 90, type: "landscapePrimary" } : { angle: 0, type: "portraitPrimary" },
    });
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }

  colorScheme(scheme: string): Promise<void> {
    return this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  }

  /** Opens `url` and waits for its load event; throws after `timeoutMs`. */
  async goto(url: string, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          const r = await this.send("Page.navigate", { url });
          if (r.errorText) throw new Error(`${r.errorText} at ${url}`);
          if (r.loaderId && !this.loads.has(r.loaderId)) await new Promise<void>((done) => (this.waiting = { loader: r.loaderId, done }));
        })(),
        new Promise((_, fail) => {
          timer = setTimeout(() => fail(new Error(`Navigation timeout of ${timeoutMs} ms exceeded`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.waiting = null;
    }
  }

  /**
   * An expression's value (a promise's, once it settles), as JSON brings it; in the page's main world, or in the
   * execution context `context` (a frame's, in the same process). Throws what the expression threw.
   */
  async evaluate<T = unknown>(expression: string, context?: number): Promise<T> {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      ...(context != null ? { contextId: context } : {}),
    });
    if (r.exceptionDetails) throw new Error(exceptionMessage(r.exceptionDetails));
    return r.result.value as T;
  }

  /** A PNG, base64: of the viewport, or of `clip` in the page's coordinates. */
  async screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<string> {
    await this.send("Page.bringToFront");
    const round = clip && { x: Math.round(clip.x), y: Math.round(clip.y) };
    const r = await this.send("Page.captureScreenshot", {
      format: "png",
      ...(clip && round
        ? {
            clip: {
              ...round,
              width: Math.round(clip.width + clip.x - round.x),
              height: Math.round(clip.height + clip.y - round.y),
              scale: 1,
            },
            captureBeyondViewport: true,
          }
        : { captureBeyondViewport: false }),
    });
    return r.data;
  }

  async close(): Promise<void> {
    this.detach();
    await this.browser.send("Target.closeTarget", { targetId: this.targetId });
  }
}
