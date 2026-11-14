// view_page and eval_in_page, rendered by the server's browser (cloudflare/browser.ts): it opens the page in Erga's
// real viewer, as its person does, at the document's address (/d/<id>/<page>, ?edit for the editor): the viewer on the
// app's origin, the bars as the document's settings give them, and the page in its frame on the document's pages
// origin. The browser is signed in as the agent's person with a view cookie (server/identity/session.ts): one document,
// a few minutes, no admin power; in a browser context of the person's own (cloudflare/browser.ts). The frame's page comes from
// the room (the job's html: the agent's latest edits, or a preview), the rest over the network. In the frame,
// client/page-tools/capture.ts waits for its fonts, shows a step and holds its animations; the browser takes each
// picture itself, of the whole window.
//
// Trap: a browser of our own (the dev server's Chrome, the AWS host's) is on the server's machine, so the render
// refuses each request to a private address but Erga's own two origins (`own`; private-address.ts). A test
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

import type { RenderJob } from "../document/agent";
import { encodePath, pageAddress } from "../document/pages";
import { base64 } from "../shared/bytes";
import {
  FRAMES,
  VIEW_DEFAULT,
  evalTimeout,
  renderTimes,
  type ColorScheme,
  type Shot,
  type StepShown,
  type ViewResult,
} from "../shared/view-page";
import { sourceDigest } from "../shared/page-html";
import { PICTURE, pictureParts } from "../shared/picture";
import { reachable } from "./private-address";
import { pagesOrigin, readPagesClaims } from "../server/documents/index";
import { cookieName, SESSION_COOKIE, viewCookie } from "../server/identity/index";
import { loadAssets, readerPage } from "../server/pages/index";
import { browserBinding, browsers } from "./browser";
import type { Page } from "./cdp";
import { renderTools, type Runner } from "./render-tools";
import type { Env } from "./env";
import { platform } from "./platform";

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

/** A document's renderer (one for each Durable Object: its own connection), or none where there's no browser. */
export function renderer(env: Env): ((job: Job) => Promise<ViewResult>) | undefined {
  const binding = browserBinding(env);
  if (!binding) return undefined;
  const mine = browsers(binding);
  return (job) => render(env, mine, job);
}

/** Where the render reaches the document: the viewer's address, the frame's origin, and the view cookie. */
interface Place {
  app: URL;
  shell: string;
  pages: string;
  cookie: { name: string; value: string; url: string; path: string; httpOnly: true; secure: boolean; sameSite: "Lax" };
  secret: string;
  /**
   * A browser of our own (the AWS host's Chrome, local development's), which is on the server's machine and in its
   * network: the only origins of a private address that it may ask (Erga's own two). Null for Cloudflare's browser,
   * which sees only the public internet.
   */
  own: string[] | null;
}

async function render(env: Env, mine: ReturnType<typeof browsers>, job: Job): Promise<ViewResult> {
  const t0 = Date.now();
  const p = platform(env);
  const app = new URL(job.origin);
  // The editor's files' addresses, for the frame's page (readerPage): this object's isolate may not be the Worker's.
  await loadAssets(p, app);
  const rest = pageAddress(job.path);
  const pages = pagesOrigin(job.owner, job.id, app, p);
  const place: Place = {
    app,
    shell: `${app.origin}/d/${job.id}${rest ? `/${encodePath(rest)}` : ""}${job.req.editor ? "?edit" : ""}`,
    pages,
    cookie: {
      name: cookieName(app, SESSION_COOKIE),
      value: await viewCookie(p.secret, job.by, job.id, t0),
      url: `${app.origin}/`,
      path: "/",
      httpOnly: true,
      secure: app.protocol == "https:",
      sameSite: "Lax",
    },
    secret: p.secret,
    own: env.BROWSER ? null : [app.origin, new URL(pages).origin, ...(env.ERGA_RENDER_ALLOW ?? "").split(",").filter(Boolean)],
  };
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
    await b.browser.send("Storage.setCookies", { cookies: [place.cookie], browserContextId: context });
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

/** Where code runs: the viewer's window, or the page's frame. */

/**
 * The page's frame: its target, when it's on another site (its own process), else its execution context in the
 * viewer's process. Its errors and console's join `errors`. It runs code in the frame's page as it is now (a link in the
 * frame may have opened another).
 */
async function watchFrame(page: Page, pages: string, scheme: string, errors: string[], guard: ((target: Page) => Promise<void>) | null) {
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
    // (A guarded frame of another site keeps its listeners: they refuse its requests to private addresses.)
    if (!url.startsWith(pages) && url != "about:blank" && url != "") return guard ? undefined : void frame.detach();
    target?.detach();
    target = frame;
    frame.onErrors(onError, onConsole);
    await Promise.all(["Runtime.enable", "Log.enable"].map((m) => frame.send(m)));
    await frame.colorScheme(scheme);
  }, guard ?? undefined);
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
  const own = place.own;
  /** Refuses a paused request to a private address; answers whether it did. */
  const refused = (target: Page, e: { requestId: string; request: { url: string } }) => {
    if (!own || reachable(e.request.url, own)) return false;
    target.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "AddressUnreachable" }).catch(() => {});
    return true;
  };
  /**
   * Our own browser: each target of the page (a frame of another site, a frame in it, a worker) has every request
   * paused, and one to a private address fails (private-address.ts). Before any of its code runs.
   */
  const guard = own
    ? async (target: Page): Promise<void> => {
        target.on((method, e) => {
          if (method == "Fetch.requestPaused" && !refused(target, e as never))
            target.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
        });
        await Promise.all([
          target.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }),
          target.onFrames(async () => {}, guard!),
        ]).catch(() => {});
      }
    : null;
  const frame = await watchFrame(page, place.pages, scheme, errors, guard);
  try {
    // The viewer's own errors too: in a frame of its own process, the page's are apart, and these say they're the viewer's.
    page.onErrors(
      (message) => errors.push(frame.apart() ? `Erga's viewer: ${message}` : message),
      (level, text) => {
        if (level == "error") errors.push(`${frame.apart() ? "Erga's viewer: " : ""}console.error: ${text}`);
      }
    );
    // The page's set-up, sent together: each is apart from the others, and all are done before the page opens.
    await Promise.all([
      page.setViewport(width, height),
      page.colorScheme(scheme),
      // The person's agent stays closed (the agent that asked is beside it): the page has the window's whole width.
      page.send("Page.addScriptToEvaluateOnNewDocument", { source: AGENT_CLOSED }),
      // The viewer's Content-Security-Policy allows no eval, which the expression needs (client/page-tools/evaluate.ts).
      req.shell && req.evaluate != null ? page.send("Page.setBypassCSP", { enabled: true }) : null,
      // The frame's page comes from the room's text (the agent's latest edits, or a preview): its first request is answered here.
      // (Our own browser: every request of the window is paused, and one to a private address fails.)
      page.send("Fetch.enable", {
        patterns: [
          own
            ? { urlPattern: "*", requestStage: "Request" }
            : { urlPattern: `${place.pages}/t/*`, resourceType: "Document", requestStage: "Request" },
        ],
      }),
    ]);
    let served = false;
    page.on((method, e) => {
      if (method != "Fetch.requestPaused" || refused(page, e as never)) return;
      void (async () => {
        const mine = e.resourceType == "Document" && e.request.url.startsWith(`${place.pages}/t/`);
        const [, token, file] = (mine ? /^\/t\/([^/]+)\/(.*)$/.exec(new URL(e.request.url).pathname) : null) ?? [];
        const claims = !served && token ? await readPagesClaims(place.secret, token, job.owner, job.id) : null;
        if (!claims || safeDecode(file) != job.path) return page.send("Fetch.continueRequest", { requestId: e.requestId });
        served = true;
        const html = readerPage(job.html, {
          shell: place.app.origin,
          prefix: `/t/${token}/`,
          src: sourceDigest(job.html),
          editor: !!claims.edit,
        });
        return page.send("Fetch.fulfillRequest", {
          requestId: e.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: "text/html; charset=utf-8" },
            { name: "Cache-Control", value: "no-store" },
            { name: "Content-Security-Policy", value: `frame-ancestors ${place.app.origin}` },
          ],
          body: base64(new TextEncoder().encode(html)),
        });
      })().catch(() => {});
    });
    return await shown(page, place, job, { width, height, scheme, times, errors, run: frame.run });
  } finally {
    frame.detach();
  }
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

