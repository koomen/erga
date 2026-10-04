// A stand-in for the versions and homepage backends (tasks #33 and #34), so
// the document settings popover (src/page/settings.ts) can be built and
// tested before they land. Local development only, and only with
// ERGA_STUB_SETTINGS=1 (vite.config.ts): never in the Worker. It answers the
// shared contract's routes before the Worker does, keeps its state in memory
// (and in the state directory, so a restart keeps it), and sends the
// contract's events ({ type: "versions" }, { type: "home" }) to every open
// editor tab by adding them to the tab's /api/events WebSocket (a small
// script it adds to top-level pages). Delete this file and its line in
// vite.config.ts once both backends are in.
//
//   GET  /api/docs/<id>/versions[?before=<versionId>&limit=<n>]
//   POST /api/docs/<id>/publish        { mode: "latest" } | { mode: "manual", versionId }
//   GET  /api/docs/<id>/home
//   POST /api/docs/<id>/home           { isHome }
//   POST /api/docs/<id>/home/deploy
//
// And its own controls, for tests and previews:
//
//   POST /__erga/stub/settings  { doc, versions?: n, published?: n | "latest", canEdit?, admin?, isHome?,
//                                 deploy?: {...}, failNext?, deployMs?, scheduleMs?, describeMs?, error?: string,
//                                 cut?: n (cut n new versions now, described after describeMs) }

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Plugin } from "vite";
import { inject, isTopLevelPage } from "./reload.ts";

interface Version { id: string; n: number; at: string; authors: string[]; description: string | null }
interface Deploy { state: "idle" | "scheduled" | "deploying" | "deployed" | "failed"; at: string | null; scheduledFor: string | null; version: number | null; error: string | null }
interface Doc {
  versions: Version[]; // oldest first
  mode: "latest" | "manual";
  publishedId: string;
  canEdit: boolean;
  admin: boolean;
  isHome: boolean;
  deploy: Deploy;
  failNext: boolean;
  deployMs: number;
  scheduleMs: number;
  describeMs: number;
  /** Every route answers this, with a 500, while it's set. */
  error: string | null;
}

const WORDS = [
  "Tightened the opening paragraph wording", "Added pricing table and notes", "Fixed typos throughout the intro",
  "Rewrote the call to action", "New section on team history", "Swapped hero image for illustration",
  "Shortened the FAQ answers considerably", "Moved testimonials above the fold", "Agent restyled headings and spacing",
  "Linked the changelog from footer", "Clarified refund policy language", "Removed outdated launch announcement",
];
const AUTHORS = [["tester"], ["tester", "agent"], ["agent"], ["tester"], ["ada"], ["tester", "ada"]];

export function settingsStub(stateDir: string): Plugin {
  const file = join(stateDir, "settings-stub.json");
  const docs = new Map<string, Doc>(existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, Doc>) : []);
  const save = () => { try { writeFileSync(file, JSON.stringify(Object.fromEntries(docs))); } catch {} };
  const tabs = new Set<ServerResponse>();
  const send = (type: "versions" | "home") => { for (const t of tabs) t.write(`data: ${JSON.stringify({ type })}\n\n`); };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const versionAt = (n: number, ago: number, described = true): Version => ({
    id: `v${n}-${Math.random().toString(36).slice(2, 8)}`, n, at: new Date(Date.now() - ago).toISOString(),
    authors: AUTHORS[n % AUTHORS.length], description: described ? WORDS[n % WORDS.length] : null,
  });
  function seed(count: number): Version[] {
    // Older versions further apart: minutes for the latest, days for the first.
    return Array.from({ length: count }, (_, i) => versionAt(i + 1, Math.round((count - i) ** 2.2 * 60_000)));
  }
  function doc(id: string): Doc {
    let d = docs.get(id);
    if (!d) {
      const versions = seed(Number(process.env.ERGA_STUB_VERSIONS || 6));
      d = {
        versions, mode: "latest", publishedId: versions.at(-1)!.id, canEdit: true, admin: true, isHome: false,
        deploy: { state: "idle", at: null, scheduledFor: null, version: null, error: null },
        failNext: false, deployMs: 2500, scheduleMs: 5 * 60_000, describeMs: 1500, error: null,
      };
      docs.set(id, d);
    }
    return d;
  }
  const current = (d: Doc) => d.versions.at(-1)!;
  const published = (d: Doc) => (d.mode == "latest" ? current(d) : d.versions.find((v) => v.id == d.publishedId) ?? current(d));
  const later = (key: string, ms: number, f: () => void) => { clearTimeout(timers.get(key)); timers.set(key, setTimeout(() => { timers.delete(key); f(); save(); }, ms)); };

  function deployNow(id: string, d: Doc) {
    d.deploy = { ...d.deploy, state: "deploying", scheduledFor: null, error: null };
    send("home");
    later(`deploy:${id}`, d.deployMs, () => {
      if (d.failNext) { d.failNext = false; d.deploy = { ...d.deploy, state: "failed", error: "Cloudflare answered 500 while uploading the files. Try again." }; }
      else d.deploy = { state: "deployed", at: new Date().toISOString(), scheduledFor: null, version: published(d).n, error: null };
      send("home");
    });
  }
  /** A new published version on the homepage: deployed a while later. */
  function schedule(id: string, d: Doc) {
    if (!d.isHome) return;
    d.deploy = { ...d.deploy, state: "scheduled", scheduledFor: new Date(Date.now() + d.scheduleMs).toISOString(), error: null };
    send("home");
    later(`deploy:${id}`, d.scheduleMs, () => deployNow(id, d));
  }
  function cut(id: string, d: Doc, count: number) {
    const was = published(d).id;
    for (let i = 0; i < count; i++) d.versions.push(versionAt(current(d).n + 1, 0, false));
    send("versions");
    later(`describe:${id}`, d.describeMs, () => { for (const v of d.versions) v.description ??= WORDS[v.n % WORDS.length]; send("versions"); });
    if (published(d).id != was) schedule(id, d);
  }

  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  const body = (req: IncomingMessage) => new Promise<any>((resolve) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } }); });
  const home = (d: Doc) => ({ isHome: d.isHome, canSet: d.admin && d.deploy.state != "deploying", deploy: d.deploy });

  return {
    name: "erga:settings-stub",
    apply: "serve",
    configureServer(server) {
      server.config.logger.info("settings stub: answering /api/docs/<id>/versions, /publish and /home (ERGA_STUB_SETTINGS)", { timestamp: true });
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname == "/__erga/stub/events") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
          res.write("retry: 500\n\n");
          tabs.add(res);
          req.on("close", () => tabs.delete(res));
          return;
        }
        if (url.pathname == "/__erga/stub/settings" && req.method == "POST") {
          return void body(req).then((b) => {
            const d = doc(String(b.doc));
            if (b.versions) { d.versions = seed(Number(b.versions)); d.publishedId = current(d).id; }
            if (b.published == "latest") d.mode = "latest";
            else if (typeof b.published == "number") { d.mode = "manual"; d.publishedId = d.versions.find((v) => v.n == b.published)!.id; }
            for (const k of ["canEdit", "admin", "isHome", "failNext", "deployMs", "scheduleMs", "describeMs", "error"] as const) if (k in b) (d as any)[k] = b[k];
            if (b.deploy) d.deploy = { ...d.deploy, ...b.deploy };
            if (b.cut) cut(String(b.doc), d, Number(b.cut));
            save();
            send("versions"); send("home");
            json(res, 200, { ok: true, current: current(d).n, published: published(d).n });
          });
        }
        // Pages get the script that adds the stub's events to their /api/events socket.
        if (isTopLevelPage(req)) inject(res, `<script>(()=>{const s=new Set(),W=window.WebSocket;window.WebSocket=class extends W{constructor(u,p){super(u,p);if(String(u).includes("/api/events")){s.add(this);this.addEventListener("close",()=>s.delete(this))}}};new EventSource("/__erga/stub/events").onmessage=(e)=>{for(const w of s)w.dispatchEvent(new MessageEvent("message",{data:e.data}))}})()/*erga settings stub*/</script>`);
        const m = /^\/api\/docs\/([^/]+)\/(versions|publish|home|home\/deploy)$/.exec(url.pathname);
        if (!m) return next();
        const [, id, what] = m;
        const d = doc(id);
        if (d.error) return json(res, 500, { error: d.error });
        if (what == "versions" && req.method == "GET") {
          const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 10)));
          const before = url.searchParams.get("before");
          const from = before ? d.versions.find((v) => v.id == before)?.n : current(d).n + 1;
          if (from == null) return json(res, 404, { error: "There's no such version." });
          const versions = d.versions.filter((v) => v.n < from).reverse().slice(0, limit);
          return json(res, 200, { current: current(d), published: { mode: d.mode, version: published(d) }, versions, total: d.versions.length, canEdit: d.canEdit });
        }
        if (what == "publish" && req.method == "POST") {
          return void body(req).then((b) => {
            if (!d.canEdit) return json(res, 403, { error: "Only the document's editors can change what's published." });
            const was = published(d).id;
            if (b.mode == "latest") d.mode = "latest";
            else if (b.mode == "manual" && d.versions.some((v) => v.id == b.versionId)) { d.mode = "manual"; d.publishedId = b.versionId; }
            else return json(res, 400, { error: "That version isn't one of this document's." });
            save();
            send("versions");
            if (published(d).id != was) schedule(id, d);
            json(res, 200, { published: { mode: d.mode, version: published(d) } });
          });
        }
        if (what == "home" && req.method == "GET") return json(res, 200, home(d));
        if (what == "home" && req.method == "POST") {
          return void body(req).then((b) => {
            if (!home(d).canSet) return json(res, 403, { error: d.admin ? "The homepage can't change while it's deploying." : "Only admins can choose the homepage." });
            // One homepage: setting this one clears any other.
            if (b.isHome) for (const o of docs.values()) o.isHome = false;
            d.isHome = !!b.isHome;
            if (d.isHome) deployNow(id, d);
            else send("home");
            save();
            json(res, 200, home(d));
          });
        }
        if (what == "home/deploy" && req.method == "POST") {
          if (!d.admin) return json(res, 403, { error: "Only admins can redeploy the homepage." });
          if (!d.isHome) return json(res, 400, { error: "This document isn't the homepage." });
          deployNow(id, d);
          save();
          return json(res, 200, home(d));
        }
        json(res, 405, { error: "Not allowed." });
      });
    },
  };
}
