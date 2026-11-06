// view_page and eval_in_page, rendered by the server's browser (cloudflare/browser.ts): it opens the page in Erga's
// real viewer, as its person does, at the document's address (/d/<id>/<page>, ?edit for the editor): the viewer on the
// app's origin, the bars as the document's settings give them, and the page in its frame on the document's pages
// origin. The browser is signed in as the agent's person with a view cookie (server/identity/session.ts): one document,
// a few minutes, no admin power; in a browser context of the person's own (cloudflare/browser.ts). The frame's page comes from
// the room (the job's html: the agent's latest edits, or a preview), the rest over the network. In the frame,
// client/page-tools/capture.ts waits for its fonts, shows a step and holds its animations; the browser takes each
// picture itself, of the whole window.
//
// Each render logs its time in the browser (Cloudflare bills Browser Rendering by the browser's time): one JSON line,
// {"render": ...}.

import type { RenderJob } from "../document/agent";
import { encodePath, pageAddress } from "../document/pages";
import {
  FRAMES,
  VIEW_DEFAULT,
  evalTimeout,
  type ColorScheme,
  type PageRender,
  type Shot,
  type StepShown,
  type ViewResult,
} from "../shared/agent-log";
import { sourceDigest } from "../shared/page-html";
import { pagesOrigin, readPagesClaims } from "../server/documents/index";
import { cookieName, SESSION_COOKIE, viewCookie } from "../server/identity/index";
import { inlineCall, readerPage } from "../server/pages/index";
import { browserBinding, browsers } from "./browser";
import type { Page } from "./cdp";
import type { Env } from "./env";
import { platform } from "./platform";

/** How long the page may take to load. */
const LOAD_MS = 10_000;
/** How long the editor may take to start in the frame, once the page has loaded. */
const EDITOR_MS = 8_000;
/** The tallest window a picture of the whole page takes (the page's 4000 px, and the viewer's room above it). */
const MAX_WINDOW = 4200;
/** The longest a render takes: then the page closes, even one whose script never yields (while (true)). */
const RENDER_MS = 60_000;

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
}

async function render(env: Env, mine: ReturnType<typeof browsers>, job: Job): Promise<ViewResult> {
  const t0 = Date.now();
  const p = platform(env);
  const app = new URL(job.origin);
  const rest = pageAddress(job.path);
  const place: Place = {
    app,
    shell: `${app.origin}/d/${job.id}${rest ? `/${encodePath(rest)}` : ""}${job.req.editor ? "?edit" : ""}`,
    pages: pagesOrigin(job.owner, job.id, app, p),
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
  };
  let how = "none";
  let opened = 0;
  try {
    const b = await mine.use();
    how = b.how;
    opened = Date.now();
    const context = await mine.context(b.browser, job.by);
    await b.browser.send("Storage.setCookies", { cookies: [place.cookie], browserContextId: context });
    const page = await b.browser.newPage(context);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<ViewResult>((done) => {
        timer = setTimeout(
          () => done({ errors: [], error: `The render took more than ${RENDER_MS / 1000} s: the page's script may never yield.` }),
          RENDER_MS
        );
      });
      return await Promise.race([renderIn(page, place, job), late]).finally(() => clearTimeout(timer));
    } finally {
      await page.close().catch(() => {});
    }
  } catch (e) {
    return { errors: [], error: `The server's browser couldn't render the page: ${(e as Error).message}` };
  } finally {
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

/** Where code runs: the viewer's window, or the page's frame. */
type Runner = <T>(expression: string) => Promise<T>;

/**
 * The page's frame: its target, when it's on another site (its own process), else its execution context in the
 * viewer's process. Its errors and console's join `errors`. It runs code in the frame's page as it is now (a link in the
 * frame may have opened another).
 */
async function watchFrame(page: Page, pages: string, scheme: string, errors: string[]) {
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
    if (!url.startsWith(pages) && url != "about:blank" && url != "") return void frame.detach();
    target?.detach();
    target = frame;
    frame.onErrors(onError, onConsole);
    await Promise.all(["Runtime.enable", "Log.enable"].map((m) => frame.send(m)));
    await frame.colorScheme(scheme);
  });
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
  const times = req.frames?.length ? req.frames : [req.atMs ?? (req.steps?.length ? FRAMES.afterStep : FRAMES.afterLoad)];
  if (times.length > FRAMES.count || times.some((t) => !Number.isFinite(t) || t < 0 || t > FRAMES.max))
    return { errors: [], error: `Give at most ${FRAMES.count} times, each from 0 to ${FRAMES.max} ms.` };
  if (req.editor && req.preview) return { errors: [], error: "A preview shows in the viewer only: leave out editor, or edits." };
  const errors: string[] = [];
  const frame = await watchFrame(page, place.pages, scheme, errors);
  try {
    // The viewer's own errors too: in a frame of its own process, the page's are apart, and these say they're the viewer's.
    page.onErrors(
      (message) => errors.push(frame.apart() ? `Erga's viewer: ${message}` : message),
      (level, text) => {
        if (level == "error") errors.push(`${frame.apart() ? "Erga's viewer: " : ""}console.error: ${text}`);
      }
    );
    await page.setViewport(width, height);
    await page.colorScheme(scheme);
    // The person's agent stays closed (the agent that asked is beside it): the page has the window's whole width.
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: AGENT_CLOSED });
    // The viewer's Content-Security-Policy allows no eval, which the expression needs (client/page-tools/evaluate.ts).
    if (req.shell && req.evaluate != null) await page.send("Page.setBypassCSP", { enabled: true });
    // The frame's page comes from the room's text (the agent's latest edits, or a preview): its first request is answered here.
    await page.send("Fetch.enable", {
      patterns: [{ urlPattern: `${place.pages}/t/*`, resourceType: "Document", requestStage: "Request" }],
    });
    let served = false;
    page.on((method, e) => {
      if (method != "Fetch.requestPaused") return;
      void (async () => {
        const [, token, file] = /^\/t\/([^/]+)\/(.*)$/.exec(new URL(e.request.url).pathname) ?? [];
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
          body: base64(html),
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
  /** One of the render tools (window.__ergaRender) in the page's frame (or with `where`, the viewer's window), with its arguments. */
  const tools = (where: Runner) => {
    let installed: Promise<unknown> | null = null;
    return async <K extends keyof PageRender>(name: K, ...args: Parameters<PageRender[K]>) => {
      await (installed ??= where(inlineCall("page-render")));
      return where<Awaited<ReturnType<PageRender[K]>>>(`globalThis.__ergaRender[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
    };
  };
  const call = tools(o.run);
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
    const inShell = req.shell ? tools(shell) : call;
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
        const png = await page.screenshot(clip);
        shots.push({
          png,
          width: clip?.width ?? width,
          height: clip?.height ?? (grown || height),
          at: held.at,
          ...(place.selector ? { selector: place.selector } : {}),
          ...(stepShown ? { step: stepShown } : {}),
          ...(held.note ? { note: held.note } : {}),
        });
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

const base64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
