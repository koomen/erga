// The style bar over a selection (bold, italic, code, link, clear formatting), and the link bar.

import type { InlineStyle } from "../page-editor/editor";
import { $, type Shell } from "./shell";

export function mountStyleBar(shell: Shell) {

  // Select text in the page and a small bar floats above it: bold, italic,
  // code, link, clear formatting. Buttons that can't apply say why (title), and so does a click.
  // The link button (⌘K) turns it into the link bar: the link's text, its address, where it opens. A caret
  // in a link (a click in one) shows the link bar too, with the focus left in the page, so typing goes on.
  const fmt = $("fmt");
  const fmtPanes = $("fmt-panes"), fmtStyle = $("fmt-style"), fmtLinkPane = $("fmt-link");
  const linkText = $("fmt-link-text") as HTMLInputElement, linkUrl = $("fmt-link-url") as HTMLInputElement;
  const linkTab = fmt.querySelector<HTMLButtonElement>("[data-link=tab]")!, linkRemove = fmt.querySelector<HTMLButtonElement>("[data-link=remove]")!;
  const coarse = matchMedia("(pointer: coarse)"), still = matchMedia("(prefers-reduced-motion: reduce)");
  let pointerDown = false;
  let fmtQueued = false;
  /** The link bar is open from a selection (the focus is in it), or from the caret in a link; or not open. */
  let linking: "selection" | "caret" | null = null;
  /** The link bar was closed while the caret is in a link: it stays closed until the caret leaves links, or a click. */
  let linkDismissed = false;
  /** The selection the link bar opened on: its changes go there, even after a click has moved the caret. */
  let linkSel: { anchor: number; head: number } | undefined;
  const pageSel = () => { const m = shell.page.state.selection.main; return { anchor: m.anchor, head: m.head }; };
  let morphing = false;
  function queueFmt() {
    if (fmtQueued) return;
    fmtQueued = true;
    requestAnimationFrame(() => { fmtQueued = false; renderFmt(); });
  }
  function hideFmt() {
    fmt.hidden = true;
    linking = null;
    fmtStyle.hidden = false;
    fmtLinkPane.hidden = true;
  }
  function placeFmt(rect: { left: number; top: number; width: number; bottom: number }) {
    const f = shell.frame.getBoundingClientRect();
    // On touch, the system's own copy and paste menu takes the space above a selection. Above the text, the link bar
    // (about 106 px and its gap) must clear the top bar (58 px): else it covers the document's title (a page's nav link).
    const below = rect.top < 56 || (!!linking && f.top + rect.top < 58 + 114) || coarse.matches;
    const half = (linking ? 300 : coarse.matches ? 220 : 200) / 2 + 10; // half the bar (its buttons are bigger on touch), and a margin
    fmt.style.left = Math.max(half, Math.min(window.innerWidth - half, f.left + rect.left + rect.width / 2)) + "px";
    fmt.style.top = f.top + (below ? rect.bottom : rect.top) + "px";
    fmt.classList.toggle("below", below);
  }
  /** Shows one pane: at once if the bar was hidden, else changing the other into it. */
  function showPane(pane: HTMLElement) {
    const from = pane == fmtStyle ? fmtLinkPane : fmtStyle;
    if (fmt.hidden) {
      from.hidden = true; pane.hidden = false; fmt.hidden = false;
      fmt.classList.remove("appear"); void fmt.offsetWidth; fmt.classList.add("appear");
    } else if (!pane.hidden && from.hidden) return;
    else morphFmt(from, pane);
  }
  function morphFmt(from: HTMLElement, to: HTMLElement) {
    morphing = true;
    const ms = still.matches ? 120 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--morph-ms")) || 240;
    const w0 = fmtPanes.offsetWidth, h0 = fmtPanes.offsetHeight;
    const icon0 = to == fmtLinkPane ? fmt.querySelector("[data-act=link] svg")!.getBoundingClientRect() : null;
    from.hidden = true; to.hidden = false;
    const w1 = fmtPanes.offsetWidth, h1 = fmtPanes.offsetHeight;
    from.hidden = false;
    fmt.classList.add("morphing");
    from.classList.add("out"); to.classList.add("in");
    fmtPanes.style.width = w0 + "px"; fmtPanes.style.height = h0 + "px";
    void fmtPanes.offsetWidth;
    fmtPanes.style.width = w1 + "px"; fmtPanes.style.height = h1 + "px";
    if (icon0 && !still.matches) requestAnimationFrame(() => {
      const svg = $("fmt-link-icon").querySelector("svg")!, icon1 = svg.getBoundingClientRect();
      svg.animate([{ transform: `translate(${icon0.left - icon1.left}px, ${icon0.top - icon1.top}px)`, color: "var(--caret)" }, { transform: "none" }],
        { duration: ms, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "backwards" });
    });
    setTimeout(() => {
      from.hidden = true;
      from.classList.remove("out"); to.classList.remove("in");
      fmt.classList.remove("morphing");
      fmtPanes.style.width = fmtPanes.style.height = "";
      morphing = false;
      queueFmt();
    }, ms * 1.25);
  }
  function renderFmt() {
    if (linking == "selection" || morphing || fmtLinkPane.contains(document.activeElement)) return;
    if (shell.mode != "text" || pointerDown) { hideFmt(); return; }
    const rect = shell.page.selectionRect(), link = shell.page.linkAt();
    if (!link) linkDismissed = false;
    if (rect) {
      linking = null;
      placeFmt(rect);
      const why = shell.page.styleBlocker();
      for (const b of fmtStyle.querySelectorAll<HTMLButtonElement>("button")) {
        b.setAttribute("aria-disabled", String(!!why));
        b.dataset.why = why ?? "";
        if (b.dataset.style) b.setAttribute("aria-pressed", String(!why && shell.page.hasStyle(b.dataset.style as InlineStyle)));
        if (b.dataset.act == "link") b.setAttribute("aria-pressed", String(!why && link != null));
        b.title = why ?? b.getAttribute("aria-label")!.replace(/ \((.+)\)$/, "  $1");
      }
      showPane(fmtStyle);
    } else if (link?.rect && !linkDismissed) {
      linking = "caret";
      linkSel = pageSel();
      fillLink(link.text, link);
      placeFmt(link.rect);
      showPane(fmtLinkPane);
    } else hideFmt();
  }
  function setLinkTab(newTab: boolean) {
    linkTab.setAttribute("aria-checked", String(newTab));
    linkTab.querySelector(".fmt-label")!.textContent = newTab ? "Opens in a new tab" : "Opens in this tab";
  }
  function fillLink(text: string, link: { href: string; self: boolean } | null) {
    linkText.value = text;
    linkUrl.value = link?.href ?? "";
    linkRemove.hidden = !link;
    setLinkTab(!link?.self);
  }
  /** The link button, or ⌘K: the link bar for the selection, or the focus to the address of the caret's link. */
  function openLink() {
    if (linking) { linkUrl.focus(); linkUrl.select(); return; }
    const why = shell.page.styleBlocker();
    if (why) { shell.toast.explain(why); return; }
    if (fmt.hidden) renderFmt();
    if (fmt.hidden) return;
    const link = shell.page.linkAt();
    linking = "selection";
    linkSel = pageSel();
    fillLink(link?.text ?? shell.page.selectedText(), link);
    const rect = shell.page.selectionRect();
    if (rect) placeFmt(rect);
    showPane(fmtLinkPane);
    (link ? linkText : linkUrl).focus();
    (link ? linkText : linkUrl).select();
  }
  /** An address as typed: one with no scheme that looks like a site's gets https://. */
  function linkAddress(url: string): string {
    url = url.trim();
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || /^[#/?.]/.test(url)) return url;
    return /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(url) ? "https://" + url : url;
  }
  /** Leaves the link bar: back to the style bar for a selection; for a caret, closed until the caret leaves links. */
  function closeLink() {
    if (linking == "caret") linkDismissed = true;
    linking = null;
    shell.page.focus();
    if (linkDismissed) hideFmt();
    queueFmt();
  }
  function applyLink(edit: { url: string; text?: string; self?: boolean }) {
    const wasCaret = linking == "caret", at = linkSel;
    closeLink();
    shell.page.setLink({ ...edit, at }).then((why) => {
      if (why) shell.toast.explain(why);
      if (wasCaret) linkDismissed = true;
      queueFmt();
    });
  }
  const applyFields = () => applyLink({ url: linkAddress(linkUrl.value), text: linkText.value, self: linkTab.getAttribute("aria-checked") != "true" });
  fmt.addEventListener("mousedown", (e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); });
  fmt.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("button");
    if (!b) return;
    if (b.dataset.why) { shell.toast.explain(b.dataset.why); return; }
    if (b.dataset.style) shell.page.toggleStyle(b.dataset.style as InlineStyle).then((why) => { if (why) shell.toast.explain(why); queueFmt(); });
    else if (b.dataset.act == "link") openLink();
    else if (b.dataset.act == "clear") shell.page.clearStyles().then((why) => { if (why) shell.toast.explain(why); queueFmt(); });
    else if (b.dataset.link == "close") closeLink();
    else if (b.dataset.link == "remove") applyLink({ url: "" });
    else if (b.dataset.link == "open") {
      const url = linkAddress(linkUrl.value);
      if (/^(https?:|mailto:)/i.test(url)) window.open(url, "_blank", "noopener");
      else shell.toast.explain(url ? "Only web and email addresses open from here." : "Type an address to open it.");
    } else if (b.dataset.link == "tab") {
      const newTab = linkTab.getAttribute("aria-checked") != "true";
      setLinkTab(newTab);
      // On a link that's there, at once; a new link takes it with the rest.
      const link = shell.page.linkAt();
      if (link) shell.page.setLink({ url: link.href, self: !newTab, at: linkSel }).then((why) => { if (why) shell.toast.explain(why); else shell.toast.flash(newTab ? "The link opens in a new tab" : "The link opens in this tab"); });
    }
  });
  for (const input of [linkText, linkUrl]) input.addEventListener("keydown", (e) => {
    if (e.key == "Enter") { e.preventDefault(); applyFields(); }
  });
  // The focus leaving the link bar (a click on the page, say) applies what's in it.
  fmtLinkPane.addEventListener("focusout", (e) => {
    if (fmtLinkPane.contains(e.relatedTarget as Node | null) || !linking) return;
    applyFields();
  });
  window.addEventListener("resize", () => queueFmt());
  return {
    queueFmt, hideFmt, openLink, closeLink, get linking() { return linking; }, get pointerDown() { return pointerDown; },
    pressed() { pointerDown = true; linkDismissed = false; hideFmt(); }, released() { pointerDown = false; queueFmt(); },
  };
}

export type StyleBar = ReturnType<typeof mountStyleBar>;
