// Local development's side of the dev server (vite.config.ts): what the
// Worker can't do from inside workerd because it needs this machine.
//
//   - Files on disk as documents. A file or folder (named to `bun start`,
//     or opened from /docs) is linked to a document of its own, at an
//     address that comes from its path, so it's the same every time. A
//     Mirror then serves the document its files over the document's
//     /api/mirror WebSocket (worker/disk.ts): the room lists, reads and
//     writes them there, as it would a folder of its own, and hears about
//     every change made on disk, which it merges in as an edit. A single
//     file is linked on its own: only it is synced, and the document can't
//     make others. The links are kept in the state directory
//     (erga-links.json), so they come back after a restart.
//   - The editor's own files: page.js and frame.js are built by bun
//     (build.sh) and served from .site/, so a change to src/page/,
//     page.html, style.css or fonts/ runs site.sh again.
//
// Its routes, before the Worker's:
//
//   POST /__erga/open    path=<file or folder>: links it for whoever's signed in and goes to it
//   POST /__erga/flush   ?link=<secret>: every linked document writes what it holds to disk now (dev.ts, before stopping)

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { ALPHABET } from "../front.ts";
import { ignored } from "../src/room/doc.ts";
import type { FromDisk, ToDisk } from "./mirror.ts";

const EDITOR = resolve(import.meta.dirname, "..");
/** The largest file a document on disk takes: the room reads each whole when it opens, over a WebSocket. */
const MAX_FILE = 10_000_000;

/** A file or folder on disk, linked to one of `owner`'s documents (at /<owner>/<slug>). */
interface Link { owner: string; id: string; slug: string; folder: string; index: string; only: boolean }

export interface DevOptions {
  /** The Worker's local state (Durable Objects' storage), where the links are kept too. */
  stateDir: string;
  /** What the Worker knows the dev server by (ERGA_LINK_SECRET). */
  secret: string;
  /** A file or folder to open on start (dev.ts passes what `bun start` was given). */
  open?: string;
  /** Open it in the browser too. */
  browser?: boolean;
  /** Where relative paths start from: where `bun start` was run. */
  cwd: string;
}

export function ergaDev(opts: DevOptions): Plugin {
  return {
    name: "erga:dev",
    apply: "serve",
    configureServer(server) {
      const log = (line: string) => server.config.logger.info(line, { timestamp: true });
      const linksFile = join(opts.stateDir, "erga-links.json");
      const mirrors = new Map<string, Mirror>();
      // Where the Worker answers (for us), and the address people use.
      let base = "", shown = "";

      const saveLinks = async () => {
        await mkdir(opts.stateDir, { recursive: true });
        await writeAtomic(linksFile, JSON.stringify([...mirrors.values()].map((m) => m.link), null, 2) + "\n");
      };

      /** Links a file or folder (made into a document if need be) and keeps it in sync; resolves once the document has its files. */
      const link = async (target: Resolved, as: { owner?: string; headers?: Record<string, string>; user?: string | null }): Promise<Link> => {
        const query = new URLSearchParams({ link: opts.secret, ...(as.user ? { user: as.user } : {}) });
        const r = await fetch(`${base}/__erga/link?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...as.headers },
          body: JSON.stringify({ id: target.id, index: target.index, path: target.shown, slug: target.slug, only: target.only, owner: as.owner }),
        });
        if (!r.ok) throw new Error(`linking ${target.shown}: ${r.status} ${await r.text()}`);
        const { owner, id, slug } = await r.json() as { owner: string; id: string; slug: string };
        const l: Link = { owner, id, slug, folder: target.folder, index: target.index, only: target.only };
        const key = id;
        if (!mirrors.has(key)) {
          const m = new Mirror(l, base, opts.secret, log, () => { mirrors.delete(key); saveLinks().catch(() => {}); });
          mirrors.set(key, m);
          await Promise.race([m.start(), new Promise((_, reject) => setTimeout(() => reject(new Error(`${target.shown}: the document didn't answer`)), 20_000))]);
          await saveLinks();
        }
        return l;
      };

      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method == "POST" && url.pathname == "/__erga/open") return void open(req, res, url).catch(next);
        if (req.method == "POST" && url.pathname == "/__erga/flush" && url.searchParams.get("link") == opts.secret) {
          return void Promise.all([...mirrors.values()].map((m) => m.flush())).then(() => res.end("ok"), next);
        }
        next();
      });

      /** The local database brought up to date (migrations/), which linking needs: set once the server's listening. */
      let migrated: Promise<void> | null = null;

      /** /__erga/open: the form on /docs (or a test) links a path for the person asking, then goes there. */
      async function open(req: IncomingMessage, res: ServerResponse, url: URL) {
        // Only this site's own pages (and clients that aren't browsers, which send no Origin).
        const origin = req.headers.origin;
        if (origin && origin != `http://${req.headers.host}`) return reply(res, 403, "Forbidden");
        const body = await readBody(req);
        const asked = (req.headers["content-type"]?.includes("json") ? (JSON.parse(body) as { path?: string }).path : new URLSearchParams(body).get("path"))?.trim();
        const user = url.searchParams.get("user");
        let target: Resolved;
        try { target = await resolveTarget(asked ?? "", opts.cwd); } catch (e) {
          return reply(res, 400, (e as Error).message, user);
        }
        const headers: Record<string, string> = req.headers.cookie ? { Cookie: req.headers.cookie } : {};
        // Asked for as soon as the server answers (a test): not before the database has its tables.
        while (!migrated) await new Promise((r) => setTimeout(r, 20));
        await migrated;
        const l = await link(target, { headers, user });
        log(`opened ${target.shown}: ${shown}/${l.owner}/${l.slug}`);
        res.writeHead(303, { Location: `/${l.owner}/${l.slug}${user ? `?user=${encodeURIComponent(user)}` : ""}` }).end();
      }

      server.httpServer?.once("listening", () => {
        const port = (server.httpServer!.address() as AddressInfo).port;
        base = `http://127.0.0.1:${port}`;
        shown = `http://localhost:${port}`;
        migrated = (async () => {
          await workerReady(base);
          // The directory's tables, in the local D1, before anything is linked into it.
          const r = await fetch(`${base}/__erga/migrate?link=${opts.secret}`, { method: "POST" });
          if (!r.ok) throw new Error(`migrating the local database: ${r.status} ${await r.text()}`);
        })();
        (async () => {
          await migrated;
          // Last run's links first, then whatever `bun start` was given.
          const kept = await readFile(linksFile, "utf8").then((t) => JSON.parse(t) as Link[], () => []);
          for (const l of kept) {
            const target = await resolveTarget(l.only ? join(l.folder, l.index) : l.folder, opts.cwd).catch(() => null);
            if (!target) { log(`not linking ${l.folder}: it's gone`); continue; }
            await link(target, { owner: l.owner }).catch((e) => log((e as Error).message));
          }
          if (opts.open) {
            const target = await resolveTarget(opts.open, opts.cwd);
            const l = await link(target, {});
            const at = `${shown}/${l.owner}/${l.slug}`;
            log(`editing ${target.shown}${target.only ? "" : ` (${target.index})`}: ${at}`);
            if (opts.browser) openBrowser(at);
          } else if (opts.browser) openBrowser(`${shown}/docs`);
        })().catch((e) => log(`couldn't link: ${(e as Error).message}`));
      });

      const unwatch = process.env.ERGA_BUILT ? () => {} : watchEditor(log);
      // Started by dev.ts in a process group of its own: if dev.ts is gone (killed outright), so is this.
      const parent = Number(process.env.ERGA_PARENT);
      if (parent) setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(1); } }, 1000).unref();
      // Closed (stopping, or Vite restarting it when its config changes): nothing of this one stays behind.
      server.httpServer?.once("close", () => { unwatch(); for (const m of mirrors.values()) m.stop(); });
    },
  };
}

// ------------------------------------------------------------ the target

/** A file or folder to link, resolved. */
interface Resolved {
  /** The folder the document's files are in. */
  folder: string;
  /** The page, inside it. */
  index: string;
  /** Just that one file, not the folder. */
  only: boolean;
  /** The document's id: from its real path, so it's the same however it's named. */
  id: string;
  /** Its address: the folder's name, or the file's without its extension. */
  slug: string;
  /** Its path as /docs shows it (~ for your home). */
  shown: string;
}

/** A file (an .html or .md page, on its own) or a folder with an index.html or index.md. */
export async function resolveTarget(asked: string, cwd: string): Promise<Resolved> {
  if (!asked) throw new Error("Name a file or folder.");
  const expanded = asked == "~" || asked.startsWith("~/") ? join(homedir(), asked.slice(1)) : asked;
  const abs = await realpath(resolve(cwd, expanded)).catch(() => { throw new Error(`${asked}: not found`); });
  const info = await stat(abs);
  let folder = abs, index: string | undefined, only = false;
  if (info.isDirectory()) {
    for (const name of ["index.html", "index.htm", "index.md"]) {
      if (await stat(join(abs, name)).then((s) => s.isFile(), () => false)) { index = name; break; }
    }
    if (!index) throw new Error(`${asked}: no index.html or index.md here`);
  } else {
    if (![".html", ".htm", ".md"].includes(extname(abs).toLowerCase())) throw new Error(`${asked}: open an .html or .md file, or a folder with an index`);
    folder = dirname(abs);
    index = basename(abs);
    only = true;
  }
  const hash = createHash("sha1").update(only ? abs : abs + sep).digest();
  const id = Array.from(hash.subarray(0, 8), (b) => ALPHABET[b % ALPHABET.length]).join("");
  const home = homedir();
  const shown = abs == home || abs.startsWith(home + sep) ? "~" + abs.slice(home.length) : abs;
  const slug = only ? basename(abs).replace(/\.[^.]+$/, "") : basename(abs);
  return { folder, index, only, id, slug, shown };
}

// ------------------------------------------------------------ the mirror

/**
 * One linked document's files on disk: the document's room asks for them
 * (list, read, write) and is told when one changes. Reconnects if the
 * socket drops, until the link goes (the document deleted, or the server stopping).
 */
class Mirror {
  private ws: WebSocket | null = null;
  private watcher: FSWatcher | null = null;
  /** What disk holds of each file, as this last read or wrote it: a change the watcher reports that matches is our own write. */
  private disk = new Map<string, string>();
  private changed = new Set<string>();
  /** Every file to be looked at, not just those named. */
  private rescan = false;
  /** Each file's modification time and size when last polled. */
  private stamps = new Map<string, string>();
  private poller: ReturnType<typeof setInterval> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushed: (() => void) | null = null;
  private stopped = false;

  constructor(readonly link: Link, private base: string, private secret: string, private log: (line: string) => void, private gone: () => void) {}

  /** Watches the files and connects; resolves once the document has the connection. */
  async start(): Promise<void> {
    this.watch();
    await this.poll(true);
    // The watcher can miss a change (one made just as it starts, or on a busy machine): a look every second catches those.
    this.poller = setInterval(() => { this.poll(false).catch(() => {}); }, 1000);
    return this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.poller);
    clearTimeout(this.timer);
    this.watcher?.close();
    this.ws?.close();
  }

  /** Asks the document to write what it holds now, and waits until it has (or a few seconds). */
  flush(): Promise<void> {
    if (this.ws?.readyState != WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      this.flushed = () => { clearTimeout(timer); resolve(); };
      this.send({ t: "flush" });
    });
  }

  private connect(): Promise<void> {
    const ws = this.ws = new WebSocket(`${this.base.replace(/^http/, "ws")}/__erga/mirror/${this.link.id}?link=${this.secret}`);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ToDisk;
      if (m.t == "flushed") { this.flushed?.(); this.flushed = null; return; }
      this.answer(m).then((reply) => this.send({ t: "reply", id: m.id, ...reply }), (err: Error) => this.send({ t: "reply", id: m.id, error: err.message }));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws || this.stopped) return;
      // Deleted (from /docs): the files stay as they are, and the link goes.
      if (e.code == 4404) { this.log(`unlinked ${this.link.folder}: the document was deleted`); this.stop(); return this.gone(); }
      setTimeout(() => { if (!this.stopped) this.connect().catch(() => {}); }, 500);
    };
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("close", () => reject(new Error(`${this.link.folder}: couldn't connect to its document`)), { once: true });
    });
  }

  private send(m: FromDisk): void {
    if (this.ws?.readyState == WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** The room asks for its files: what's there, what one holds, or to write one. */
  private async answer(m: Exclude<ToDisk, { t: "flushed" }>): Promise<Partial<Extract<FromDisk, { t: "reply" }>>> {
    const { folder, only, index } = this.link;
    if (m.t == "list") {
      const paths = only ? (await stat(join(folder, index)).then((s) => s.isFile(), () => false) ? [index] : []) : await listFiles(folder);
      return { paths };
    }
    const rel = this.allowed(m.path);
    if (!rel) return m.t == "read" ? { b64: null } : { error: `${m.path} isn't one of this document's files` };
    const full = join(folder, rel);
    if (m.t == "read") {
      const bytes = await readFile(full).catch(() => null);
      if (bytes && bytes.length > MAX_FILE) { this.log(`${full}: too big to edit (over 10MB), left out`); return { b64: null }; }
      if (bytes) this.disk.set(rel, digest(bytes)); else this.disk.delete(rel);
      return { b64: bytes ? bytes.toString("base64") : null };
    }
    const bytes = new TextEncoder().encode(m.text);
    this.disk.set(rel, digest(bytes));
    await writeAtomic(full, bytes);
    return {};
  }

  /** Changes on disk, from anything (an editor, git): the document hears of each once it's settled for a moment. */
  private watch(): void {
    const { folder, only, index } = this.link;
    // A single file is watched through its folder: editors often save by replacing the file.
    this.watcher = watch(folder, { recursive: !only }, (_, name) => {
      const rel = name?.toString().split(sep).join("/");
      // A busy machine's watcher may name only a folder, or nothing: then every file is looked at.
      if (!rel) this.rescan = true;
      else if (!this.allowed(rel) || (only && rel != index)) return;
      else this.changed.add(rel);
      this.timer ??= setTimeout(() => { this.timer = undefined; this.take().catch(() => {}); }, 60);
    });
    this.watcher.on("error", (e) => this.log(`stopped watching ${folder}: ${e.message}`));
  }

  /** Files whose time or size moved since the last look go to `take` (the first look only notes them). */
  private async poll(first: boolean): Promise<void> {
    const { folder, only, index } = this.link;
    const now = new Map<string, string>();
    for (const rel of only ? [index] : await listFiles(folder).catch(() => [])) {
      const s = await stat(join(folder, rel)).catch(() => null);
      if (s?.isFile()) now.set(rel, `${s.mtimeMs}:${s.size}`);
    }
    if (!first) {
      for (const [rel, stamp] of now) if (this.stamps.get(rel) != stamp) this.changed.add(rel);
      for (const rel of this.stamps.keys()) if (!now.has(rel)) this.changed.add(rel);
    }
    this.stamps = now;
    if (this.changed.size) this.timer ??= setTimeout(() => { this.timer = undefined; this.take().catch(() => {}); }, 0);
  }

  private async take(): Promise<void> {
    const { folder, only, index } = this.link;
    const paths = new Set(this.changed);
    this.changed.clear();
    for (const rel of [...paths]) {
      // A folder: what's in it (a folder moved in, or one the watcher named for its files).
      if ((await stat(join(folder, rel)).catch(() => null))?.isDirectory()) { paths.delete(rel); this.rescan = true; }
    }
    if (this.rescan) {
      this.rescan = false;
      for (const rel of only ? [index] : await listFiles(folder).catch(() => [])) paths.add(rel);
      for (const rel of this.disk.keys()) paths.add(rel);
    }
    for (const rel of paths) {
      const full = join(folder, rel);
      const bytes = await readFile(full).catch(() => null);
      const d = bytes ? digest(bytes) : null;
      // Our own write, or nothing new.
      if ((this.disk.get(rel) ?? null) == d) continue;
      this.send({ t: "changed", path: rel });
    }
  }

  /** A path inside the linked files (the one file, for a single file), or null. */
  private allowed(path: string): string | null {
    const parts = path.split(/[\\/]/).filter((s) => s && s != ".");
    if (!parts.length || parts.includes("..")) return null;
    const rel = parts.join("/");
    if (ignored(rel) || (this.link.only && rel != this.link.index)) return null;
    return rel;
  }
}

// ------------------------------------------------------------ the editor's own files

/**
 * Rebuilds the editor's files (site.sh) when their sources change: reload
 * the page to see it. Only a real change counts (a file's time moved on):
 * watchers also report files merely touched. Returns the way to stop.
 */
function watchEditor(log: (line: string) => void): () => void {
  const SOURCES = [["src/page", true], ["fonts", true], ["page.html", false], ["style.css", false]] as const;
  /** The newest modification among the sources. */
  const newest = async () => {
    let t = 0;
    for (const [path, dir] of SOURCES) {
      const full = join(EDITOR, path);
      for (const f of dir ? (await readdir(full, { recursive: true })).map((n) => join(full, n)) : [full]) t = Math.max(t, (await stat(f).catch(() => null))?.mtimeMs ?? 0);
    }
    return t;
  };
  let seen = 0;
  newest().then((t) => { seen = t; });
  let timer: ReturnType<typeof setTimeout> | undefined, running = false, again = false;
  const build = () => {
    timer = undefined;
    if (running) { again = true; return; }
    running = true;
    const p = spawn(join(EDITOR, "site.sh"), { cwd: EDITOR, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (c) => { err += c; });
    p.on("close", (code) => {
      running = false;
      log(code == 0 ? "rebuilt the editor: reload to see it" : `the editor didn't build:\n${err}`);
      if (again) { again = false; build(); }
    });
  };
  const changed = () => {
    timer ??= setTimeout(() => newest().then((t) => { if (t > seen) { seen = t; build(); } else timer = undefined; }), 100);
  };
  const watchers = SOURCES.map(([path, recursive]) => watch(join(EDITOR, path), { recursive }, changed).on("error", () => {}));
  return () => { clearTimeout(timer); for (const w of watchers) w.close(); };
}

// ------------------------------------------------------------ helpers

/** Waits for the Worker to answer (it starts a moment after the server listens). */
async function workerReady(base: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/style.css`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function openBrowser(url: string): void {
  const cmd = process.platform == "darwin" ? "open" : process.platform == "win32" ? "explorer" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

function reply(res: ServerResponse, status: number, message: string, user?: string | null): void {
  const back = `/docs${user ? `?user=${encodeURIComponent(user)}` : ""}`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>Erga</title>
<p style="font:17px/1.6 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 16px">${message.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)} <a href="${back}">Back to your documents</a>.</p>`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 10_000) req.destroy(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** A short content hash, to tell our own writes from changes made by anything else. */
const digest = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex").slice(0, 16);

/** Every file in a folder, relative and "/"-separated, skipping what a document never holds (dotfiles, node_modules). */
async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (ignored(path)) continue;
    if (e.isDirectory()) out.push(...(await listFiles(root, path)));
    else if (e.isFile() || (e.isSymbolicLink() && (await stat(join(root, path)).then((s) => s.isFile(), () => false)))) out.push(path);
  }
  return out;
}

let writes = 0;
/** Writes a file whole or not at all (a temporary dotfile renamed over it), making its folder if need be. */
async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.erga-${process.pid}-${++writes}.tmp`);
  await writeFile(tmp, data);
  await rename(tmp, file);
}
