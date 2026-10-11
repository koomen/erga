// Live reload for local development (`bun start --reload`: AGENTS.md, working
// locally): every page the server sends a browser tab gets a small
// script that listens on /__erga/reload and reloads the tab when
//
//   - the editor's own files are rebuilt,
//   - the Worker's code changes (Vite reloads it; the next request runs the new code),
//   - or the dev server restarts (Vite does when its config, or a file it imports, changes;
//     or `bun start` was stopped and run again): the tab reconnects, sees a new server and reloads.
//
// Only top-level pages get the script, never a document's own frame (its
// HTML is the document's), and nothing is injected without --reload.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";

const PATH = "/__erga/reload";

/**
 * The script: reloads when told to, or when it reconnects to a server that isn't the one it first met; either way
 * only once the page answers, so a server still coming back never leaves the tab on an error page.
 */
const script = (boot: string) => `<script>(()=>{let seen,going;` +
  `const go=async()=>{if(going)return;going=true;for(let i=0;i<240;i++){try{const r=await fetch(location.href,{cache:"no-store"});if(r.status<500)break}catch{}await new Promise((f)=>setTimeout(f,250))}location.reload()};` +
  `const es=new EventSource(${JSON.stringify(PATH)});` +
  `es.addEventListener("hello",(e)=>{if(seen&&seen!==e.data)go();seen=e.data});` +
  `es.addEventListener("reload",go)})()/*erga live reload ${boot}*/</script>`;

export interface LiveReload {
  /** Tells every open tab to reload (debounced: a burst of changes is one reload). */
  reload(why: string): void;
  /** The server is about to restart: no more reloads from this one (the tabs reload when they reconnect to the next). */
  restarting(): void;
  stop(): void;
}

export function liveReload(server: ViteDevServer, log: (line: string) => void): LiveReload {
  const boot = Date.now().toString(36);
  const tabs = new Set<ServerResponse>();
  let timer: ReturnType<typeof setTimeout> | undefined, quiet = false;
  const beat = setInterval(() => { for (const t of tabs) t.write(": beat\n\n"); }, 15000);
  beat.unref?.();

  server.middlewares.use((req, res, next) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path == PATH && req.method == "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`retry: 500\nevent: hello\ndata: ${boot}\n\n`);
      tabs.add(res);
      req.on("close", () => tabs.delete(res));
      return;
    }
    if (isTopLevelPage(req)) inject(res, script(boot));
    next();
  });

  return {
    reload(why) {
      clearTimeout(timer);
      if (quiet) return;
      timer = setTimeout(() => {
        if (tabs.size) log(`${why}: reloading ${tabs.size} tab${tabs.size == 1 ? "" : "s"}`);
        for (const t of tabs) t.write("event: reload\ndata: 1\n\n");
      }, 150);
    },
    restarting() {
      quiet = true;
      clearTimeout(timer);
    },
    stop() {
      quiet = true;
      clearTimeout(timer);
      clearInterval(beat);
      for (const t of tabs) t.end();
      tabs.clear();
    },
  };
}

/** A browser loading a page into a tab (not a frame, a fetch or a script). */
export function isTopLevelPage(req: IncomingMessage): boolean {
  if (req.method != "GET") return false;
  const dest = req.headers["sec-fetch-dest"];
  return dest ? dest == "document" : /text\/html/.test(req.headers.accept ?? "");
}

/** Adds `tag` to the end of the response, if it turns out to be uncompressed HTML. */
export function inject(res: ServerResponse, tag: string) {
  const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => ServerResponse;
  const end = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
  let html = false;
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    // Headers given here never reach getHeader: set them first, so they can be looked at (and Content-Length dropped).
    const headers = rest.find((r) => r && typeof r == "object") as Record<string, unknown> | unknown[] | undefined;
    const message = rest.find((r) => typeof r == "string") as string | undefined;
    if (Array.isArray(headers)) {
      if (Array.isArray(headers[0])) for (const [k, v] of headers as [string, string][]) res.appendHeader(k, v);
      else for (let i = 0; i < headers.length; i += 2) res.appendHeader(String(headers[i]), String(headers[i + 1]));
    } else if (headers) for (const [k, v] of Object.entries(headers)) if (v !== undefined) res.setHeader(k, v as string);
    html = status == 200 && /text\/html/.test(String(res.getHeader("content-type") ?? "")) && !res.getHeader("content-encoding");
    if (html) res.removeHeader("content-length");
    return message ? writeHead(status, message) : writeHead(status);
  }) as typeof res.writeHead;
  res.end = ((...args: unknown[]) => {
    if (!res.headersSent) res.writeHead(res.statusCode);
    if (!html) return end(...args);
    const [chunk, a, b] = args;
    const encoding = typeof a == "string" ? (a as BufferEncoding) : undefined;
    const done = [chunk, a, b].find((f) => typeof f == "function");
    if (chunk != null && typeof chunk != "function") encoding ? res.write(chunk as string, encoding) : res.write(chunk as string);
    return done ? end(tag, done) : end(tag);
  }) as typeof res.end;
}
