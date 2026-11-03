// view_page and eval_in_page, rendered by the server's browser (cloudflare/browser.ts): it opens the page on the
// document's pages origin, as a reader sees it, with a token of its own that opens only this document's files, read
// only, for a few minutes (never the person's session). The page's own text comes from the room (the job's html: the
// agent's latest edits, or a preview), the rest of its files over the network. In the page, client/page-tools/capture.ts
// waits for its fonts, shows a step and holds its animations; the browser takes each picture itself.
//
// Each render logs its time in the browser (Cloudflare bills Browser Rendering by the browser's time): one JSON line,
// {"render": ...}.

import type { RenderJob } from "../document/agent";
import { encodePath } from "../document/pages";
import {
  FRAMES,
  VIEW_DEFAULT,
  evalTimeout,
  type PageRender,
  type Shot,
  type StepShown,
  type ViewResult,
} from "../shared/agent-log";
import { sourceDigest } from "../shared/page-html";
import { pagesOrigin, pagesToken } from "../server/documents/index";
import { inlineCall, readerPage } from "../server/pages/index";
import { browserBinding, browsers } from "./browser";
import type { Page } from "./cdp";
import type { Env } from "./env";
import { platform } from "./platform";

/** How long the browser's token opens the document's files, in seconds. */
const TOKEN_TTL = 300;
/** How long the page may take to load. */
const LOAD_MS = 10_000;
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

async function render(env: Env, mine: ReturnType<typeof browsers>, job: Job): Promise<ViewResult> {
  const t0 = Date.now();
  const p = platform(env);
  const app = new URL(job.origin);
  const prefix = `/t/${await pagesToken(p.secret, job.owner, job.id, app.origin, t0, { ttl: TOKEN_TTL, ...(p.adminsOnly ? { by: job.by } : {}) })}/`;
  const address = `${pagesOrigin(job.owner, job.id, app, p)}${prefix}${encodePath(job.path)}`;
  const html = readerPage(job.html, { shell: app.origin, prefix, src: sourceDigest(job.html), editor: false });
  let how = "none";
  let opened = 0;
  try {
    const b = await mine.use();
    how = b.how;
    opened = Date.now();
    const page = await b.browser.newPage();
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<ViewResult>((done) => {
        timer = setTimeout(
          () => done({ errors: [], error: `The render took more than ${RENDER_MS / 1000} s: the page's script may never yield.` }),
          RENDER_MS
        );
      });
      return await Promise.race([renderIn(page, address, html, job), late]).finally(() => clearTimeout(timer));
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

/** Opens the page and answers the job: the pictures, or the expression's result. */
async function renderIn(page: Page, address: string, html: string, job: Job): Promise<ViewResult> {
  const req = job.req;
  const width = Math.round(Math.max(320, Math.min(2400, req.width ?? VIEW_DEFAULT.width)));
  const height = Math.round(Math.max(200, Math.min(4000, req.height ?? VIEW_DEFAULT.height)));
  const scheme = req.colorScheme ?? "light";
  const times = req.frames?.length ? req.frames : [req.atMs ?? (req.steps?.length ? FRAMES.afterStep : FRAMES.afterLoad)];
  if (times.length > FRAMES.count || times.some((t) => !Number.isFinite(t) || t < 0 || t > FRAMES.max))
    return { errors: [], error: `Give at most ${FRAMES.count} times, each from 0 to ${FRAMES.max} ms.` };
  const errors: string[] = [];
  page.onErrors(
    (message) => errors.push(message),
    (level, text) => {
      if (level == "error") errors.push(`console.error: ${text}`);
    }
  );
  await page.setViewport(width, height);
  await page.colorScheme(scheme);
  // The page itself comes from the room's text (the agent's latest edits, or a preview): its first request is answered here.
  await page.send("Fetch.enable", { patterns: [{ urlPattern: address, resourceType: "Document", requestStage: "Request" }] });
  page.on((method, e) => {
    if (method != "Fetch.requestPaused") return;
    if (e.request.url != address) return void page.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
    void page
      .send("Fetch.fulfillRequest", {
        requestId: e.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: "text/html; charset=utf-8" },
          { name: "Cache-Control", value: "no-store" },
        ],
        body: base64(html),
      })
      .catch(() => {});
  });
  const steps = req.steps ?? [];
  // A hash step opens the page there; a number goes to its step once the page has loaded.
  const first = steps[0]?.startsWith("#") ? steps[0] : "";
  try {
    await page.goto(address + first, LOAD_MS);
  } catch {
    return { errors, error: `The page took more than ${LOAD_MS / 1000} s to load, so nothing ran in it.` };
  }
  await page.evaluate(inlineCall("page-render"));
  /** One of the page's render tools (window.__ergaRender), with its arguments. */
  const call = <K extends keyof PageRender>(name: K, ...args: Parameters<PageRender[K]>) =>
    page.evaluate<Awaited<ReturnType<PageRender[K]>>>(`globalThis.__ergaRender[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
  const pending = await call("settle");
  const notes: string[] = [];
  const base = { errors, viewport: { width, height }, colorScheme: scheme, ...(pending.length ? { pending } : {}) } as const;

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
    for (const t of times) runs.push(await call("evaluate", req.evaluate, evalTimeout(req), t));
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
      const held = await call("hold", t, place.selector, !!req.fullPage);
      try {
        if (held.error) return { ...base, error: req.frames?.length ? `At ${held.at} ms: ${held.error}` : held.error };
        // The screenful, or a part of the page (in the page's own coordinates, scrolled or not).
        const png = await page.screenshot(held.clip);
        shots.push({
          png,
          width: held.clip?.width ?? width,
          height: held.clip?.height ?? height,
          at: held.at,
          ...(place.selector ? { selector: place.selector } : {}),
          ...(stepShown ? { step: stepShown } : {}),
          ...(held.note ? { note: held.note } : {}),
        });
      } finally {
        await call("release");
      }
    }
  }
  const fonts = await call("fonts", places[places.length - 1].selector);
  return { ...base, shots, fonts, ...(notes.length ? { note: notes.join("\n") } : {}) };
}

const base64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
