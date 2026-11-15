// A published document, served directly: its page rendered on the domain itself, with no frame and no pages origin,
// as close to a static file as it gets. On the Erga domain, Erga's controls (the viewer's glass bars) may sit on top,
// in a shadow root of their own (the document's publishing setting). Every document still renders in a frame on its
// own origin in the viewer (server/documents/view.ts, pagesRoutes); a published one skips that because an admin put
// that version there: on the Erga domain its script runs on this site's own origin, where it acts as whoever views it.
//
// This file renders: a publish's page (`renderSite`) and the controls (`siteHeader`). publishing.ts keeps the
// published snapshot; serve.ts serves it.

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

/**
 * Where a snapshot's files are served on the Erga domain: /_home-files/<gen>/<path>, each address never reused, so
 * browsers keep them for good. Trap: the snapshots that are live name this path in their pages, so it stays.
 */
export const LIVE_FILES = "/_home-files/";

/** The page as published, split where the controls go (they differ for each person). */
export interface RenderedSite {
  before: string;
  after: string;
}

const MARK = "<!--erga:site-controls-->";
/** What the viewer's own page sets around a document: the same here, so the page lays out as it does there. */
const VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`;
/**
 * The controls' band (siteHeader): their height, 12px above and below them (more under a notch). The page starts below it,
 * so the controls never cover the top of it, as a document's always does. client/inline/site-controls.css has the same height.
 */
export const BAND = "calc(max(12px, env(safe-area-inset-top)) + 46px)";
/**
 * What a page gets in its head: it stops dead at its top and bottom, as the viewer's frame makes it
 * (server/pages/viewer.ts, HOST_SCRIPT's still). In the published page, BAND_SLOT is where serve.ts puts BAND_RULE for
 * a site with Erga's bars (withBand).
 */
const BAND_SLOT = "/*erga:band*/";
const STILL = `<style>html { overscroll-behavior: none; } ${BAND_SLOT}</style>`;
/**
 * Under Erga's bars the page starts below their band (the root's padding, which only moves it down, unlike a margin on
 * its body; in a rule the page's own can't outweigh), and anchors scroll to below the band too.
 */
const BAND_RULE = `html:root:root { padding-top: ${BAND} !important; scroll-padding-top: ${BAND}; }`;

/** A URL in the page, if it names one of the document's files: where that file is served in this snapshot. */
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

/** url(...) and @import "..." in CSS, pointed at the snapshot's files. */
function rewriteCss(css: string, to: (v: string) => string | null): string {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (m, q: string, v: string) => { const t = to(v); return t ? `url(${q}${t}${q})` : m; })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q: string, v: string) => { const t = to(v); return t ? `@import ${q}${t}${q}` : m; });
}

/** A srcset, each candidate's URL pointed at the snapshot's files. */
function rewriteSrcset(srcset: string, to: (v: string) => string | null): string {
  return srcset.split(",").map((part) => {
    const m = /^(\s*)(\S+)(.*)$/s.exec(part);
    if (!m) return part;
    const t = to(m[2]);
    return t ? `${m[1]}${t}${m[3]}` : part;
  }).join(",");
}

/**
 * A document's page, rendered for a publish: the page as it is, except that what the viewer's own page would give it
 * is given here (its viewport, its title, a page that doesn't bounce), and its files are linked where this snapshot
 * serves them (/_home-files/<gen>/<path>): every relative URL in an attribute that loads something, in srcset, and in
 * CSS, that names one of the document's files. Links to its other pages stay relative (they're served at the root
 * too: serve.ts). Its first script is window.ergaLLM, for document `doc` (client/inline/site-llm.ts). Throws if the
 * page isn't HTML.
 */
export async function renderSite(opts: {
  index: string;
  files: Record<string, string | Uint8Array>;
  gen: string;
  title: string;
  doc: string;
  /** The document's address in the viewer: where signing in for the page's model comes back to. */
  address: string;
}): Promise<RenderedSite> {
  const { index, gen } = opts;
  if (!/\.html?$/i.test(index)) throw new Error(`The document's page is ${index}: only an HTML page can be published.`);
  const raw = opts.files[index];
  if (raw == null) throw new Error(`The document's page (${index}) isn't there.`);
  const source = typeof raw == "string" ? raw : new TextDecoder().decode(raw);
  const files = new Set(Object.keys(opts.files));
  const prefix = `${LIVE_FILES}${gen}/`;
  let base = new URL(`https://site.invalid/${index.includes("/") ? index.slice(0, index.lastIndexOf("/") + 1) : ""}`);
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
  // And first, window.ergaLLM, the page's model, before any script of its own (client/inline/site-llm.ts), with the slot
  // for its page token, which serve.ts fills for each visitor (withToken).
  const extra = `${VIEWPORT}<script>${inlineCall("site-llm", opts.doc, TOKEN_SLOT, opts.address)}</script>${STILL}${titled ? "" : `<title>${esc(title)}</title>`}`;
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

/** The published page (renderSite's `before`) with its page token (llm-token.ts) in the slot. */
export const withToken = (before: string, token: string) => before.replace(JSON.stringify(TOKEN_SLOT), JSON.stringify(token));

/** The published page (renderSite's `before`) for a site with Erga's bars: it starts below their band. */
export const withBand = (before: string) => before.replace(BAND_SLOT, BAND_RULE);

/** Where a script goes in a page so that it runs first: after <head>, or after the doctype. */
const headStart = (html: string) => {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  return head ? head.index + head[0].length : /^\s*(<!doctype[^>]*>)?/i.exec(html)![0].length;
};

/**
 * Another HTML page of the site's (served as it is at its own path: serve.ts), with window.ergaLLM for document `doc`
 * and its page `token` before any script of its own, as the site's own page has it (renderSite). `address`: the
 * document's, in the viewer. `base`: where Erga's paths are ("/_erga" on a custom domain).
 */
export function withLlm(html: string, doc: string, token: string, address: string, base = ""): string {
  const at = headStart(html);
  return `${html.slice(0, at)}<script>${inlineCall("site-llm", doc, token, address, base)}</script>${html.slice(at)}`;
}

/**
 * Another HTML page of the site's with the controls (`header`, siteHeader) before its </body>, and a start below their
 * band, as the site's own page has (withBand), so they never cover the top of the page.
 */
export function withControls(html: string, header: string): string {
  const at = headStart(html);
  const still = `${html.slice(0, at)}<style>${BAND_RULE}</style>${html.slice(at)}`;
  const end = still.toLowerCase().lastIndexOf("</body>");
  return end < 0 ? still + header : still.slice(0, end) + header + still.slice(end);
}

/**
 * A published site's controls, over the page as on any document's viewer: the same two glass bars (barsHtml), with no Full
 * screen (there's no frame to fill the screen). They live in a shadow root (declarative, so they paint as soon as they
 * arrive, before any script), out of the page's styles' reach and the page out of theirs, on a host that resets whatever
 * the page's CSS could give it. The script then moves the host out of the page's <body> (so nothing the page does to its
 * body moves it) and runs the bars, the account menu and the tooltips.
 */
export function siteHeader(o: {
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
    tree: false,
    full: false,
    edit: o.edit ? editButton(o.edit, false) : "",
    corner: accountMarkup(o.account, o.here),
  });
  // The font goes outside the shadow root: a font declared inside one isn't used. Not when the page has its own Inter
  // (font: false, pageInter): the bars use the page's, and the browser loads one copy, not two.
  return `${o.font == false ? "" : crumbsFont(session, true)}<erga-controls${o.doc ? ` data-doc="${esc(o.doc)}"` : ""}><template shadowrootmode="open"><style>${inlineStyle("site-controls")}</style><div class="band"></div>${bars}${newDocMenu((path) => link(path, session), o.clone)}${VIEW_STYLE}${ACCOUNT_STYLE}${NEW_DOC_STYLE}<style>${SHADOW_BARS}</style></template></erga-controls>${inlineScript("site-controls")}`;
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
