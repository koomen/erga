// The homepage, served directly: the homepage's document (the
// landing_document setting) rendered on this site itself, with no frame and
// no pages origin, as close to a static file as it gets, and Erga's controls
// (the viewer's glass bars) on top, in a shadow root of their own. Every
// other document still renders in a frame on its own origin (server/documents/view.ts,
// pagesRoutes); the homepage may skip that only because only admins may edit
// it: its script runs on this
// site's own origin, where it could act as whoever views it.
//
// This file renders: a deploy's page (`renderHome`) and the controls
// (`homeHeader`). deploys.ts keeps the deployed snapshot and deploys it again
// after changes; serve.ts serves it at /; api.ts is the homepage's API.

import type { DocRow } from "../directory/index.ts";
import {
  ACCOUNT_STYLE,
  accountMarkup,
  barsHtml,
  crumbsFont,
  editButton,
  inlineCall,
  inlineScript,
  inlineStyle,
  link,
  NEW_DOC_STYLE,
  newDocMenu,
  VIEW_STYLE,
  type Account,
} from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { TOKEN_SLOT } from "./llm-token.ts";
import { headOf, tabTitle } from "../../shared/page-head.ts";

/** Where a deploy's files are served: /_home-files/<gen>/<path> (/_home is the homepage project's address), each address never reused, so browsers keep them for good. */
export const HOME_FILES = "/_home-files/";

/** The deploy's state, as GET /api/docs/<id>/home gives it (homeApi). A document that isn't the homepage is "idle". */
export interface DeployStatus {
  state: "idle" | "deploying" | "deployed" | "failed";
  /** The last successful deploy (ISO time), or null. */
  at: string | null;
  /** The version that's live (its number), or null. */
  version: number | null;
  /** Why the last deploy failed, while it's failed. */
  error: string | null;
  /** Who asked for the latest deploy: "ada", "ada, via their admin agent", or "the system" (a new homepage's first deploy). */
  by?: string | null;
}

export const IDLE: DeployStatus = { state: "idle", at: null, version: null, error: null };

/** The page as deployed, split where the controls go (they differ for each person). */
export interface RenderedHome { before: string; after: string }

const MARK = "<!--erga:home-controls-->";
/** What the viewer's own page sets around a document: the same here, so the page lays out as it does there. */
const VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`;
/**
 * The controls' band (homeHeader): their height, 12px above and below them (more under a notch). The page starts below it,
 * so the controls never cover the top of it, as a document's always does. client/inline/home-controls.css has the same height.
 */
export const BAND = "calc(max(12px, env(safe-area-inset-top)) + 46px)";
/**
 * What the page gets in its head: it starts below the controls' band (the root's padding, which only moves it down, unlike a
 * margin on its body; in a rule the page's own can't outweigh), anchors scroll to below the band too, and it stops dead at
 * its top and bottom, as the viewer's frame makes it (server/pages/viewer.ts, HOST_SCRIPT's still).
 */
const STILL = `<style>html { overscroll-behavior: none; } html:root:root { padding-top: ${BAND} !important; scroll-padding-top: ${BAND}; }</style>`;
const STILL_NO_BARS = `<style>html { overscroll-behavior: none; }</style>`;

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
 * where this deploy serves them (/_home-files/<gen>/<path>): every relative URL in
 * an attribute that loads something, in srcset, and in CSS, that names one of
 * the document's files. Links to its other pages stay relative (they're
 * served at the root too: serve.ts). Its first script is window.ergaLLM, for document `doc` (home-llm.ts). Throws if
 * the page isn't HTML.
 */
export async function renderHome(opts: {
  index: string;
  files: Record<string, string | Uint8Array>;
  gen: string;
  title: string;
  doc: string;
  /** Erga's bars on top (site.json): the page starts below their band. */
  bars?: boolean;
}): Promise<RenderedHome> {
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
  // Its own head: the tab's title as the viewer gives it (the page's own <title>, else the document's title).
  const head = /<head[\s>]/i.test(source);
  const headPart = source.slice(0, Math.max(0, source.search(/<body[\s>]/i)) || source.length);
  const titled = /<title[\s>]/i.test(headPart);
  const title = tabTitle(headOf(source), opts.title);
  // And first, window.ergaLLM, the page's model, before any script of its own (client/inline/home-llm.ts), with the slot
  // for its page token, which serve.ts fills for each visitor (withToken).
  const extra = `${VIEWPORT}<script>${inlineCall("home-llm", opts.doc, TOKEN_SLOT)}</script>${opts.bars == false ? STILL_NO_BARS : STILL}${titled ? "" : `<title>${esc(title)}</title>`}`;
  let css = "", titleDone = false;
  const rewriter = new HTMLRewriter()
    .on("base[href]", {
      element(e) {
        try {
          base = new URL(e.getAttribute("href")!, base);
        } catch {
          /* not a URL */
        }
      },
    })
    .on('meta[name="viewport" i]', {
      element(e) {
        e.remove();
      },
    })
    .on("head > title", {
      element(e) {
        if (!titleDone) {
          titleDone = true;
          e.setInnerContent(title);
        }
      },
    })
    .on('meta[property="og:image" i][content], meta[name="twitter:image" i][content]', attr("content"))
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

/** The deployed homepage's page (renderHome's `before`) with its page token (llm-token.ts) in the slot. */
export const withToken = (before: string, token: string) => before.replace(JSON.stringify(TOKEN_SLOT), JSON.stringify(token));

/**
 * Another HTML page of the homepage's (served as it is at its own path: serve.ts), with window.ergaLLM for document
 * `doc` and its page `token` before any script of its own, as the homepage's own page has it (renderHome).
 */
export function withHomeLlm(html: string, doc: string, token: string): string {
  const script = `<script>${inlineCall("home-llm", doc, token)}</script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  const at = head ? head.index + head[0].length : /^\s*(<!doctype[^>]*>)?/i.exec(html)![0].length;
  return html.slice(0, at) + script + html.slice(at);
}

/**
 * The homepage's controls, over the page as on any document's viewer: the same two glass bars (barsHtml), with no Full
 * screen (there's no frame to fill the screen). They live in a shadow root (declarative, so they paint as soon as they
 * arrive, before any script), out of the page's styles' reach and the page out of theirs, on a host that resets whatever
 * the page's CSS could give it. The script then moves the host out of the page's <body> (so nothing the page does to its
 * body moves it) and runs the bars, the account menu and the tooltips.
 */
export function homeHeader(o: {
  clone: string;
  edit: string | null;
  account: Account | null;
  here: string;
  doc?: string;
  font?: boolean;
}): string {
  const session = o.account?.session ?? null;
  const bars = barsHtml({
    session,
    title: null,
    project: false,
    full: false,
    edit: o.edit ? editButton(o.edit, false) : "",
    corner: accountMarkup(o.account, o.here),
  });
  // The font goes outside the shadow root: a font declared inside one isn't used. Not when the page has its own Inter
  // (font: false, pageInter): the bars use the page's, and the browser loads one copy, not two.
  return `${o.font == false ? "" : crumbsFont(session, true)}<erga-controls${o.doc ? ` data-doc="${esc(o.doc)}"` : ""}><template shadowrootmode="open"><style>${inlineStyle("home-controls")}</style><div class="band"></div>${bars}${newDocMenu((path) => link(path, session), o.clone)}${VIEW_STYLE}${ACCOUNT_STYLE}${NEW_DOC_STYLE}<style>${SHADOW_BARS}</style></template></erga-controls>${inlineScript("home-controls")}`;
}

/** Whether a page declares the typeface Inter itself (an @font-face rule for it), which the bars can then use. */
export const pageInter = (html: string) => /@font-face\s*\{[^}]*font-family:\s*(["']?)Inter\1\s*[;}]/i.test(html);

/**
 * The bars' look (client/inline/bars.css) inside the controls' shadow root, where the page's <html> and <body> can't be
 * named: what it says of them, said of the host (the script gives it the page's tone, page-dark or page-light, and
 * quick-open).
 */
export const SHADOW_BARS = inlineStyle("bars")
  .replace(/html\.(page-[a-z]+) body:not\(\.source\)/g, ":host(.$1)")
  .replace(/html\.(page-[a-z]+)/g, ":host(.$1)")
  .replace(/\bhtml /g, ":host ")
  .replace(/:root/g, ":host")
  .replace(/body\.quick-open/g, ":host(.quick-open)")
  .replace(/body:not\(\.quick-open\)/g, ":host(:not(.quick-open))");
if (/\b(html|body)\b|:root/.test(SHADOW_BARS))
  throw new Error("client/inline/bars.css names the page's <html> or <body> in a way SHADOW_BARS doesn't turn into the host");


