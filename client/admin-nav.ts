// The admin area as one page: a link to another admin page
// (the sidebar, the breadcrumb, a link in a page or in the agent's reply)
// changes only the page in <main>, so the shell around it (the sidebar, Share
// with agent and, above all, the admin's agent panel, with its conversation and
// a reply on its way) stays as it is. The server still makes every admin page
// whole, so each has its own address: a deep link, a reload and a new tab open
// it as before, and back and forward go between the pages without a load.
//
// A page is fetched as the server makes it; its title, style, breadcrumb, the
// sidebar's mark and <main> are taken into this one, and its scripts run
// again, each in a function of its own (so its consts don't clash with the
// last page's). A page's script that keeps something running (an EventSource,
// a timer, a listener on document) stops it when the page goes, with
// window.ergaView (set by server/admin/layout.ts's first script, and again here for
// each page): view.signal aborts, and view.onLeave(fn) runs fn. ergaAdmin.reload()
// shows the page again, as it is now on the server, where the page used to
// reload. Anything that isn't an admin page of the layout (a redirect to sign
// in, an error, another kind of answer) opens as a whole page instead.
//
// Built by client/build.sh to admin-nav.js.

interface View { signal: AbortSignal; onLeave(fn: () => void): void; leave(): void }
declare global { interface Window { ergaView: View; ergaAdmin?: { go(url: string, opts?: { replace?: boolean }): Promise<void>; reload(): Promise<void> } } }

const main = document.getElementById("admin-panes")!;
const isAdmin = (u: URL) => u.origin == location.origin && (u.pathname == "/admin" || u.pathname.startsWith("/admin/"));
const here = () => location.pathname + location.search;

/** A fresh view, for the page about to be shown; the last one's is left. */
function newView(): View {
  const c = new AbortController(), fns: (() => void)[] = [];
  return {
    signal: c.signal,
    onLeave: (fn) => { if (c.signal.aborted) fn(); else fns.push(fn); },
    leave: () => { c.abort(); for (const fn of fns.splice(0)) try { fn(); } catch (e) { console.error(e); } },
  };
}

// Each entry keeps where its page was scrolled to, for back and forward (written as it scrolls, at most every 300 ms).
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
let scrollTimer = 0;
const keepScroll = () => { clearTimeout(scrollTimer); scrollTimer = 0; history.replaceState({ ...(history.state ?? {}), ergaScroll: scrollY }, ""); };
addEventListener("scroll", () => { scrollTimer ||= window.setTimeout(keepScroll, 300); }, { passive: true });

let shown = here(), loading: AbortController | null = null;

/** Show the admin page at url in <main>; a whole load if it isn't one. */
async function go(url: string, opts: { push?: boolean; replace?: boolean; scroll?: number; keep?: boolean } = {}) {
  const to = new URL(url, location.href);
  loading?.abort();
  const ac = loading = new AbortController();
  document.documentElement.classList.add("admin-loading");
  const whole = () => { if (opts.push === false) location.reload(); else location.assign(to.href); };
  try {
    const r = await fetch(to.href, { signal: ac.signal, headers: { Accept: "text/html" }, credentials: "same-origin" });
    const final = new URL(r.url || to.href);
    if (!r.ok || !isAdmin(final) || !(r.headers.get("Content-Type") ?? "").includes("text/html")) return whole();
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    const next = doc.getElementById("admin-panes");
    if (!next) return whole();
    if (ac.signal.aborted) return;
    final.hash = to.hash;
    if (opts.push !== false) {
      keepScroll();
      if (opts.replace || final.href == location.href) history.replaceState(history.state, "", final.href);
      else history.pushState(null, "", final.href);
    } else if (final.pathname + final.search != here()) history.replaceState(history.state, "", final.href);
    swap(doc, next);
    shown = here();
    const top = opts.scroll ?? (opts.keep ? scrollY : 0);
    const target = !opts.keep && to.hash ? document.getElementById(decodeURIComponent(to.hash.slice(1))) : null;
    if (target) target.scrollIntoView(); else scrollTo(0, top);
  } catch (e) {
    if ((e as Error).name != "AbortError") whole();
  } finally {
    if (loading == ac) { loading = null; document.documentElement.classList.remove("admin-loading"); }
  }
}

/** The new page's parts into this one: its title, style, breadcrumb, sidebar mark and <main>, and its scripts run. */
function swap(doc: Document, next: HTMLElement) {
  window.ergaView.leave();
  window.ergaView = newView();
  document.title = doc.title;
  const style = document.querySelector("style"), nextStyle = doc.querySelector("style");
  if (style && nextStyle && style.textContent != nextStyle.textContent) style.textContent = nextStyle.textContent;
  // Which code the page now shown carries: live.js asks the server about this one from now on.
  const build = document.querySelector('meta[name="erga-build"]'), nextBuild = doc.querySelector('meta[name="erga-build"]');
  if (build && nextBuild) build.setAttribute("content", nextBuild.getAttribute("content") ?? "");
  const crumb = document.querySelector(".crumbs .here"), nextCrumb = doc.querySelector(".crumbs .here");
  if (crumb && nextCrumb) crumb.replaceChildren(...[...nextCrumb.childNodes].map((n) => n.cloneNode(true)));
  const marked = doc.querySelector('.admin-side a[aria-current="page"]')?.getAttribute("href");
  for (const a of document.querySelectorAll(".admin-side a")) {
    if (a.getAttribute("href") == marked) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  // The focus was in the page that goes: it goes to the page's heading, so a keyboard or a screen reader is in the new page.
  const focused = main.contains(document.activeElement);
  main.className = next.className;
  // Its scripts can't run as they come in (they would, imported): each runs once, below, in order.
  for (const old of next.querySelectorAll("script")) old.type = "text/x-erga-later:" + (old.type || "");
  main.replaceChildren(...[...next.childNodes].map((n) => document.importNode(n, true)));
  for (const old of main.querySelectorAll("script")) {
    old.type = old.type.slice("text/x-erga-later:".length);
    if (!old.type) old.removeAttribute("type");
    const s = document.createElement("script");
    for (const a of old.attributes) s.setAttribute(a.name, a.value);
    if (old.src) s.async = false;
    else s.textContent = `(() => {\n${old.textContent}\n})();`;
    old.replaceWith(s);
  }
  if (focused && crumb instanceof HTMLElement) { crumb.tabIndex = -1; crumb.focus({ preventScroll: true }); }
  window.dispatchEvent(new Event("erga:admin-view"));
}

// A link to an admin page: shown here, unless it opens elsewhere or only moves within the page.
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button != 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || (a.target && a.target != "_self") || a.hasAttribute("download") || a.dataset.reload != null) return;
  const to = new URL(a.href, location.href);
  if (!isAdmin(to)) return;
  if (to.pathname + to.search == here() && to.hash) return;
  e.preventDefault();
  go(to.href);
});

// Back and forward: the page of that entry, where it was scrolled to. A change of hash alone stays with the page.
addEventListener("popstate", (e) => {
  clearTimeout(scrollTimer); scrollTimer = 0;
  if (here() == shown) return;
  go(location.href, { push: false, scroll: ((e as PopStateEvent).state as { ergaScroll?: number } | null)?.ergaScroll ?? 0, keep: true });
});
addEventListener("pagehide", keepScroll);

window.ergaAdmin = {
  go: (url, opts = {}) => go(url, { replace: opts.replace }),
  reload: () => go(location.href, { replace: true, keep: true }),
};

export {};
