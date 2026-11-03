// The editor's own controls on the page: the style bar over a selection (bold, italic, code, link, clear formatting),
// the link bar, and a note that says why something can't be done. They
// draw inside the page, in a shadow root of their own on its <html> (an erga- element: the editor's, which its walks
// and its check pass by), with the editor's own look whatever the page's styles are; on a dark page, its dark look.
// Their events stay theirs: the page's own handlers and the editor's below them never see them.

import type { InlineStyle } from "../api/source";
import type { LinkEdit, LinkInfo } from "./types";
import { linkTarget, type Place } from "../../../client/common/link-target";
import { TOP_ROOM } from "../../../client/common/top-room";

/** What the controls ask of the editor on the page. */
export interface ControlsPage {
  selectionRect(): { left: number; top: number; width: number; bottom: number } | null;
  linkAt(): LinkInfo | null;
  styleBlocker(): string | null;
  hasStyle(style: InlineStyle): boolean;
  selectedText(): string;
  toggleStyle(style: InlineStyle): string | null;
  clearStyles(): string | null;
  setLink(edit: LinkEdit): string | null;
  readonly state: { selection: { main: { anchor: number; head: number } } };
  focus(): void;
}

/** The controls' look, which a library's own controls share (libs/slides/ui/bar.ts). */
export const STYLE = `
:host { all: initial; }
.c { --bg: #ffffff; --fg: #1c1c1f; --soft: #6b6b73; --chrome: #a1a1a9; --chrome-hover: #3f3f46; --rule: #e6e6ea;
  --caret: #3b7cf0; --link: #2563c9; --panel-border: #e6e6ea; --shadow: 0 8px 30px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04);
  --font: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; --ease: cubic-bezier(0.65, 0, 0.35, 1); --morph-ms: 240ms;
  font: 13px/1 var(--font); color: var(--fg); color-scheme: light; }
.c.dark { --bg: #18181b; --fg: #cacad2; --soft: #8f8f99; --chrome: #6c6c75; --chrome-hover: #d4d4da; --rule: #2c2c31;
  --caret: #6aa1ff; --link: #7aa9ff; --panel-border: #2f2f35; --shadow: 0 10px 34px rgba(0, 0, 0, 0.45); color-scheme: dark; }
.card { position: fixed; z-index: 2147483646; background: var(--bg); border: 1px solid var(--panel-border); box-shadow: var(--shadow); }
.fmt { padding: 4px; border-radius: 10px; transform: translate(-50%, calc(-100% - 8px)); }
.fmt.below { transform: translate(-50%, 8px); }
[hidden] { display: none !important; }
button { width: 30px; height: 28px; border: 0; border-radius: 7px; background: transparent; color: var(--chrome-hover);
  display: grid; place-items: center; cursor: pointer; font: inherit; padding: 0; flex: none; }
button:hover { background: color-mix(in srgb, var(--chrome) 14%, transparent); }
button[aria-pressed="true"] { background: color-mix(in srgb, var(--caret) 16%, transparent); color: var(--caret); }
button[aria-disabled="true"] { opacity: 0.35; cursor: not-allowed; }
button:focus-visible { outline: 2px solid var(--caret); outline-offset: -2px; }
button b { font-weight: 700; font-size: 14px; }
button i { font-family: Georgia, serif; font-size: 15px; }
svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.sep { width: 1px; height: 16px; background: var(--rule); margin: 0 2px; flex: none; }
.panes { position: relative; }
.pane { display: flex; align-items: center; gap: 2px; }
.fmt.morphing .panes { overflow: hidden; transition: width var(--morph-ms) var(--ease), height var(--morph-ms) var(--ease); }
.fmt.morphing .pane { display: flex; position: absolute; left: 50%; bottom: 0; translate: -50% 0; }
.fmt.morphing.below .pane { bottom: auto; top: 0; }
.fmt.morphing .pane.out { opacity: 0; scale: 0.96; transition: opacity calc(var(--morph-ms) * 0.5) ease, scale var(--morph-ms) var(--ease); pointer-events: none; }
.fmt.morphing .pane.in { animation: pane-in var(--morph-ms) var(--ease) both; animation-delay: calc(var(--morph-ms) * 0.25); }
@keyframes pane-in { from { opacity: 0; scale: 0.97; } }
.fmt.appear { animation: appear 140ms ease both; }
@keyframes appear { from { opacity: 0; } }
.link { flex-direction: column; align-items: stretch; gap: 0; width: 300px; }
.row { display: flex; align-items: center; gap: 2px; height: 32px; }
.row + .row { border-top: 1px solid var(--rule); }
.lead { width: 30px; height: 28px; display: grid; place-items: center; color: var(--chrome); flex: none; }
.lead.t { font: 600 13px var(--font); letter-spacing: -0.02em; }
.row input { flex: 1; min-width: 0; height: 28px; border: 0; outline: none; background: transparent; color: var(--fg); font: 13px var(--font); padding: 0 6px 0 2px; }
.row input::placeholder { color: var(--chrome); }
.row input[type=url] { color: var(--link); }
button.x { color: var(--chrome); }
button.x:hover { color: var(--chrome-hover); }
button.tab { width: 100%; height: 28px; display: flex; align-items: center; justify-content: flex-start; gap: 2px; padding: 0 6px 0 0; }
.tab .label { flex: 1; text-align: left; color: var(--soft); }
.switch { width: 28px; height: 16px; border-radius: 999px; background: var(--rule); position: relative; flex: none; transition: background 140ms ease; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--bg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); transition: translate 160ms var(--ease); }
.tab[aria-checked="true"] .switch { background: var(--caret); }
.tab[aria-checked="true"] .switch::after { translate: 12px 0; }
.pill { left: 50%; bottom: 20px; transform: translateX(-50%); width: auto; height: auto; padding: 8px 14px; border-radius: 999px;
  font: 13px/1.3 var(--font); color: var(--fg); white-space: nowrap; }
.pill b { color: var(--caret); font-weight: 600; }
.note { left: 50%; bottom: 20px; transform: translateX(-50%); max-width: min(480px, calc(100vw - 32px)); padding: 10px 14px;
  border-radius: 10px; font: 13px/1.45 var(--font); animation: appear 140ms ease both; }
@media (pointer: coarse) {
  .fmt button { width: 38px; height: 36px; }
  .row { height: 40px; }
  button.tab { height: 36px; }
  .link { width: min(340px, calc(100vw - 48px)); }
  .row input { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .fmt.morphing .panes { transition: none; }
  .fmt.morphing .pane.in { animation: appear 120ms ease both; }
}
`;

const ICON = {
  code: '<path d="m8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  clear: '<path d="M5.5 5.5h11M11 5.5v13"/><path d="m15 14.5 5 5M20 14.5l-5 5"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  open: '<path d="M14 5h5v5M19 5l-8 8"/><path d="M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4"/>',
  unlink:
    '<path d="M9.5 14.5 8 16a3 3 0 0 1-4.24-4.24L5.5 10"/><path d="M14.5 9.5 16 8a3 3 0 0 1 4.24 4.24L18.5 14"/><path d="M4 4l16 16"/>',
  tab: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16"/>',
};
const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

const HTML = `
<div class="card fmt" id="fmt" hidden role="toolbar" aria-label="Text style">
  <div class="panes" id="panes">
    <div class="pane" id="style">
      <button type="button" data-style="strong" aria-label="Bold (⌘B)" title="Bold  ⌘B"><b>B</b></button>
      <button type="button" data-style="em" aria-label="Italic (⌘I)" title="Italic  ⌘I"><i>I</i></button>
      <button type="button" data-style="code" aria-label="Code (⌘E)" title="Code  ⌘E">${svg(ICON.code)}</button>
      <span class="sep" aria-hidden="true"></span>
      <button type="button" data-act="link" aria-label="Link (⌘⇧K)" title="Link  ⌘⇧K">${svg(ICON.link)}</button>
      <span class="sep" aria-hidden="true"></span>
      <button type="button" data-act="clear" aria-label="Clear formatting (⌘\\)" title="Clear formatting  ⌘\\">${svg(ICON.clear)}</button>
    </div>
    <div class="pane link" id="link" role="group" aria-label="Link" hidden>
      <div class="row">
        <span class="lead t" aria-hidden="true">Aa</span>
        <input id="link-text" type="text" aria-label="Link text" placeholder="Text" autocomplete="off">
        <button type="button" class="x" data-link="close" aria-label="Close the link bar (Esc)" title="Close  Esc">${svg(ICON.close)}</button>
      </div>
      <div class="row">
        <span class="lead" id="link-icon" aria-hidden="true">${svg(ICON.link)}</span>
        <input id="link-url" type="url" aria-label="Link address" placeholder="Paste a link, Enter to apply" spellcheck="false" autocomplete="off">
        <button type="button" data-link="open" aria-label="Open the link in a new tab" title="Open link in a new tab">${svg(ICON.open)}</button>
        <button type="button" data-link="remove" aria-label="Remove the link" title="Remove link">${svg(ICON.unlink)}</button>
      </div>
      <div class="row">
        <button type="button" class="tab" data-link="tab" role="switch" aria-checked="true">
          <span class="lead" aria-hidden="true">${svg(ICON.tab)}</span><span class="label">Opens in a new tab</span><span class="switch" aria-hidden="true"></span>
        </button>
      </div>
    </div>
  </div>
</div>
<div class="card note" id="note" role="status" hidden></div>
<button type="button" class="card pill" id="refresh-pill" hidden></button>`;

/** Events that stay in the controls: neither the page's own handlers nor the editor's see them. */
const KEPT = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "paste",
  "copy",
  "cut",
  "wheel",
];

/** The controls, on the page in `win`: `place` says where links on it go (client/common/link-target.ts), `zoom` the shell's zoom. */
export function mountControls(win: Window, page: ControlsPage, o: { place: () => Place | null; zoom: () => number }) {
  const doc = win.document;
  const host = doc.createElement("erga-controls");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}</style><div class="c" id="c">${HTML}</div>`;
  doc.documentElement.append(host);
  for (const type of KEPT) root.addEventListener(type, (e) => e.stopPropagation());
  const $ = (id: string) => root.getElementById(id)!;
  const box = $("c"),
    fmt = $("fmt"),
    panes = $("panes"),
    stylePane = $("style"),
    linkPane = $("link");
  const linkText = $("link-text") as HTMLInputElement,
    linkUrl = $("link-url") as HTMLInputElement;
  const linkTab = fmt.querySelector<HTMLButtonElement>("[data-link=tab]")!,
    linkRemove = fmt.querySelector<HTMLButtonElement>("[data-link=remove]")!;
  const coarse = win.matchMedia("(pointer: coarse)"),
    still = win.matchMedia("(prefers-reduced-motion: reduce)");
  let pointerDown = false,
    queued = false,
    morphing = false;
  /** The link bar is open from a selection (the focus is in it), or from the caret in a link; or not open. */
  let linking: "selection" | "caret" | null = null;
  /** The link bar was closed while the caret is in a link: it stays closed until the caret leaves links, or a click. */
  let linkDismissed = false;
  /** The selection the link bar opened on: its changes go there, even after a click has moved the caret. */
  let linkSel: { anchor: number; head: number } | undefined;
  const pageSel = () => {
    const m = page.state.selection.main;
    return { anchor: m.anchor, head: m.head };
  };
  // The shell draws the page's frame zoomed (zoom.ts): the controls stay their own size.
  const unzoom = () => {
    host.style.zoom = String(1 / o.zoom());
  };

  // ------------------------------------------------------------ the note

  let noteTimer = 0;
  function explain(message: string) {
    const note = $("note");
    note.textContent = message;
    note.hidden = false;
    win.clearTimeout(noteTimer);
    noteTimer = win.setTimeout(() => {
      note.hidden = true;
    }, 4000);
  }

  // ------------------------------------------------------------ the style bar

  function queue() {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(() => {
      queued = false;
      render();
    });
  }
  function hide() {
    fmt.hidden = true;
    linking = null;
    stylePane.hidden = false;
    linkPane.hidden = true;
  }
  function place(rect: { left: number; top: number; width: number; bottom: number }) {
    const z = o.zoom();
    // On touch, the system's own copy and paste menu takes the space above a selection. Above the text, the bar (the
    // style bar about 46 px with its gap, the link bar about 114) must clear the shell's bars, which float over the
    // page's top: under them, a click on Bold is the shell's.
    const top = rect.top * z;
    const below = top < TOP_ROOM + (linking ? 114 : 46) || coarse.matches;
    const half = (linking ? 300 : coarse.matches ? 220 : 200) / 2 + 10;
    const width = win.innerWidth * z;
    fmt.style.left = Math.max(half, Math.min(width - half, (rect.left + rect.width / 2) * z)) + "px";
    fmt.style.top = (below ? rect.bottom : rect.top) * z + "px";
    fmt.classList.toggle("below", below);
  }
  /** Shows one pane: at once if the bar was hidden, else changing the other into it. */
  function showPane(pane: HTMLElement) {
    const from = pane == stylePane ? linkPane : stylePane;
    if (fmt.hidden) {
      from.hidden = true;
      pane.hidden = false;
      fmt.hidden = false;
      fmt.classList.remove("appear");
      void fmt.offsetWidth;
      fmt.classList.add("appear");
    } else if (!pane.hidden && from.hidden) return;
    else morph(from, pane);
  }
  function morph(from: HTMLElement, to: HTMLElement) {
    morphing = true;
    const ms = still.matches ? 120 : 240;
    const w0 = panes.offsetWidth,
      h0 = panes.offsetHeight;
    const icon0 = to == linkPane ? fmt.querySelector("[data-act=link] svg")!.getBoundingClientRect() : null;
    from.hidden = true;
    to.hidden = false;
    const w1 = panes.offsetWidth,
      h1 = panes.offsetHeight;
    from.hidden = false;
    fmt.classList.add("morphing");
    from.classList.add("out");
    to.classList.add("in");
    panes.style.width = w0 + "px";
    panes.style.height = h0 + "px";
    void panes.offsetWidth;
    panes.style.width = w1 + "px";
    panes.style.height = h1 + "px";
    if (icon0 && !still.matches)
      win.requestAnimationFrame(() => {
        const icon = $("link-icon").querySelector("svg")!,
          icon1 = icon.getBoundingClientRect();
        icon.animate(
          [
            { transform: `translate(${icon0.left - icon1.left}px, ${icon0.top - icon1.top}px)`, color: "var(--caret)" },
            { transform: "none" },
          ],
          { duration: ms, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "backwards" }
        );
      });
    win.setTimeout(() => {
      from.hidden = true;
      from.classList.remove("out");
      to.classList.remove("in");
      fmt.classList.remove("morphing");
      panes.style.width = panes.style.height = "";
      morphing = false;
      queue();
    }, ms * 1.25);
  }
  function render() {
    unzoom();
    if (linking == "selection" || morphing || linkPane.contains(root.activeElement)) return;
    if (pointerDown) {
      hide();
      return;
    }
    const rect = page.selectionRect(),
      link = page.linkAt();
    if (!link) linkDismissed = false;
    if (rect) {
      linking = null;
      place(rect);
      const why = page.styleBlocker();
      for (const b of stylePane.querySelectorAll<HTMLButtonElement>("button")) {
        b.setAttribute("aria-disabled", String(!!why));
        b.dataset.why = why ?? "";
        if (b.dataset.style) b.setAttribute("aria-pressed", String(!why && page.hasStyle(b.dataset.style as InlineStyle)));
        if (b.dataset.act == "link") b.setAttribute("aria-pressed", String(!why && link != null));
        b.title = why ?? b.getAttribute("aria-label")!.replace(/ \((.+)\)$/, "  $1");
      }
      showPane(stylePane);
    } else if (link?.rect && link.inside && !linkDismissed) {
      linking = "caret";
      linkSel = pageSel();
      fillLink(link.text, link);
      place(link.rect);
      showPane(linkPane);
    } else hide();
  }
  function setLinkTab(newTab: boolean) {
    linkTab.setAttribute("aria-checked", String(newTab));
    linkTab.querySelector(".label")!.textContent = newTab ? "Opens in a new tab" : "Opens in this tab";
  }
  function fillLink(text: string, link: { href: string; self: boolean } | null) {
    linkText.value = text;
    linkUrl.value = link?.href ?? "";
    linkRemove.hidden = !link;
    setLinkTab(!link?.self);
  }
  /** The link button, or ⌘⇧K: the link bar for the selection, or the focus to the address of the caret's link. */
  function openLink() {
    if (linking) {
      linkUrl.focus();
      linkUrl.select();
      return;
    }
    const why = page.styleBlocker();
    if (why) {
      explain(why);
      return;
    }
    if (fmt.hidden) render();
    if (fmt.hidden) return;
    const link = page.linkAt();
    linking = "selection";
    linkSel = pageSel();
    fillLink(link?.text ?? page.selectedText(), link);
    const rect = page.selectionRect();
    if (rect) place(rect);
    showPane(linkPane);
    (link ? linkText : linkUrl).focus();
    (link ? linkText : linkUrl).select();
  }
  /** An address as typed: one with no scheme that looks like a site's gets https://. */
  function linkAddress(url: string): string {
    url = url.trim();
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || /^[#/?.]/.test(url)) return url;
    return /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(url) ? "https://" + url : url;
  }
  /** Where the open button takes a link's address, read as the page reads it (client/common/link-target.ts). A mail address as it is. */
  function openable(href: string): string | null {
    if (/^mailto:/i.test(href)) return href;
    const p = o.place();
    let url: URL;
    try {
      url = new URL(href, win.location.href);
    } catch {
      return null;
    }
    if (!p) return url.href;
    const to = linkTarget(url, p);
    return to.kind == "page" ? to.public : to.kind == "erga" || to.kind == "out" ? to.url : to.kind == "file" ? url.href : null;
  }
  /** Leaves the link bar: back to the style bar for a selection; for a caret, closed until the caret leaves links. */
  function closeLink() {
    if (linking == "caret") linkDismissed = true;
    linking = null;
    page.focus();
    if (linkDismissed) hide();
    queue();
  }
  function applyLink(edit: { url: string; text?: string; self?: boolean }) {
    const wasCaret = linking == "caret",
      at = linkSel;
    closeLink();
    const why = page.setLink({ ...edit, at });
    if (why) explain(why);
    if (wasCaret) linkDismissed = true;
    queue();
  }
  const applyFields = () =>
    applyLink({ url: linkAddress(linkUrl.value), text: linkText.value, self: linkTab.getAttribute("aria-checked") != "true" });
  fmt.addEventListener("mousedown", (e) => {
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
  });
  fmt.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("button");
    if (!b) return;
    if (b.dataset.why) {
      explain(b.dataset.why);
      return;
    }
    const done = (why: string | null) => {
      if (why) explain(why);
      queue();
    };
    if (b.dataset.style) done(page.toggleStyle(b.dataset.style as InlineStyle));
    else if (b.dataset.act == "link") openLink();
    else if (b.dataset.act == "clear") done(page.clearStyles());
    else if (b.dataset.link == "close") closeLink();
    else if (b.dataset.link == "remove") applyLink({ url: "" });
    else if (b.dataset.link == "open") {
      const url = linkAddress(linkUrl.value),
        go = url && openable(url);
      if (go) win.open(go, "_blank", "noopener");
      else explain(url ? "Only web, email and Erga addresses open from here." : "Type an address to open it.");
    } else if (b.dataset.link == "tab") {
      const newTab = linkTab.getAttribute("aria-checked") != "true";
      setLinkTab(newTab);
      // On a link that's there, at once; a new link takes it with the rest.
      const link = page.linkAt();
      if (link) {
        const why = page.setLink({ url: link.href, self: !newTab, at: linkSel });
        explain(why ?? (newTab ? "The link opens in a new tab" : "The link opens in this tab"));
      }
    }
  });
  for (const input of [linkText, linkUrl])
    input.addEventListener("keydown", (e) => {
      if (e.key == "Enter") {
        e.preventDefault();
        applyFields();
      }
      if (e.key == "Escape") {
        e.preventDefault();
        closeLink();
      }
    });
  // The focus leaving the link bar (a click on the page, say) applies what's in it.
  linkPane.addEventListener("focusout", (e) => {
    if (linkPane.contains(e.relatedTarget as Node | null) || !linking) return;
    applyFields();
  });

  // ------------------------------------------------------------ the refresh pill

  // A change the page can't show in place (a script, a stylesheet) waits while an agent works (frame.ts, refreshSoon):
  // the pill says so, and a click shows it now.
  const pill = $("refresh-pill");
  let refreshNow: (() => void) | null = null;
  pill.addEventListener("mousedown", (e) => e.preventDefault());
  pill.addEventListener("click", () => refreshNow?.());
  /** The pill, for a change that waits for `agents` (their names), or none (null). */
  function waiting(agents: string[] | null, now?: () => void) {
    pill.hidden = !agents;
    refreshNow = now ?? null;
    if (!agents) return;
    const names = agents.length ? agents.join(" and ") : "the agent";
    pill.textContent = `Page changes will show when ${names} ${agents.length > 1 ? "finish" : "finishes"} · `;
    pill.append(Object.assign(doc.createElement("b"), { textContent: "Refresh now" }));
    pill.title = `${names} changed more than text; the page re-renders when ${agents.length > 1 ? "they finish" : "it finishes"}.`;
  }

  return {
    queue,
    hide,
    openLink,
    closeLink,
    explain,
    waiting,
    /** The page's colours: the controls take their dark look on a dark page. */
    dark(on: boolean) {
      box.classList.toggle("dark", on);
    },
    get linking() {
      return linking;
    },
    /** A press on the page: the link bar being filled in applies first, to its own selection (the press moves the caret). */
    pressed() {
      if (linking && linkPane.contains(root.activeElement)) applyFields();
      pointerDown = true;
      linkDismissed = false;
      hide();
    },
    released() {
      pointerDown = false;
      queue();
    },
    remove() {
      win.clearTimeout(noteTimer);
      host.remove();
    },
  };
}

export type Controls = ReturnType<typeof mountControls>;

/**
 * A note that stays on the page until taken off (the lock for source edits: frame.ts), in the controls' look, below the
 * viewer's bars. Returns what takes it off.
 */
export function noteOnPage(win: Window, text: string): () => void {
  const doc = win.document;
  const host = doc.createElement("erga-note");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}
.note.lasting { top: ${TOP_ROOM + 8}px; bottom: auto; animation: none; }</style><div class="c"><div class="card note lasting" role="status"></div></div>`;
  root.querySelector(".note")!.textContent = text;
  doc.documentElement.append(host);
  return () => host.remove();
}
