// How fast a document loads, viewing and editing: a repeatable benchmark in
// headless Chrome (tests/cdp.ts).
//
//   bun tests/bench.ts                       starts a dev server of its own (tests/host.ts) and measures it
//   bun tests/bench.ts --prod                the same Worker built for production (vite build) and run by vite preview
//   bun tests/bench.ts --url http://127.0.0.1:4400   a server that's already running (signed in as DEV_LOGIN)
//     --runs 5            runs of each case (medians are printed; default 3)
//     --profile desktop   or mobile (Slow 4G: 150ms, 1.6Mbps down, 4x slower CPU, a phone's screen), or both (default)
//     --only viewer       cases whose name contains this (front, viewer, editor, switch)
//     --waterfall         prints each case's requests, from its last run
//     --json out.json     writes every run's numbers
//     --latency 50        each call to the database or a document's Durable Object waits 50ms first, as if the
//                         Worker were that far from them (on erga.dev it often is): what the page's round trips cost
//
// The cases, each cold (a fresh browser profile: nothing cached; and a
// document just made, so its Durable Object has not opened its room yet) and
// warm (the same page loaded again, in the same profile):
//
//   front    /, the front page (the landing document, served directly from its deploy once that's done; its fonts
//            come from Google, so it varies with the network)
//   viewer   /<owner>/<slug>, a document of its own (a page with a stylesheet, a script and some text)
//   editor   /<owner>/<slug>/edit, the same document opened in the editor
//   switch   the viewer, then the pencil: how long until the editor is ready after the click
//
// What it measures, in ms from the start of the navigation:
//
//   ttfb      the shell's first byte (the HTML at the address)
//   fcp       the shell's first contentful paint (its own controls)
//   visible   the document's first contentful paint, in its frame on the pages origin: the document is on screen
//             (the homepage, served directly, has no frame: the page's own)
//   lcp       the largest contentful paint, the document's frame's (or the shell's, whichever is later)
//   load      the shell's load event (every frame loaded)
//   editable  the editor ready to type in (its controls in, the room joined: body.erga-editor-ready)
//   reqs, kB  requests made, and bytes over the wire (compressed), every frame's
//
// Server timings: each response from the front door says where its time
// went (Server-Timing), which --waterfall prints beside each request.

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { constants as zlibConstants, createGzip } from "zlib";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, Page, ROOT } from "./cdp";
import { startHost, freePort, type Host } from "./host";

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const RUNS = Number(opt("--runs") ?? 3);
const PROFILES = (opt("--profile") ?? "both") == "both" ? ["desktop", "mobile"] : [opt("--profile")!];
const ONLY = opt("--only");
const WATERFALL = args.includes("--waterfall");
const JSON_OUT = opt("--json");
/** Each call to the database or a document's Durable Object waits this long first (worker/timing.ts): erga.dev's distances, roughly. */
const LATENCY = opt("--latency") ?? "";

interface Profile { width: number; height: number; mobile: boolean; scale: number; cpu: number; net: { latency: number; downloadThroughput: number; uploadThroughput: number } | null }
const PROFILE: Record<string, Profile> = {
  desktop: { width: 1300, height: 860, mobile: false, scale: 1, cpu: 1, net: null },
  // Chrome DevTools' "Slow 4G" and its 4x CPU slowdown.
  mobile: { width: 390, height: 844, mobile: true, scale: 3, cpu: 4, net: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 } },
};

interface Request { url: string; start: number; end?: number; bytes: number; status?: number; type?: string; timing?: string; ttfb?: number }
interface Run { ttfb: number; fcp: number; visible: number; lcp: number; load: number; editable: number | null; reqs: number; kB: number; requests: Request[] }

// ---------------------------------------------------------------- the server

let host: Host | null = null;
let stopPreview: (() => void) | null = null;
let root = opt("--url")?.replace(/\/$/, "");
if (!root && args.includes("--prod")) root = await startPreview();
if (!root) { host = await startHost(null, { processEnv: LATENCY ? { ERGA_REMOTE_LATENCY_MS: LATENCY } : {} }); root = host.root; }
// Compressed, as Cloudflare compresses what erga.dev sends (the dev server and vite preview don't): a proxy in front.
const upstream = root;
if (!args.includes("--no-gzip") && !opt("--url")) root = compressing(upstream);

/**
 * A proxy that gzips text on its way to the browser, when the browser takes
 * it, as Cloudflare's edge does (brotli there, a little smaller still), and
 * passes WebSockets through. The Host header goes through as the browser sent
 * it, so the Worker's addresses (the pages origins included) point here.
 */
function compressing(target: string): string {
  const port = freePort();
  const to = new URL(target);
  Bun.serve<{ url: string; protocols: string | null }, {}>({
    hostname: "127.0.0.1", port,
    async fetch(req, server) {
      const url = new URL(req.url);
      const there = `${to.protocol}//${to.host}${url.pathname}${url.search}`;
      if (req.headers.get("upgrade")?.toLowerCase() == "websocket") {
        return server.upgrade(req, { data: { url: there.replace(/^http/, "ws"), protocols: req.headers.get("sec-websocket-protocol") } }) ? undefined : new Response("no upgrade", { status: 400 });
      }
      const headers = new Headers(req.headers);
      headers.set("x-forwarded-host", url.host);
      const res = await fetch(there, { method: req.method, headers, body: req.method == "GET" || req.method == "HEAD" ? undefined : await req.arrayBuffer(), redirect: "manual", decompress: true } as RequestInit);
      const out = new Headers(res.headers);
      out.delete("content-encoding");
      const type = out.get("content-type") ?? "";
      const gzip = res.body && res.status == 200 && /gzip/.test(req.headers.get("accept-encoding") ?? "") && /^(text\/|application\/(javascript|json)|image\/svg)/.test(type);
      if (!gzip) return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
      out.delete("content-length");
      out.set("content-encoding", "gzip");
      // As it arrives, each chunk flushed (a page sent in parts, the homepage's, gets its first part to the browser at once).
      const gz = createGzip({ level: 6, flush: zlibConstants.Z_SYNC_FLUSH });
      const reader = res.body!.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          gz.on("data", (b: Buffer) => c.enqueue(new Uint8Array(b)));
          gz.on("end", () => c.close());
          gz.on("error", (e) => c.error(e));
          (async () => { for (;;) { const { done, value } = await reader.read(); if (done) { gz.end(); return; } gz.write(value); } })().catch((e) => c.error(e));
        },
      });
      return new Response(body, { status: res.status, statusText: res.statusText, headers: out });
    },
    websocket: {
      open(ws) {
        const up = new WebSocket(ws.data.url, ws.data.protocols ? ws.data.protocols.split(",").map((p) => p.trim()) : undefined);
        up.binaryType = "arraybuffer";
        const queue: (string | ArrayBuffer | Uint8Array)[] = [];
        (ws.data as any).up = up; (ws.data as any).queue = queue;
        up.onopen = () => { for (const m of queue.splice(0)) up.send(m); };
        up.onmessage = (e) => ws.send(e.data as any);
        up.onclose = (e) => ws.close(e.code >= 4000 || e.code == 1000 ? e.code : 1000, e.reason);
      },
      message(ws, m) { const up = (ws.data as any).up as WebSocket; if (up.readyState == 1) up.send(m as any); else (ws.data as any).queue.push(m); },
      close(ws) { try { ((ws.data as any).up as WebSocket).close(); } catch {} },
    },
  });
  return `http://127.0.0.1:${port}`;
}

/**
 * A document to load, new each time: a copy of the bench's own (makeSource),
 * made as /new?from= makes any, so its Durable Object holds its files but
 * hasn't opened its room, as one woken after a while on erga.dev hasn't.
 */
let source: Promise<string> | null = null;
async function makeDoc(): Promise<string> {
  const id = await (source ??= makeSource());
  const made = await fetch(`${root}/new?from=${id}`, { method: "POST", headers: { Origin: root! }, redirect: "manual" });
  const at = made.headers.get("location");
  if (made.status != 302 || !at) throw new Error(`/new?from= answered ${made.status}: ${await made.text()}`);
  return at.replace(/\/edit(?=\?|$)/, "");
}

/** The bench's document: a page with a stylesheet, a script and a few screens of text. Its id. */
async function makeSource(): Promise<string> {
  const made = await fetch(`${root}/new`, { method: "POST", headers: { Origin: root! }, redirect: "manual" });
  const at = made.headers.get("location");
  if (made.status != 302 || !at) throw new Error(`/new answered ${made.status}: ${await made.text()}`);
  const address = at.replace(/\/edit(?=\?|$)/, "");
  const page = await fetch(`${root}${address}`);
  const base = /<meta name="erga-base" content="([^"]+)"/.exec(await page.text())?.[1];
  if (!base) throw new Error(`no erga-base at ${address}`);
  const put = async (path: string, text: string) => {
    const r = await fetch(`${root}${base}/api/stored/${path}`, { method: "PUT", body: text });
    if (!r.ok) throw new Error(`PUT ${path}: ${r.status} ${await r.text()}`);
  };
  await put("style.css", STYLE);
  await put("widget.js", SCRIPT);
  await put("index.html", PAGE);
  return base.split("/").pop()!;
}

const STYLE = `body { font: 17px/1.6 Georgia, serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; color: #222; }
h1 { font: 700 2.6rem/1.1 system-ui, sans-serif; letter-spacing: -.02em; } h2 { font: 600 1.4rem/1.2 system-ui, sans-serif; margin-top: 2.2em; }
.card { border: 1px solid #ddd; border-radius: 10px; padding: 1rem 1.25rem; background: #fafafa; } figure svg { width: 100%; height: auto; }`;
const SCRIPT = `document.querySelectorAll("[data-count]").forEach((el) => { let n = 0; el.addEventListener("click", () => { el.textContent = "Clicked " + (++n); }); });`;
const PARA = "Erga opens a page and lets you edit its text in place, on the rendered page, with the page's own styles and scripts running around it. Each paragraph is its own small editor; everything else keeps working as an ordinary web page. ";
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>A field guide to loading fast</title><link rel="stylesheet" href="style.css"></head>
<body>
<h1>A field guide to loading fast</h1>
<p class="card"><b>Summary.</b> ${PARA}</p>
${Array.from({ length: 12 }, (_, i) => `<h2>Section ${i + 1}</h2>\n<p>${PARA.repeat(2)}</p>\n<ul><li>${PARA.slice(0, 80)}</li><li>${PARA.slice(80, 170)}</li></ul>${i == 3 ? `\n<figure><svg viewBox="0 0 400 120"><rect x="10" y="10" width="380" height="100" rx="12" fill="#e8eefc"/><text x="200" y="68" text-anchor="middle" font-size="22">A diagram</text></svg></figure>` : ""}\n<p><button data-count>Click me</button></p>`).join("\n")}
<script src="widget.js"></script>
</body></html>
`;

/**
 * The Worker as it's deployed: built by vite build (minified, bundled; the
 * editor's files as its static assets) and run by vite preview in workerd,
 * in development mode so DEV_LOGIN signs in. Its numbers are closer to
 * erga.dev's than the dev server's, which transforms modules as they're asked for.
 */
async function startPreview(): Promise<string> {
  const port = freePort();
  const scratch = mkdtempSync(join(tmpdir(), "erga-bench-"));
  const envDir = join(scratch, "env");
  Bun.spawnSync(["mkdir", "-p", envDir]);
  writeFileSync(join(envDir, ".dev.vars"), `DEV_LOGIN=tester\nSESSION_SECRET=${crypto.randomUUID()}\n`);
  const env = { ...process.env, ERGA_STATE_DIR: join(scratch, "state"), ERGA_ENV_DIR: envDir, ERGA_VITE_CACHE: join(scratch, "vite"), ERGA_INSPECTOR: "0", ANTHROPIC_API_KEY: "", ERGA_LINK_SECRET: crypto.randomUUID(), ERGA_REMOTE_LATENCY_MS: LATENCY } as Record<string, string>;
  const site = Bun.spawnSync([join(ROOT, "site.sh")], { cwd: ROOT, stdout: "ignore", stderr: "inherit" });
  if (site.exitCode) throw new Error("site.sh failed");
  const vite = join(ROOT, "node_modules/vite/bin/vite.js");
  const build = Bun.spawnSync(["node", vite, "build", "--mode", "development", "--outDir", join(scratch, "dist")], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode) throw new Error(`vite build failed:\n${build.stderr}`);
  const proc = Bun.spawn(["node", vite, "preview", "--mode", "development", "--outDir", join(scratch, "dist"), "--port", String(port), "--strictPort"], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  stopPreview = () => { proc.kill(); rmSync(scratch, { recursive: true, force: true }); };
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`${url}/style.css`)).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(50);
  }
  // Its database's tables: the dev server brings them up to date as it starts (dev/plugin.ts); here the bench does.
  const migrated = await fetch(`${url}/__erga/migrate?link=${env.ERGA_LINK_SECRET}`, { method: "POST" });
  if (!migrated.ok) throw new Error(`migrating the preview's database: ${migrated.status} ${await migrated.text()}`);
  return url;
}

// ---------------------------------------------------------------- one load

/**
 * Loads `url` in `page` under `profile`, following every frame's requests and
 * paints, and answers when everything has settled (and, with `editable`, the
 * editor is ready). `before` runs once the page is ready to be measured but
 * before it navigates; `act` instead of navigating does something on the page
 * already there (the pencil), timed from when it starts.
 */
async function measure(page: Page, url: string | null, profile: Profile, opts: { editable?: boolean; act?: (page: Page) => Promise<void> } = {}): Promise<Run> {
  const requests = new Map<string, Request>();
  const frames = new Map<string, string>();
  const paints: { frame: string; name: string; mono: number }[] = [];
  const lcps: { frame: string; wall: number }[] = [];
  let t0mono = 0, t0wall = 0, loadMono = 0;
  const sessions: (string | undefined)[] = [undefined];
  const setUp = async (session?: string) => {
    const s = (m: string, p: any = {}) => page.send(m, p, 30_000, session);
    await Promise.all([s("Network.enable"), s("Page.enable"), s("Page.setLifecycleEventsEnabled", { enabled: true }), s("PerformanceTimeline.enable", { eventTypes: ["largest-contentful-paint"] }).catch(() => {}),
      s("Network.setCacheDisabled", { cacheDisabled: false }),
      profile.net ? s("Network.emulateNetworkConditions", { offline: false, ...profile.net }) : null,
      s("Emulation.setCPUThrottlingRate", { rate: profile.cpu }).catch(() => {})]);
  };
  page.onAny = (d) => {
    const p = d.params;
    // By request id alone: a frame's navigation is reported to its parent's session, and its end to the frame's own.
    const key = (id: string) => id;
    if (d.method == "Target.attachedToTarget") {
      const session = p.sessionId;
      sessions.push(session);
      setUp(session).catch(() => {}).finally(() => page.send("Runtime.runIfWaitingForDebugger", {}, 10_000, session).catch(() => {}));
    } else if (d.method == "Network.requestWillBeSent") {
      if (!t0mono && p.type == "Document" && p.request.url == url) { t0mono = p.timestamp; t0wall = p.wallTime; }
      // The same request can be announced again (a redirect, or a frame's navigation to its own session): the first counts.
      if (!requests.has(key(p.requestId))) requests.set(key(p.requestId), { url: p.request.url, start: p.timestamp, bytes: 0, type: p.type });
    } else if (d.method == "Network.responseReceived") {
      const r = requests.get(key(p.requestId));
      if (r) {
        r.status = p.response.status;
        const h = p.response.headers ?? {};
        r.timing = h["server-timing"] ?? h["Server-Timing"];
        const t = p.response.timing;
        if (t) r.ttfb = t.requestTime + t.receiveHeadersEnd / 1000;
      }
    } else if (d.method == "Network.loadingFinished") {
      const r = requests.get(key(p.requestId));
      if (r) { r.end = p.timestamp; r.bytes = p.encodedDataLength; }
    } else if (d.method == "Network.webSocketCreated") {
      requests.set(key(p.requestId), { url: p.url, start: 0, bytes: 0, type: "WebSocket" });
    } else if (d.method == "Network.webSocketWillSendHandshakeRequest") {
      const r = requests.get(key(p.requestId)); if (r) r.start = p.timestamp;
    } else if (d.method == "Network.webSocketHandshakeResponseReceived") {
      const r = requests.get(key(p.requestId)); if (r) { r.end = p.timestamp; r.status = p.response.status; }
    } else if (d.method == "Page.frameNavigated") {
      frames.set(p.frame.id, p.frame.url);
    } else if (d.method == "Page.lifecycleEvent") {
      paints.push({ frame: p.frameId, name: p.name, mono: p.timestamp });
    } else if (d.method == "Page.loadEventFired" && !d.sessionId) {
      loadMono = p.timestamp;
    } else if (d.method == "PerformanceTimeline.timelineEventAdded" && p.event.type == "largest-contentful-paint") {
      lcps.push({ frame: p.event.frameId, wall: p.event.time });
    }
  };
  await setUp();
  await page.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await page.send("Emulation.setDeviceMetricsOverride", { width: profile.width, height: profile.height, deviceScaleFactor: profile.scale, mobile: profile.mobile });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: READY_PROBE });

  let actWall = 0;
  if (opts.act) {
    actWall = Date.now() / 1000;
    t0mono = (await page.eval<number>("performance.now() + performance.timeOrigin")) / 1000; // replaced below by wall time
    await opts.act(page);
  } else {
    await page.send("Page.navigate", { url });
  }
  // Everything has settled: the load event, the editor if wanted, then no request for half a second.
  const deadline = Date.now() + 60_000;
  // Every request done (one still going after 10s, a long poll or a stream, doesn't count).
  const settled = () => [...requests.values()].every((r) => r.end != null || r.type == "WebSocket" || Date.now() - deadline > -50_000);
  let quietSince = 0;
  while (Date.now() < deadline) {
    await Bun.sleep(50);
    const loaded = opts.act ? true : loadMono > 0;
    const ready = !opts.editable || (await page.eval<number | null>("window.__benchReady ?? null").catch(() => null)) != null;
    if (loaded && ready && settled()) { quietSince ||= Date.now(); if (Date.now() - quietSince > 500) break; }
    else quietSince = 0;
  }
  page.onAny = null;
  for (const s of sessions) if (s) page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, 5_000, s).catch(() => {});

  const readyWall = opts.editable ? await page.eval<number | null>("window.__benchReady ?? null") : null;
  // The clocks: CDP's monotonic seconds for requests and paints, wall seconds for LCP and the probe.
  if (opts.act) { t0wall = actWall; t0mono = 0; }
  const docFrames = [...frames].filter(([, u]) => /\/t\/[^/]+\/doc\//.test(u)).map(([id]) => id);
  const top = [...frames].find(([, u]) => u.startsWith(root!) && !/\/t\//.test(u))?.[0];
  const sinceMono = (m: number) => Math.round((m - t0mono) * 1000);
  const sinceWall = (w: number) => Math.round((w - t0wall) * 1000);
  const first = (frameIds: (string | undefined)[], name: string) => {
    const hits = paints.filter((p) => frameIds.includes(p.frame) && p.name == name).map((p) => p.mono);
    return hits.length ? Math.min(...hits) : NaN;
  };
  const reqs = [...requests.values()].filter((r) => !opts.act || r.start >= 0);
  const topDoc = reqs.find((r) => r.type == "Document");
  // This navigation's (enabling the timeline again replays earlier ones), the document's frames' and the shell's.
  const lcpWall = Math.max(...lcps.filter((l) => l.wall >= t0wall && (docFrames.includes(l.frame) || l.frame == top)).map((l) => l.wall), 0);
  const run: Run = {
    ttfb: opts.act ? NaN : topDoc?.ttfb ? sinceMono(topDoc.ttfb) : NaN,
    fcp: opts.act ? NaN : sinceMono(first([top], "firstContentfulPaint")),
    // The homepage, served directly, has no frame: the document is the page itself.
    visible: opts.act ? NaN : sinceMono(first(docFrames.length ? docFrames : [top], "firstContentfulPaint")),
    lcp: opts.act || !lcpWall ? NaN : sinceWall(lcpWall),
    load: opts.act ? NaN : sinceMono(loadMono),
    editable: readyWall != null ? sinceWall(readyWall / 1000) : null,
    reqs: reqs.length,
    kB: Math.round(reqs.reduce((n, r) => n + r.bytes, 0) / 102.4) / 10,
    requests: reqs.map((r) => ({ ...r, start: opts.act ? 0 : sinceMono(r.start), end: r.end != null && !opts.act ? sinceMono(r.end) : undefined })),
  };
  return run;
}

/** Records, in the shell, when the editor says it's ready (main.ts calls ergaShell.ready; front.ts marks the body). */
const READY_PROBE = `(() => {
  if (window.top != window) return;
  const watch = () => {
    const check = () => { if (window.__benchReady == null && document.body.classList.contains("erga-editor-ready")) window.__benchReady = Date.now(); };
    new MutationObserver(check).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    check();
  };
  if (document.body) watch(); else document.addEventListener("DOMContentLoaded", watch);
})();`;

// ---------------------------------------------------------------- the cases

interface Case { name: string; run: (browser: Browser, profile: Profile) => Promise<{ cold: Run; warm: Run }> }

/** A page in a fresh profile (nothing cached, no storage), loaded cold and then again warm. */
async function coldWarm(browser: Browser, profile: Profile, url: string, editable: boolean) {
  const context = await browser.context();
  const page = await browser.page(context);
  await page.send("Runtime.enable");
  try {
    const cold = await measure(page, url, profile, { editable });
    const warm = await measure(page, url, profile, { editable });
    return { cold, warm };
  } finally { page.close(); }
}

/**
 * The homepage's first deploy done (the first / starts it, worker/home.ts), so / is served from it, as it is on erga.dev but
 * for a moment after a new homepage: up to 20s, then it's measured as it is.
 */
let deployed: Promise<void> | null = null;
const homeDeployed = () => deployed ??= (async () => {
  for (let i = 0; i < 200; i++) {
    if ((await (await fetch(`${root}/`)).text()).includes("<erga-controls")) return;
    await Bun.sleep(100);
  }
})();

const CASES: Case[] = [
  { name: "front", run: async (b, p) => { await homeDeployed(); return coldWarm(b, p, `${root}/`, false); } },
  { name: "viewer", run: async (b, p) => coldWarm(b, p, `${root}${await makeDoc()}`, false) },
  { name: "editor", run: async (b, p) => coldWarm(b, p, `${root}${await makeDoc()}/edit`, true) },
  {
    name: "switch", run: async (browser, profile) => {
      // The viewer, then the pencil: cold (the editor's files fetched while idle, or not yet) and warm (back out and in again).
      const address = await makeDoc();
      const context = await browser.context();
      const page = await browser.page(context);
      await page.send("Runtime.enable");
      try {
        await measure(page, `${root}${address}`, profile);
        await Bun.sleep(1500); // the idle prefetch, as someone reading first would give it
        const pencil = async (p: Page) => { await p.eval(`window.__benchReady = undefined; document.body.classList.remove("erga-editor-ready"); document.querySelector(".erga-edit-button").click(); true`); };
        const cold = await measure(page, null, profile, { editable: true, act: pencil });
        await page.eval(`document.querySelector("#btn-edit")?.click(); true`);
        await Bun.sleep(800);
        const warm = await measure(page, null, profile, { editable: true, act: pencil });
        return { cold, warm };
      } finally { page.close(); }
    },
  },
];

// ---------------------------------------------------------------- run

const median = (xs: number[]) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : NaN; };
const METRICS = ["ttfb", "fcp", "visible", "lcp", "load", "editable", "reqs", "kB"] as const;
const all: Record<string, Run[]> = {};
// Once, so the dev server has transformed the Worker's modules and the landing document is made: not part of any run.
await fetch(`${root}/`).then((r) => r.text());
await makeDoc();

const browser = await Browser.launch();
try {
  for (const profileName of PROFILES) {
    const profile = PROFILE[profileName];
    for (const c of CASES) {
      if (ONLY && !c.name.includes(ONLY)) continue;
      for (let i = 0; i < RUNS; i++) {
        const { cold, warm } = await c.run(browser, profile);
        (all[`${profileName} ${c.name} cold`] ??= []).push(cold);
        (all[`${profileName} ${c.name} warm`] ??= []).push(warm);
      }
    }
  }
} finally {
  browser.close();
  await host?.dispose();
  stopPreview?.();
}

const pad = (s: string, n: number) => s.padStart(n);
console.log(`\n${root}  ${host ? "dev server (vite dev)" : args.includes("--prod") ? "production build (vite build + vite preview)" : "given server"}  medians of ${RUNS}${LATENCY ? `  ${LATENCY}ms to the database and documents` : ""}\n`);
console.log(pad("", 22) + METRICS.map((m) => pad(m, 9)).join(""));
for (const [name, runs] of Object.entries(all)) {
  console.log(name.padEnd(22) + METRICS.map((m) => {
    const v = median(runs.map((r) => (r[m] ?? NaN) as number));
    return pad(Number.isFinite(v) ? String(v) : "-", 9);
  }).join(""));
}
if (WATERFALL) {
  for (const [name, runs] of Object.entries(all)) {
    console.log(`\n${name} (last run):`);
    for (const r of runs.at(-1)!.requests.sort((a, b) => a.start - b.start)) {
      const short = r.url.replace(/\/t\/[^/]+\//, "/t/…/").replace(/^https?:\/\//, "").slice(0, 80);
      console.log(`  ${pad(String(r.start), 6)} → ${pad(r.end != null ? String(r.end) : "", 6)}  ${pad(String(r.status ?? ""), 3)} ${pad((r.bytes / 1024).toFixed(1), 7)}kB  ${short}${r.timing ? `   [${r.timing}]` : ""}`);
    }
  }
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ root, runs: RUNS, results: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.map(({ requests, ...rest }) => rest)])) }, null, 2));
process.exit(0);
