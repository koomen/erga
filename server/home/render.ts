// The homepage, served directly: the front page's document (the
// landing_document setting) rendered on this site itself, with no frame and
// no pages origin, as close to a static file as it gets, and Erga's controls
// (Clone, Edit, who you are) on top, in a shadow root of their own. Every
// other document still renders in a frame on its own origin (server/documents/view.ts,
// pagesDoor); the homepage may skip that only because only admins may edit
// it: its script runs on this
// site's own origin, where it could act as whoever views it.
//
// This file renders: a deploy's page (`renderHome`) and the controls
// (`homeHeader`). deploys.ts keeps the deployed snapshot and deploys it again
// after changes; serve.ts serves it at /; api.ts is the homepage's API.

import type { DocRow } from "../directory/index.ts";
import { imgFallbackScript } from "../pages/index.ts";
import { ACCOUNT_STYLE, accountMarkup, cloneButton, crumbsFont, editButton, esc, FADE, filesButton, link, NEW_DOC_SCRIPT, NEW_DOC_STYLE, newDocButton, newDocMenu, VIEW_STYLE, viewCrumbs, type Account } from "../pages/index.ts";

/** Where a deploy's files are served: /_home/<gen>/<path>, each address never reused, so browsers keep them for good. */
export const HOME_FILES = "/_home/";

/** The deploy's state, as GET /api/docs/<id>/home gives it (homeApi). A document that isn't the homepage is "idle". */
export interface DeployStatus {
  state: "idle" | "scheduled" | "deploying" | "deployed" | "failed";
  /** The last successful deploy (ISO time), or null. */
  at: string | null;
  /** When the next deploy runs, while one is scheduled. */
  scheduledFor: string | null;
  /** The version that's live (its number), or null. */
  version: number | null;
  /** Why the last deploy failed, while it's failed. */
  error: string | null;
  /** Who asked for the latest deploy: "ada", "ada, via their admin agent", or "the system" (one after a new version, or a new homepage). */
  by?: string | null;
}

export const IDLE: DeployStatus = { state: "idle", at: null, scheduledFor: null, version: null, error: null };

/** The page as deployed, split where the controls go (they differ for each person). */
export interface RenderedHome { before: string; after: string }

const MARK = "<!--erga:home-controls-->";
/** What the viewer's own page sets around a document: the same here, so the page lays out as it does there. */
const VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`;
/**
 * The controls' band (homeHeader): their height, 12px above and below them (more under a notch). The page starts below it,
 * so the controls never cover the top of it, as a document's always does (task #38).
 */
export const BAND = "calc(max(12px, env(safe-area-inset-top)) + 46px)";
/**
 * What the page gets in its head: it starts below the controls' band (the root's padding, which only moves it down, unlike a
 * margin on its body; in a rule the page's own can't outweigh), anchors scroll to below the band too, and it stops dead at
 * its top and bottom, as the viewer's frame makes it (server/pages/frame-host.ts, HOST_SCRIPT's still).
 */
const STILL = `<style>html { overscroll-behavior: none; } html:root:root { padding-top: ${BAND} !important; scroll-padding-top: ${BAND}; }</style>`;

/** A URL in the page, if it names one of the document's files: where that file is served in this deploy. */
function fileUrl(value: string, base: URL, files: Set<string>, prefix: string): string | null {
  const v = value.trim();
  if (!v || v.startsWith("#") || v.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  let u: URL;
  try { u = new URL(v, base); } catch { return null; }
  if (u.origin != base.origin) return null;
  let path: string;
  try { path = decodeURIComponent(u.pathname.slice(1)); } catch { return null; }
  if (!files.has(path)) return null;
  return prefix + path.split("/").map(encodeURIComponent).join("/") + u.search + u.hash;
}

/** url(...) and @import "..." in CSS, pointed at the deploy's files. */
function rewriteCss(css: string, to: (v: string) => string | null): string {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (m, q: string, v: string) => { const t = to(v); return t ? `url(${q}${t}${q})` : m; })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q: string, v: string) => { const t = to(v); return t ? `@import ${q}${t}${q}` : m; });
}

/** A srcset, each candidate's URL pointed at the deploy's files. */
function rewriteSrcset(srcset: string, to: (v: string) => string | null): string {
  return srcset.split(",").map((part) => {
    const m = /^(\s*)(\S+)(.*)$/s.exec(part);
    if (!m) return part;
    const t = to(m[2]);
    return t ? `${m[1]}${t}${m[3]}` : part;
  }).join(",");
}

/**
 * The homepage's page, rendered for a deploy: the document's page as it is,
 * except that what the viewer's own page would give it is given here (its
 * viewport, its title, a page that doesn't bounce), and its files are linked
 * where this deploy serves them (/_home/<gen>/<path>): every relative URL in
 * an attribute that loads something, in srcset, and in CSS, that names one of
 * the document's files. Links to its other pages stay relative (they're
 * served at the root too: serve.ts). Throws if the page isn't HTML.
 */
export async function renderHome(opts: { index: string; files: Record<string, string | Uint8Array>; gen: string; title: string }): Promise<RenderedHome> {
  const { index, gen } = opts;
  if (!/\.html?$/i.test(index)) throw new Error(`The homepage's page is ${index}: only an HTML page can be served directly, so / shows it in the viewer.`);
  const raw = opts.files[index];
  if (raw == null) throw new Error(`The homepage's page (${index}) isn't there.`);
  const source = typeof raw == "string" ? raw : new TextDecoder().decode(raw);
  const files = new Set(Object.keys(opts.files));
  const prefix = `${HOME_FILES}${gen}/`;
  let base = new URL(`https://home.invalid/${index.includes("/") ? index.slice(0, index.lastIndexOf("/") + 1) : ""}`);
  const to = (v: string) => fileUrl(v, base, files, prefix);
  const attr = (name: string): Parameters<HTMLRewriter["on"]>[1] => ({
    element(e) {
      const v = e.getAttribute(name);
      const t = v == null ? null : name == "srcset" ? rewriteSrcset(v, to) : name == "style" ? rewriteCss(v, to) : to(v);
      if (t != null && t != v) e.setAttribute(name, t);
    },
  });
  // Its own head: a title for the tab as the viewer gives it (the document's title), unless it names none at all.
  const head = /<head[\s>]/i.test(source);
  const headPart = source.slice(0, Math.max(0, source.search(/<body[\s>]/i)) || source.length);
  const titled = /<title[\s>]/i.test(headPart);
  const extra = `${VIEWPORT}${STILL}${titled ? "" : `<title>${esc(opts.title)}</title>`}`;
  let css = "", titleDone = false;
  const rewriter = new HTMLRewriter()
    .on("base[href]", { element(e) { try { base = new URL(e.getAttribute("href")!, base); } catch { /* not a URL */ } } })
    .on('meta[name="viewport" i]', { element(e) { e.remove(); } })
    .on("head > title", { element(e) { if (!titleDone) { titleDone = true; e.setInnerContent(opts.title); } } })
    .on("img[src], script[src], iframe[src], embed[src], source[src], track[src], audio[src], video[src], input[src]", attr("src"))
    .on("img[srcset], source[srcset]", attr("srcset"))
    .on("video[poster]", attr("poster"))
    .on("link[href], image[href], use[href], feImage[href]", attr("href"))
    .on("image[xlink\\:href], use[xlink\\:href]", attr("xlink:href"))
    .on("object[data]", attr("data"))
    .on("[style]", attr("style"))
    .on("style", {
      text(t) {
        css += t.text;
        if (t.lastInTextNode) { t.replace(rewriteCss(css, to), { html: true }); css = ""; } else t.remove();
      },
    })
    .on("body", { element(e) { e.onEndTag((end) => { end.before(MARK, { html: true }); }); } });
  if (head) rewriter.on("head", { element(e) { e.prepend(extra, { html: true }); } });
  let html = await rewriter.transform(new Response(source, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();
  // No <head> of its own: what it would have gets in just after the doctype (before it, the page would be in quirks mode).
  if (!head) {
    const doctype = /^\s*(<!doctype[^>]*>)?/i.exec(html)![0].length;
    html = html.slice(0, doctype) + extra + html.slice(doctype);
  }
  let at = html.indexOf(MARK);
  if (at < 0) {
    // No </body> written out: before </html>, or at the very end.
    const end = html.toLowerCase().lastIndexOf("</html>");
    at = end >= 0 ? end : html.length;
    return { before: html.slice(0, at), after: html.slice(at) };
  }
  return { before: html.slice(0, at), after: html.slice(at + MARK.length) };
}

/**
 * The homepage's controls, over the page as on any document's viewer:
 *New document, Clone, Files and Edit for those who may edit it, and who
 * you are. They live in a shadow root (declarative, so they
 * paint as soon as they arrive, before any script), out of the page's
 * styles' reach and the page out of theirs, on a host that resets whatever
 * the page's CSS could give it. The script then moves the host out of the
 * page's <body> (so nothing the page does to its body moves it) and runs the
 * account menu and the tooltips.
 */
export function homeHeader(o: { clone: string; edit: string | null; files?: string | null; account: Account | null; here: string; doc?: string }): string {
  const session = o.account?.session ?? null;
  const buttons = `<div class="erga-view-buttons">${newDocButton("erga-view-button")}${cloneButton(o.clone)}${o.files ? filesButton(o.files) : ""}${o.edit ? editButton(o.edit, false) : ""}</div>${newDocMenu((path) => link(path, session), !!session && !session.test)}`;
  // The font goes outside the shadow root: a font declared inside one isn't used.
  return `${crumbsFont(session)}<erga-controls${o.doc ? ` data-doc="${esc(o.doc)}"` : ""}><template shadowrootmode="open"><style>${HOST_STYLE}</style><div class="band"></div>${viewCrumbs(session, null)}${buttons}${accountMarkup(o.account, o.here)}${VIEW_STYLE}${ACCOUNT_STYLE}${NEW_DOC_STYLE}</template></erga-controls><script>${HEADER_SCRIPT}</script>`;
}

// The host: nothing of the page's applies to it (its own !important rules win over the page's, from inside the shadow root).
// Fixed, the width of the window (scrollbar included, as the viewer's controls sit over the frame's scrollbar), no height.
// On a phone they stay at the top of the page, as the viewer's do.
const HOST_STYLE = `:host { all: initial !important; display: block !important; position: fixed !important; top: 0 !important; left: 0 !important;
  right: calc(-1 * var(--erga-scrollbar, 0px)) !important; width: auto !important; height: 0 !important; margin: 0 !important; padding: 0 !important;
  z-index: 2147483647 !important; contain: none !important; transform: none !important; filter: none !important; visibility: visible !important; opacity: 1 !important; }
@media (max-width: 640px), (max-height: 480px) { :host { position: absolute !important; } }
/* The band the controls sit in, above the page (which starts below it: STILL), in the page's own background (the script
   sets it; until then it's see-through, over the page's padding, which shows the same colour). */
.band { position: absolute; top: 0; left: 0; right: 0; height: ${BAND}; background: var(--erga-band, transparent); }`;

const HEADER_SCRIPT = `(() => {
  const host = document.currentScript.previousElementSibling;
  let root = host.shadowRoot;
  // A browser without declarative shadow roots: made here instead.
  if (!root) { const t = host.querySelector("template"); if (!t) return; root = host.attachShadow({ mode: "open" }); root.append(t.content); t.remove(); }
  ${imgFallbackScript("root")}
  document.documentElement.append(host);
  const bar = () => host.style.setProperty("--erga-scrollbar", Math.max(0, innerWidth - document.documentElement.clientWidth) + "px");
  bar();
  addEventListener("resize", bar);
  addEventListener("load", bar);
  if (window.ResizeObserver) new ResizeObserver(bar).observe(document.documentElement);
  // The band takes the page's background: its root's, else its body's (which the root shows), else the canvas's.
  const clear = (c) => !c || c == "transparent" || /^rgba\(.*,\s*0\)$/.test(c);
  const band = () => {
    let c = "";
    for (const el of [document.documentElement, document.body]) { const b = el && getComputedStyle(el).backgroundColor; if (!clear(b)) { c = b; break; } }
    host.style.setProperty("--erga-band", c || "Canvas");
  };
  band();
  addEventListener("load", band);
  new MutationObserver(band).observe(document.documentElement, { attributes: true, subtree: false });
  if (document.body) new MutationObserver(band).observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", band);
  // Who you are (server/pages/account-menu.ts's corner): its menu opens and closes as everywhere else on the site.
  const acc = root.querySelector(".erga-account"), btn = acc && acc.querySelector("button"), menu = acc && acc.querySelector(".erga-account-menu");
  if (btn && menu) {
    const show = (open) => { menu.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
    btn.addEventListener("click", () => { show(menu.hidden); if (!menu.hidden) menu.querySelector("a")?.focus({ preventScroll: true }); });
    document.addEventListener("pointerdown", (e) => { if (!e.composedPath().includes(acc)) show(false); });
    document.addEventListener("keydown", (e) => { if (e.key == "Escape" && !menu.hidden) { show(false); btn.focus(); } });
    addEventListener("blur", () => show(false));
  }
  // New document's picker.
  ${NEW_DOC_SCRIPT}
  ergaNewDoc(root);
  // The controls fade once the page is scrolled, as on any document's page: on the host, whose own opacity
  // the page can't touch; the band stays as it is.
  ${FADE}
  const fade = ergaFade(host, root);
  const scrolled = () => fade.scroll(scrollY);
  addEventListener("scroll", scrolled, { passive: true });
  scrolled();
  document.addEventListener("pointermove", (e) => { if (e.pointerType == "mouse") fade.pointer(e.clientX, e.clientY, false); }, { capture: true, passive: true });
  document.addEventListener("pointerdown", (e) => { if (e.pointerType != "mouse") fade.pointer(e.clientX, e.clientY, true); }, { capture: true, passive: true });
  document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) fade.leave(); });
  // Tooltips follow the pointer while it's on a control.
  root.addEventListener("pointermove", (e) => {
    const el = e.pointerType == "mouse" && e.target.closest?.("[data-tip]");
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--tip-x", e.clientX - r.left - 6 + "px");
    el.style.setProperty("--tip-y", e.clientY - r.top + 30 + "px");
  }, { passive: true });
})();`;

/** The document's address, for its Edit link. */
export const addressOf = (doc: Pick<DocRow, "owner" | "slug">) => `/${doc.owner}/${doc.slug}`;
