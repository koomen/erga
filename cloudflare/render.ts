// view_page and eval_in_page, rendered by the server's browser (cloudflare/browser.ts): it opens the page in Erga's
// real viewer, as its person does, at the document's address (/d/<id>/<page>, ?edit for the editor): the viewer on the
// app's origin, the bars as the document's settings give them, and the page in its frame on the document's pages
// origin; in a browser context of the person's own (cloudflare/browser.ts). In the frame,
// client/page-tools/capture.ts waits for its fonts, shows a step and holds its animations; the browser takes each
// picture itself, of the whole window.
//
// The browser asks the network nothing of Erga's. Each request is paused before it goes out (CDP's Fetch domain), in
// every target of the page (the window, a frame of another site), and one for an address of Erga's own (the app's
// origin, a host of the documents' domain) is answered here, in process, by the app itself (`erga`:
// cloudflare/app.ts). A page's WebSocket to such an address is answered here too (render-sockets.ts). So the gate is
// never asked, wherever it runs: a gate in front of the server lets in only a browser that signed in, which this one
// never did, and it needs nothing new for this one. Who asks:
//
//   - the viewer's own page (a page of the app's, in the window's main frame), of the app's origin: the agent's
//     person, on this one document, with no admin power (server/identity/admit.ts, viewRequest);
//   - anything else (the document's page and its frames, a worker), of either: nobody. The document's files need
//     nobody: the pass in their address opens them, and the app checks it, and the document's share count, as for
//     any browser. The room's socket there needs the page's edit key, as for any browser.
//
// The frame's page is the job's html (the room's text: the agent's latest edits, or a preview), in the app's own
// answer for it: its status and its headers (frame-ancestors) stand. A request for any other address goes to the
// network as it is.
//
// Trap: who made a request is what the browser says (the frame's id that CDP gives, the origin of the page in it),
// never what the request says. A document's page is its authors' code, and it writes its requests' headers.
// Trap: no cookie goes with a request that is answered here, and none comes back (viewRequest; ergaAnswer). The
// browser keeps no cookie of Erga's.
// Trap: what does not pause still goes to the network, as nobody: a window that a page opens, a worker's socket. Local
// development signs in a browser with no sign-in (the dev login): this one comes as a browser that signed out
// (`signedOut`).
// Trap: a page here has no service worker (client/inline/page-in-process.ts): a worker's own requests would be
// nobody's, the viewer's page among them.
//
// Trap: a browser of our own (the dev server's Chrome, the AWS host's) is on the server's machine, so the render
// refuses each request to a private address that is not Erga's own (private-address.ts). A test
// whose page loads from another site on 127.0.0.1 names that origin in its server's ERGA_RENDER_ALLOW
// (a test's own fonts server). The check reads the address as written: a public name that resolves to a
// private address, and a WebSocket, still pass.
//
// Trap: a clip that Chrome draws past the window (cdp.ts, screenshot: captureBeyondViewport) shows the page's frame
// blank once the window grew for the picture. A clip that is all in the window is taken from the window as drawn
// (`inWindow`): a tall element, and each part of a tall capture (shared/picture.ts).
//
// Each render logs its time in the browser (Cloudflare bills Browser Rendering by the browser's time): one JSON line,
// {"render": ...}.
//
// Trap: a browser connection belongs to the Durable Object that opened it. Another object in the same isolate gets
// "Cannot perform I/O on behalf of a different Durable Object". Keep it in the object (`browsers`), never in a module
// variable.

import { ASK } from "../gate/core";
import type { RenderJob } from "../document/life/document";
import { encodePath, pageAddress } from "../document/model/pages";
import { base64, fromBase64 } from "../shared/bytes";
import {
  FRAMES,
  VIEW_DEFAULT,
  evalTimeout,
  isOwn,
  renderTimes,
  type ColorScheme,
  type OwnAddresses,
  type Shot,
  type StepShown,
  type ViewResult,
} from "../shared/view-page";
import { sourceDigest } from "../shared/page-html";
import { PICTURE, pictureParts } from "../shared/picture";
import { reachable } from "./private-address";
import { pagesOrigin, readPagesClaims } from "../server/documents/index";
import { cookieName, SIGNED_OUT, viewRequest } from "../server/identity/index";
import { loadAssets, readerPage } from "../server/pages/index";
import type { Platform } from "../server/platform";
import { browsers } from "./browser";
import type { BrowserBinding, Page } from "./cdp";
import { pageSockets } from "./render-sockets";
import { renderTools, type Runner } from "./render-tools";

/** How long the page may take to load. */
const LOAD_MS = 10_000;
/** How long the editor may take to start in the frame, once the page has loaded. */
const EDITOR_MS = 8_000;
/** The tallest window a picture of the whole page takes (the page's 4000 px, and the viewer's room above it): it goes in parts (shared/picture.ts). */
const MAX_WINDOW = 4200;
/** The longest a render takes: then the page closes, even one whose script never yields (while (true)). */
const RENDER_MS = 60_000;
/** The longest the browser may take to close a page. */
const CLOSE_MS = 5_000;

type Job = RenderJob & { owner: string; id: string };

/**
 * The largest answer of Erga's that the browser gets, in bytes: it goes in one message of the browser's connection, as
 * base64 (a Worker's WebSocket takes 32 MiB in a message). A larger file fails to load there.
 */
const MAX_ANSWER = 8 * 1024 * 1024;

/**
 * How many of Erga's answers one render has at a time, from the app's answer until the browser has it: each one's
 * bytes are in this object's memory, three times over (the bytes, their base64, the message). And how many more may
 * wait: a request past them fails.
 */
const AT_ONCE = 4;
const IN_LINE = 500;

/** What a render needs of the server it runs in (cloudflare/app.ts; a test's server in memory). */
export interface RenderServer {
  platform: Platform;
  /** The app itself, behind the gate: its answer to a request. */
  erga: (request: Request) => Promise<Response>;
  /**
   * A browser of our own (the AWS host's Chrome, local development's), which is on the server's machine and in its
   * network: the only origins of a private address that it may ask, besides Erga's own. Null for Cloudflare's
   * browser, which sees only the public internet.
   */
  allow: string[] | null;
}

/** A server's renderer, in the browser behind `binding` (one for each Durable Object: its own connection). */
export function rendering(binding: BrowserBinding, server: RenderServer): (job: Job) => Promise<ViewResult> {
  const mine = browsers(binding);
  return (job) => render(server, mine, job);
}

/** Where the render reaches the document: the viewer's address, the frame's origin, and which addresses are Erga's own. */
interface Place {
  app: URL;
  shell: string;
  pages: string;
  server: RenderServer;
  /** Erga's own addresses: the app's origin, and the hosts of the documents' domain (any document's pages origin). */
  own: OwnAddresses;
  /** The addresses whose requests pause: Erga's own; for a browser of our own, all (a private address is refused). */
  patterns: string[];
}

/** A request of the browser's, paused before it goes out (CDP's Fetch.requestPaused). */
interface Paused {
  requestId: string;
  frameId: string;
  resourceType: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    hasPostData?: boolean;
    postData?: string;
    postDataEntries?: { bytes?: string }[];
  };
}

async function render(server: RenderServer, mine: ReturnType<typeof browsers>, job: Job): Promise<ViewResult> {
  const t0 = Date.now();
  const p = server.platform;
  const app = new URL(job.origin);
  // The editor's files' addresses, for the frame's page (readerPage): this object's isolate may not be the Worker's.
  await loadAssets(p, app);
  const rest = pageAddress(job.path);
  const pages = pagesOrigin(job.owner, job.id, app, p);
  // Every document's pages origin is at this one's scheme and port: on the one shared host, or under the documents' domain.
  const at = new URL(pages);
  const own: OwnAddresses = {
    app: app.origin,
    scheme: at.protocol,
    port: at.port,
    host: p.pagesShared?.(app) || null,
    domain: `.${p.pagesDomain(app)}`,
  };
  const place: Place = {
    app,
    shell: `${app.origin}/d/${job.id}${rest ? `/${encodePath(rest)}` : ""}${job.req.editor ? "?edit" : ""}`,
    pages,
    server,
    own,
    patterns: server.allow
      ? ["*"]
      : [`${app.origin}/*`, own.host ? `${at.origin}/*` : `${at.protocol}//*${own.domain}${at.port && `:${at.port}`}/*`],
  };
  /**
   * Local development signs in a browser with no sign-in, as the dev login (server/identity/mount.ts). What this
   * browser asks the network of Erga (a socket, a window that a page opens) is nobody's there too: it comes as a
   * browser that signed out.
   */
  const signedOut = p.dev(app)
    ? { name: cookieName(app, SIGNED_OUT), value: "1", url: `${app.origin}/`, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }
    : null;
  let how = "none";
  let opened = 0;
  // Each step, from the connection to the page's close, is in the RENDER_MS limit: a step that never answers (the
  // browser's socket, a script that never yields) can't keep the render, and its connection, in use for ever.
  let page: Page | null = null;
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ViewResult>((done) => {
    timer = setTimeout(
      () => done({ errors: [], error: `The render took more than ${RENDER_MS / 1000} s: the page's script may never yield.` }),
      RENDER_MS
    );
  });
  const work = async () => {
    const b = await mine.use();
    how = b.how;
    opened = Date.now();
    const context = await mine.context(b.browser, job.by);
    if (signedOut) await b.browser.send("Storage.setCookies", { cookies: [signedOut], browserContextId: context });
    const made = await b.browser.newPage(context);
    if (over) {
      await closed(made);
      throw new Error("The render was over before its page opened.");
    }
    page = made;
    return renderIn(made, place, job);
  };
  try {
    const doing = work();
    doing.catch(() => {}); // after the limit, its error goes nowhere
    return await Promise.race([doing, late]);
  } catch (e) {
    return { errors: [], error: `The server's browser couldn't render the page: ${(e as Error).message}` };
  } finally {
    over = true;
    clearTimeout(timer);
    if (page) await closed(page);
    mine.done();
    const end = Date.now();
    console.log(
      JSON.stringify({
        render: {
          doc: job.id,
          page: job.path,
          browser: how,
          start_ms: (opened || end) - t0,
          browser_ms: opened ? end - opened : 0,
          total_ms: end - t0,
        },
      })
    );
  }
}

/** Closes a page; the render goes on after CLOSE_MS without an answer. */
const closed = (page: Page) => Promise.race([page.close().catch(() => {}), new Promise((r) => setTimeout(r, CLOSE_MS))]);

/**
 * The page's frame: its target, when it's on another site (its own process), else its execution context in the
 * viewer's process. Its errors and console's join `errors`. It runs code in the frame's page as it is now (a link in the
 * frame may have opened another). `each`: every target of the page, before any of its code runs.
 */
async function watchFrame(page: Page, pages: string, scheme: string, errors: string[], each: (target: Page) => Promise<void>) {
  let target: Page | null = null;
  const contexts = new Map<string, number>();
  const onError = (message: string) => errors.push(message);
  const onConsole = (level: string, text: string) => {
    if (level == "error") errors.push(`console.error: ${text}`);
  };
  page.on((method, e) => {
    if (method == "Runtime.executionContextCreated" && e.context.auxData?.isDefault) contexts.set(e.context.auxData.frameId, e.context.id);
  });
  await page.onFrames(async (frame, url) => {
    // (Each frame keeps its listeners, the one before this one too: they answer its requests while it lives.)
    if (!url.startsWith(pages) && url != "about:blank" && url != "") return;
    target = frame;
    frame.onErrors(onError, onConsole);
    await Promise.all(["Runtime.enable", "Log.enable"].map((m) => frame.send(m)));
    await frame.colorScheme(scheme);
  }, each);
  const run: Runner = async <T>(expression: string) => {
    if (target) return target.evaluate<T>(expression);
    // The same process: the frame's own context, by its frame's id (the viewer's only frame, iframe#frame).
    const tree = await page.send("Page.getFrameTree");
    const id: string | undefined = tree.frameTree.childFrames?.[0]?.frame.id;
    const context = id == null ? undefined : contexts.get(id);
    if (context == null) throw new Error("The viewer has no frame with the page in it.");
    return page.evaluate<T>(expression, context);
  };
  return { run, apart: () => target != null, detach: () => (target as Page | null)?.detach() };
}

/** Opens the page in the viewer and answers the job: the pictures, or the expression's result. */
async function renderIn(page: Page, place: Place, job: Job): Promise<ViewResult> {
  const req = job.req;
  const width = Math.round(Math.max(320, Math.min(2400, req.width ?? VIEW_DEFAULT.width)));
  const height = Math.round(Math.max(200, Math.min(4000, req.height ?? VIEW_DEFAULT.height)));
  const scheme = req.colorScheme ?? "light";
  const times = renderTimes(req);
  if (times.length > FRAMES.count || times.some((t) => !Number.isFinite(t) || t < 0 || t > FRAMES.max))
    return { errors: [], error: `Give at most ${FRAMES.count} times, each from 0 to ${FRAMES.max} ms.` };
  if (req.editor && req.preview) return { errors: [], error: "A preview shows in the viewer only: leave out editor, or edits." };
  const errors: string[] = [];
  const served = { served: false };
  const app = place.app.origin;
  /**
   * The window's main frame, and the origin of the page in it now, as the browser says it (null: not said yet).
   * `strayed`: a page of another origin was in the window. From then on nothing is the person's: a late request of
   * that page could not be told from the app's own.
   */
  let viewer: string | null = null;
  let inWindow: string | null = null;
  let strayed = false;
  page.on((method, e) => {
    if (method != "Page.frameNavigated" || e.frame.parentId) return;
    inWindow = e.frame.securityOrigin;
    if (inWindow != app) strayed = true;
  });
  const windowOrigin = async (): Promise<string> => inWindow ?? (await page.send("Page.getFrameTree")).frameTree.frame.securityOrigin;
  const person = { login: job.by, doc: job.id };
  /** The render is over: no request is answered any more, and none waits. */
  let over = false;
  /** AT_ONCE: an answer's turn, which the next in line gets when it is done. */
  let busy = 0;
  const waiting: (() => void)[] = [];
  const turn = async <T>(make: () => Promise<T>): Promise<T> => {
    if (busy < AT_ONCE) busy++;
    else if (waiting.length < IN_LINE) await new Promise<void>((go) => waiting.push(go));
    else throw new Error("too many requests at a time");
    try {
      if (over) throw new Error("the render is over");
      return await make();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else busy--;
    }
  };
  /** A paused request: Erga's own, answered here; one to a private address fails (our own browser); the rest go on. */
  const answer = async (target: Page, e: Paused, top: boolean): Promise<unknown> => {
    const url = new URL(e.request.url);
    if (isOwn(place.own, url)) {
      const window = top && e.frameId == viewer;
      const goes = e.resourceType == "Document";
      // The person's: a page of the app's, in the window's main frame, asks the app; or the window itself goes to it.
      const theirs = window && !strayed && url.origin == app && (goes || (await windowOrigin()) == app);
      // From where, as a browser says it of such a request: the app's own page; the render's own first address; and
      // the window going on from a page, which any page in it may have asked for.
      const site = !theirs ? null : !goes ? "same-origin" : inWindow == null ? "none" : "cross-site";
      // (Its turn lasts until the browser has the answer.)
      return turn(async () => {
        const made = await ergaAnswer(place, job, e, { window, person: theirs ? person : null, site, served });
        return target.send(made ? "Fetch.fulfillRequest" : "Fetch.failRequest", {
          requestId: e.requestId,
          ...(made ?? { errorReason: "Failed" }),
        });
      });
    }
    if (place.server.allow && !reachable(e.request.url, place.server.allow))
      return target.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "AddressUnreachable" });
    return target.send("Fetch.continueRequest", { requestId: e.requestId });
  };
  /** Pauses the requests of a target (the window, a frame of another site, a worker with requests of its own), and answers each. */
  const pause = (target: Page, top: boolean) => {
    target.on((method, e) => {
      if (method != "Fetch.requestPaused") return;
      answer(target, e as Paused, top).catch(() =>
        target.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "Failed" }).catch(() => {})
      );
    });
    return target.send("Fetch.enable", { patterns: place.patterns.map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });
  };
  /** The pages' sockets to Erga, answered here too (render-sockets.ts): the person's by the same rule. */
  const sockets = pageSockets(place.own, (ask) => {
    if (!isOwn(place.own, ask.url)) return null;
    const theirs = ask.top && ask.frame == viewer && !strayed && ask.origin == app && ask.url.origin == app;
    const headers = new Headers({ Upgrade: "websocket", Origin: ask.origin });
    return place.server.erga(viewRequest(ask.url.href, { method: "GET", headers }, theirs ? person : null));
  });
  /**
   * Each target of the page, and each of theirs, before any of its code runs. (A worker has no requests to pause, and
   * no page: its requests pause in its page's target.)
   */
  const each = async (target: Page): Promise<void> => {
    await Promise.all([
      pause(target, false).catch(() => {}),
      sockets.watch(target, false).catch(() => {}),
      target.onFrames(async () => {}, each),
    ]).catch(() => {});
  };
  const frame = await watchFrame(page, place.pages, scheme, errors, each);
  try {
    // The viewer's own errors too: in a frame of its own process, the page's are apart, and these say they're the viewer's.
    page.onErrors(
      (message) => errors.push(frame.apart() ? `Erga's viewer: ${message}` : message),
      (level, text) => {
        if (level == "error") errors.push(`${frame.apart() ? "Erga's viewer: " : ""}console.error: ${text}`);
      }
    );
    // The page's set-up, sent together: each is apart from the others, and all are done before the page opens.
    const [tree] = await Promise.all([
      page.send("Page.getFrameTree"),
      page.setViewport(width, height),
      page.colorScheme(scheme),
      // The person's agent stays closed (the agent that asked is beside it): the page has the window's whole width.
      page.send("Page.addScriptToEvaluateOnNewDocument", { source: AGENT_CLOSED }),
      // The viewer's Content-Security-Policy allows no eval, which the expression needs (client/page-tools/evaluate.ts).
      req.shell && req.evaluate != null ? page.send("Page.setBypassCSP", { enabled: true }) : null,
      pause(page, true),
      sockets.watch(page, true),
    ]);
    viewer = tree.frameTree.frame.id;
    return await shown(page, place, job, { width, height, scheme, times, errors, run: frame.run });
  } finally {
    over = true;
    for (const go of waiting.splice(0)) go();
    sockets.close();
    frame.detach();
  }
}

/**
 * Erga's own answer to a request of the browser's, made in process, as CDP's Fetch.fulfillRequest takes it; null for
 * one too large for the browser's connection, or whose body the browser gave no bytes of. `window`: the window's main frame asked. `person`: whose request it
 * is, if anyone's (see the top of this file), and `site`: from where. `served`: whether the frame's page went out
 * already.
 */
async function ergaAnswer(
  place: Place,
  job: Job,
  e: Paused,
  o: { window: boolean; person: { login: string; doc: string } | null; site: string | null; served: { served: boolean } }
) {
  const url = new URL(e.request.url);
  const headers = new Headers(e.request.headers);
  const fulfil = (responseCode: number, responseHeaders: [string, string][], body: Uint8Array) => ({
    responseCode,
    responseHeaders: responseHeaders.map(([name, value]) => ({ name, value })),
    body: base64(body),
  });
  // What a request is for (the window's page, or a frame's) and from where, the browser says in headers that it adds
  // after this pause. Erga reads them: these say it here.
  for (const h of ["sec-fetch-dest", "sec-fetch-site"]) headers.delete(h);
  if (e.resourceType == "Document") headers.set("sec-fetch-dest", o.window ? "document" : "iframe");
  if (o.site) headers.set("sec-fetch-site", o.site);
  // The frame's page, the first time: the job's text goes in the app's answer for it, which is asked for whole.
  const [, token, file] =
    (e.resourceType == "Document" && url.origin == place.pages ? /^\/t\/([^/]+)\/(.*)$/.exec(url.pathname) : null) ?? [];
  const mine = !o.served.served && !!token && safeDecode(file) == job.path;
  if (mine) for (const h of ["if-none-match", "if-modified-since"]) headers.delete(h);
  const method = e.request.method;
  // (Its bytes, where the browser gives them: its text alone loses what isn't text. A body that the browser gives no
  // bytes of never goes on as an empty one: the request fails.)
  const parts = e.request.postDataEntries?.map((x) => x.bytes) ?? [];
  const whole = parts.length > 0 && parts.every((x) => x != null);
  if (!whole && (parts.length || (e.request.hasPostData && e.request.postData == null))) return null;
  const sent = whole ? new Blob(parts.map((x) => fromBase64(x!))) : (e.request.postData ?? null);
  const answer = await place.server.erga(
    viewRequest(e.request.url, { method, headers, body: /^(GET|HEAD)$/.test(method) ? null : sent }, o.person)
  );
  // Its bytes, read only up to the most that the browser gets.
  const read: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for await (const chunk of (answer.body ?? []) as AsyncIterable<Uint8Array<ArrayBuffer>>) {
    if ((size += chunk.length) > MAX_ANSWER) return (await answer.body?.cancel().catch(() => {}), null);
    read.push(chunk);
  }
  let body: Uint8Array = new Uint8Array(await new Blob(read).arrayBuffer());
  // (No cookie of Erga's: the browser would send it only to the network. And nothing that the app asks of the gate.)
  let out = [...answer.headers].filter(([name]) => name != "set-cookie" && name != ASK);
  const claims =
    mine && answer.status == 200 && /^text\/html\b/i.test(answer.headers.get("content-type") ?? "")
      ? await readPagesClaims(place.server.platform.secret, token, job.owner, job.id)
      : null;
  if (claims) {
    o.served.served = true;
    const html = readerPage(job.html, {
      shell: claims.shell,
      prefix: `/t/${token}/`,
      src: sourceDigest(job.html),
      editor: !!claims.edit,
      worker: true,
    });
    body = new TextEncoder().encode(html);
    out = [...out.filter(([name]) => !/^(etag|last-modified|content-length|cache-control)$/.test(name)), ["Cache-Control", "no-store"]];
  }
  return fulfil(answer.status, out, body);
}

/** The page in the viewer: loaded, and the editor started if asked for; then the job's pictures or expression. */
async function shown(
  page: Page,
  place: Place,
  job: Job,
  o: { width: number; height: number; scheme: ColorScheme; times: number[]; errors: string[]; run: Runner }
): Promise<ViewResult> {
  const { width, height, scheme, times, errors } = o;
  const req = job.req;
  const steps = req.steps ?? [];
  // A hash step opens the page there (the viewer gives its frame the hash); a number goes to its step once the page has loaded.
  const first = steps[0]?.startsWith("#") ? steps[0] : "";
  try {
    await page.goto(place.shell + first, LOAD_MS);
  } catch {
    return { errors, error: `The page took more than ${LOAD_MS / 1000} s to load, so nothing ran in it.` };
  }
  const shell: Runner = (expression) => page.evaluate(expression);
  const where = await shell<{ editing: boolean; bars: boolean; frame: boolean }>(
    `(() => { const c = document.querySelector(".erga-crumbs"); return { editing: document.body.classList.contains("erga-editing"), bars: !!c && getComputedStyle(c).display != "none", frame: !!document.getElementById("frame") }; })()`
  );
  if (!where.frame) return { errors, error: "The viewer didn't open the page: it may not be yours to see." };
  const notes: string[] = [];
  if (req.editor && !where.editing) notes.push("Shown in the viewer: the person may not edit this document, so it has no editor.");
  if (where.editing) {
    const deadline = Date.now() + EDITOR_MS;
    const up = `!!window.ergaFrame?.page && !ergaFrame.reloading && document.documentElement.hasAttribute("data-erga-editing")`;
    while (!(await o.run<boolean>(up).catch(() => false)))
      if (Date.now() > deadline) return { errors, error: `The editor didn't start in ${EDITOR_MS / 1000} s.` };
      else await new Promise((r) => setTimeout(r, 50));
  }
  const call = renderTools(o.run);
  const pending = await call("settle");
  const base = {
    errors,
    viewport: { width, height },
    colorScheme: scheme,
    shown: where.editing ? "editor" : "viewer",
    bars: where.bars,
    ...(pending.length ? { pending } : {}),
  } as const;

  /** Shows a step: the step shown, or why it couldn't (a note goes with the result). */
  const show = async (spec: string): Promise<StepShown | null | string> => {
    const s = await call("step", spec);
    if (typeof s == "string") return s;
    if ("note" in s) return (notes.push(s.note), null);
    return s;
  };

  if (req.evaluate != null) {
    const step = steps[0] != null ? await show(steps[0]) : null;
    if (typeof step == "string") return { ...base, error: step };
    if (pending.length) notes.push(`Still loading when the expression ran: ${pending.join(", ")}.`);
    const runs: { at: number; value?: string; note?: string; error?: string }[] = [];
    const inShell = req.shell ? renderTools(shell) : call;
    for (const t of times) runs.push(await inShell("evaluate", req.evaluate, evalTimeout(req), t));
    const failed = runs.find((x) => x.error);
    const value = !req.frames?.length
      ? runs[0].value
      : failed
        ? undefined
        : `[${runs.map((x) => `{"at_ms":${x.at},"value":${x.value}}`).join(",")}]`;
    const note = [...notes, ...runs.map((x) => x.note).filter((n): n is string => !!n)].join("\n");
    return {
      ...base,
      ...(value != null ? { value } : {}),
      ...(failed ? { error: (req.frames?.length ? `At ${failed.at} ms: ` : "") + failed.error } : {}),
      ...(note ? { note } : {}),
      ...(step ? { step } : {}),
    };
  }

  // Each place (a selector, or a step), at each time: one picture each.
  const selectors = req.selectors ?? [];
  const places: { selector: string | null; step: string | null }[] =
    steps.length > 1 || (steps.length && selectors.length <= 1)
      ? steps.map((step) => ({ selector: selectors[0] ?? null, step }))
      : (selectors.length ? selectors : [null]).map((selector) => ({ selector, step: steps[0] ?? null }));
  if (places.length * times.length > FRAMES.count)
    return { ...base, error: `That is ${places.length * times.length} pictures: one call takes at most ${FRAMES.count}.` };
  const shots: Shot[] = [];
  let stepShown: StepShown | null = null;
  let last: string | null = null;
  for (const place of places) {
    if (place.step != null && place.step != last) {
      const s = await show(place.step);
      if (typeof s == "string") return { ...base, error: s };
      stepShown = s;
      last = place.step;
    }
    for (const t of times) {
      // The whole page, or an element not all in view: the window as tall as the page for this picture, as a person's
      // taller window would show it.
      const tall = await call("need", place.selector, !!req.fullPage);
      const grown = tall ? Math.min(MAX_WINDOW, Math.round(tall + height - (await shell<{ height: number }>(FRAME_RECT)).height)) : 0;
      if (grown) {
        await page.setViewport(width, grown);
        await o.run("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
      }
      const held = await call("hold", t, place.selector, !!req.fullPage);
      try {
        if (held.error) return { ...base, error: req.frames?.length ? `At ${held.at} ms: ${held.error}` : held.error };
        // The window, or an element: the frame's coordinates, moved to the window's.
        const at = held.clip ? await shell<{ x: number; y: number }>(FRAME_RECT) : null;
        const clip = held.clip && at ? { ...held.clip, x: held.clip.x + at.x, y: held.clip.y + at.y } : undefined;
        // A capture taller than the model reads whole goes in parts, from its top (shared/picture.ts).
        const whole = clip ?? { x: 0, y: 0, width, height: grown || height };
        const parts = pictureParts(whole.width, whole.height);
        let top = 0;
        for (const [i, tall] of parts.entries()) {
          const part = parts.length > 1 ? { ...whole, y: whole.y + top, height: tall } : clip;
          // The window grew to show the capture: a clip all in it is taken from the window as drawn (cdp.ts, screenshot).
          const inWindow = whole.y >= 0 && whole.y + whole.height <= (grown || height) && whole.x >= 0 && whole.x + whole.width <= width;
          let data = await page.screenshot(part, { inWindow });
          // A PNG of more bytes than the model takes (photographs): the same picture as a JPEG.
          const jpeg = data.length > PICTURE.data;
          if (jpeg) data = await page.screenshot(part, { inWindow, format: "jpeg" });
          shots.push({
            data,
            type: jpeg ? "image/jpeg" : "image/png",
            width: whole.width,
            height: tall,
            at: held.at,
            ...(parts.length > 1 ? { part: { index: i + 1, count: parts.length, top } } : {}),
            ...(place.selector ? { selector: place.selector } : {}),
            ...(stepShown ? { step: stepShown } : {}),
            ...(held.note && !i ? { note: held.note } : {}),
          });
          top += tall;
        }
      } finally {
        await call("release");
        if (grown) await page.setViewport(width, height);
      }
    }
  }
  const fonts = await call("fonts", places[places.length - 1].selector);
  return { ...base, shots, fonts, ...(notes.length ? { note: notes.join("\n") } : {}) };
}

/** In the viewer's window, before its scripts: the person's agent panel closed (erga:settings:v1, as its close button keeps it). */
const AGENT_CLOSED = `if (window.top == window) try { const k = "erga:settings:v1", s = JSON.parse(localStorage.getItem(k) || "{}") || {}; if (s.agent !== false) localStorage.setItem(k, JSON.stringify({ ...s, agent: false })); } catch {}`;

/** The page's frame in the viewer's window. */
const FRAME_RECT = `(() => { const r = document.getElementById("frame").getBoundingClientRect(); return { x: r.x, y: r.y, height: r.height }; })()`;

const safeDecode = (path: string | undefined) => {
  try {
    return path == null ? null : decodeURIComponent(path);
  } catch {
    return null;
  }
};

