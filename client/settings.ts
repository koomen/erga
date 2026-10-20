// Document settings: the popover under the gear in the editor's top row
// (client/editor.html, #btn-settings). Built on its own and
// loaded only when the gear is reached for, so it
// costs viewing and opening the editor nothing.
//
// Readers always see the document as it is now. It holds, top to bottom:
//   - Homepage (for admins, and on the homepage itself): whether this is the
//     server's homepage, how its deploy is going, and Redeploy now.
//   - Custom domain: the document at a domain of the person's own,
//     from their Cloudflare account: Connect Cloudflare if they haven't
//     (Cloudflare's consent page in a popup; when it's done, the popup tells
//     this panel on a BroadcastChannel), else a name and one of their domains,
//     and once it's up, the site's address, how its deploy is going, Deploy
//     now and Remove.
//   - Versions: the latest ten, each with its number, the model's five-word
//     description (a quiet placeholder until it arrives), when and who; the
//     current one marked; Show older versions loads ten more. Edit, on hover or
//     focus, makes a copy of a version the current one (POST .../versions/<id>/restore).
//
// It talks to the server's API as the shared contract says (document/versions.ts
// server/home/api.ts and server/sites/api.ts), and refreshes on the event channel's
// { type: "versions" }, { type: "home" } and { type: "site" } (main.ts passes them on).
// Someone who can't edit sees it all read-only.

import { ago, clock, RECENT, type Version, type Versions } from "./versions";

export interface Deploy { state: "idle" | "scheduled" | "deploying" | "deployed" | "failed"; at: string | null; scheduledFor: string | null; version: number | null; error: string | null }
/** GET /api/docs/<id>/home. `blocked`: why this document can't be made the homepage (others may edit it), or null. */
export interface Home { isHome: boolean; canSet: boolean; /** An admin acting through a token without the admin scope. */ locked?: boolean; blocked?: string | null; deploy: Deploy }

/** GET /api/docs/<id>/site. */
export interface SiteState {
  canEdit: boolean;
  connection: { connected: boolean; accounts: { id: string; name: string }[]; canStore: boolean; unreadable: boolean; error: string | null };
  site: { hostname: string; url: string; zone: string; by: string; created: string; dashboard: string } | null;
  deploy: Deploy & { by?: string | null };
  zones?: { id: string; name: string; account: { id: string; name: string } }[];
  zonesError?: string;
  warning?: string;
}

export interface SettingsHost {
  /** The document's id (its /d/<id>). */
  docId: string;
  /** What every request carries (a local tab's ?user=), or "". */
  query: string;
  /** The gear. */
  anchor: HTMLElement;
  /** Whether you're an admin (the homepage is theirs to choose). */
  admin: boolean;
  /** The popover opened or closed. */
  onToggle(open: boolean): void;
}

export interface Settings {
  toggle(open?: boolean): void;
  isOpen(): boolean;
  /** Escape: closes the popover. False if it wasn't open. */
  escape(): boolean;
  /** An event from the channel ("versions", "home"). */
  event(type: string): void;
  /** Whether a node is part of the popover. */
  contains(node: Node): boolean;
  /** Back from Cloudflare's consent without the popup: opens at Custom domain, with the refusal if there was one. */
  consented(error: string | null): void;
}

declare global { interface Window { ergaSettings?: { mount(host: SettingsHost): Settings } } }

const CSS = `
.help.ds:focus { outline: none; }
.ds [hidden] { display: none !important; }
.help.ds { width: min(380px, calc(100vw - 24px)); box-sizing: border-box; padding: 0; right: var(--ds-right, 16px); overflow-x: hidden; }
.ds section { padding: 14px 16px; }
.ds section + section { border-top: 1px solid var(--rule); }
.ds h2 { margin: 0; padding: 14px 16px 0; font: 600 14px/1.3 var(--font-text); color: var(--fg-strong, var(--fg)); }
.ds h3 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; font: 600 12px/1.3 var(--font-text); color: var(--soft); text-transform: uppercase; letter-spacing: 0.04em; }
.ds h3 small { font-weight: 500; text-transform: none; letter-spacing: 0; color: var(--chrome); }
.ds-field { display: grid; grid-template-columns: 1fr; gap: 5px; margin: 0 0 6px; }
.ds-field + .ds-field { margin-top: 12px; }
.ds-label { font-size: 12px; color: var(--soft); }
.ds-select {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 36px; box-sizing: border-box; padding: 6px 10px 6px 11px;
  border: 1px solid var(--panel-border); border-radius: 9px; background: var(--code-bg); color: var(--fg-strong, var(--fg));
  font: 500 13.5px/1.3 var(--font-text); text-align: left; cursor: pointer; transition: border-color 120ms ease, background-color 120ms ease;
}
.ds-select:hover { border-color: color-mix(in srgb, var(--chrome) 45%, var(--panel-border)); }
.ds-select:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
.ds-n { flex: none; font: 600 12px/1.3 var(--font-mono); color: var(--soft); font-feature-settings: "tnum"; }
.ds-explain { margin: 6px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--soft); }
.ds-explain:empty, .ds-error:empty { display: none; }
.ds-error { margin: 8px 0 0; padding: 7px 10px; border-radius: 8px; font-size: 12.5px; line-height: 1.45; color: #b42318; background: color-mix(in srgb, #d0453a 10%, transparent); }
html.page-dark body:not(.source) .ds-error { color: #ff9d94; }
.ds-desc-none { color: var(--chrome); font-style: italic; }
.ds-list { list-style: none; margin: 0; padding: 0; }
.ds-list li { display: grid; grid-template-columns: 34px 1fr auto; gap: 1px 8px; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--rule); }
.ds-list li:first-child { border-top: 0; }
.ds-list li { position: relative; }
/* Edit: over the version's tags the moment the pointer is on it (or the keyboard reaches it), no fade. */
.ds-edit {
  position: absolute; right: 0; top: 50%; transform: translateY(-50%); opacity: 0; pointer-events: none;
  font: 600 12px var(--font-text); padding: 5px 11px; border-radius: 7px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--panel-border); background: var(--bg); color: var(--fg); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.ds-list li:hover .ds-edit, .ds-edit:focus-visible, .ds-edit.busy { opacity: 1; pointer-events: auto; }
.ds-list li:hover .ds-edit:hover { border-color: color-mix(in srgb, var(--chrome) 45%, var(--panel-border)); }
.ds-edit:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
@media (hover: none) { .ds-edit { opacity: 1; pointer-events: auto; position: static; transform: none; grid-column: 3; grid-row: 1 / span 2; align-self: center; } .ds-list li:has(.ds-edit) .ds-tags { display: none; } }
.ds-list .ds-n { grid-row: span 2; }
.ds-list .ds-desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-strong, var(--fg)); font-size: 13px; }
.ds-list .ds-meta { grid-column: 2 / span 2; font-size: 11.5px; color: var(--chrome); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-tags { display: flex; gap: 4px; }
.ds-tag { font: 600 10.5px/1 var(--font-text); padding: 3px 6px; border-radius: 999px; color: var(--soft); background: var(--code-bg); white-space: nowrap; }
.ds-foot { display: flex; align-items: baseline; gap: 10px; margin: 6px 0 0; font-size: 11.5px; color: var(--chrome); }
.ds-skel { height: 12px; border-radius: 6px; background: var(--code-bg); margin: 10px 0; animation: ds-pulse 1.1s ease-in-out infinite alternate; }
@keyframes ds-pulse { from { opacity: 0.5; } to { opacity: 1; } }
.ds-switch-row { display: flex; align-items: center; gap: 12px; }
.ds-switch-row label { flex: 1; font-size: 13.5px; color: var(--fg-strong, var(--fg)); cursor: pointer; }
.ds-switch { position: relative; flex: none; width: 36px; height: 21px; padding: 0; border: 0; border-radius: 999px; background: color-mix(in srgb, var(--chrome) 45%, transparent); cursor: pointer; transition: background-color 160ms ease; }
.ds-switch::after { content: ""; position: absolute; top: 2.5px; left: 2.5px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.25); transition: transform 180ms var(--agent-ease, ease); }
.ds-switch[aria-checked="true"] { background: var(--caret); }
.ds-switch[aria-checked="true"]::after { transform: translateX(15px); }
.ds-switch:focus-visible { outline: 2px solid var(--caret); outline-offset: 2px; }
.ds-switch[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
.ds-deploy { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 9px 10px 9px 11px; border-radius: 9px; background: var(--code-bg); }
.ds-status { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; font-size: 12.5px; line-height: 1.4; color: var(--fg); }
.ds-status span { min-width: 0; }
.ds-status b { font-weight: 600; }
.ds-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--chrome); }
.ds-dot.deployed { background: #22a06b; }
.ds-dot.failed { background: #d0453a; }
.ds-dot.scheduled { background: transparent; box-shadow: inset 0 0 0 1.5px var(--chrome); }
.ds-dot.deploying { width: 10px; height: 10px; background: transparent; border: 1.6px solid color-mix(in srgb, var(--caret) 25%, transparent); border-top-color: var(--caret); box-sizing: border-box; animation: agent-spin 0.8s linear infinite; }
.ds-btn { flex: none; font: 600 12.5px var(--font-text); border-radius: 7px; padding: 6px 11px; cursor: pointer; border: 1px solid var(--panel-border); background: var(--bg); color: var(--fg); white-space: nowrap; }
.ds-btn:hover { border-color: color-mix(in srgb, var(--chrome) 45%, var(--panel-border)); }
.ds-btn:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
.ds-btn[aria-disabled="true"] { opacity: 0.5; cursor: default; }
#ds-site-body > .ds-explain:first-child { margin-top: 0; }
.ds-site-row { display: flex; align-items: stretch; gap: 6px; }
.ds-input {
  flex: 1 1 40%; min-width: 0; min-height: 36px; box-sizing: border-box; padding: 6px 10px; border: 1px solid var(--panel-border); border-radius: 9px;
  background: var(--code-bg); color: var(--fg-strong, var(--fg)); font: 500 13.5px/1.3 var(--font-text); text-align: right;
}
.ds-input::placeholder { color: var(--chrome); font-weight: 400; }
.ds-input:focus { outline: 2px solid var(--caret); outline-offset: 1px; border-color: var(--caret); }
.ds-dot-sep { align-self: center; font: 600 14px var(--font-text); color: var(--soft); }
select.ds-select { flex: 1 1 60%; min-width: 0; appearance: none; padding-right: 26px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5 6 7.5l3-3' fill='none' stroke='%23999' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 9px center; background-size: 12px; }
.ds-site-go { margin-top: 10px; display: flex; align-items: center; gap: 10px; }
.ds-btn.primary { background: var(--caret); border-color: var(--caret); color: #fff; }
.ds-btn.primary:hover { border-color: var(--caret); filter: brightness(1.06); }
.ds-site-live { display: flex; align-items: center; gap: 8px; min-width: 0; font: 600 14px/1.3 var(--font-text); }
.ds-site-live a { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-strong, var(--fg)); text-decoration: none; }
.ds-site-live a:hover { text-decoration: underline; text-underline-offset: 0.2em; }
.ds-site-live svg { flex: none; width: 12px; height: 12px; fill: none; stroke: var(--soft); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.ds-site-acts { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
.ds-site-acts .ds-quiet { margin-left: auto; }
.ds-quiet { font: 500 12px var(--font-text); color: var(--soft); background: none; border: 0; padding: 4px 2px; cursor: pointer; text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 0.2em; }
.ds-quiet:hover { color: var(--fg); }
.ds-quiet.armed { color: #b42318; text-decoration-color: currentColor; }
.ds-site-foot { margin: 8px 0 0; font-size: 11.5px; color: var(--chrome); }
.ds-site-foot a { color: inherit; }
a.ds-btn { display: inline-flex; align-items: center; gap: 6px; text-decoration: none; }
a.ds-btn svg { width: 14px; height: 14px; }
@media (max-width: 520px) {
  .help.ds { z-index: 22; top: auto; left: 0; right: 0; bottom: 0; width: auto; max-height: min(82vh, calc(100% - var(--top-clear))); border-radius: 16px 16px 0 0; border-bottom: 0; padding-bottom: env(safe-area-inset-bottom); animation: ds-sheet 240ms var(--agent-ease, ease); }
  .ds section { padding: 14px 18px; }
  .ds-sheet-grip { display: block; width: 36px; height: 4px; margin: 8px auto -4px; border-radius: 2px; background: color-mix(in srgb, var(--chrome) 40%, transparent); }
}
.ds-sheet-grip { display: none; }
@keyframes ds-sheet { from { transform: translateY(40px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (pointer: coarse) { .ds-select { min-height: 42px; } }
@media (prefers-reduced-motion: reduce) { .ds-dot.deploying, .ds-skel { animation-duration: 3s; } .help.ds { animation: none; } }
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n == 1 ? one : many}`;

function mount(host: SettingsHost): Settings {
  if (!document.getElementById("ds-style")) document.head.append(Object.assign(document.createElement("style"), { id: "ds-style", textContent: CSS }));

  const pop = document.createElement("div");
  pop.id = "doc-settings";
  pop.className = "help ds";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-labelledby", "ds-title");
  pop.innerHTML = `<div class="ds-sheet-grip" aria-hidden="true"></div>
    <h2 id="ds-title">Document settings</h2>
    <section class="ds-home" id="ds-home" hidden aria-label="Homepage">
      <div class="ds-switch-row">
        <label id="ds-home-label" for="ds-home-switch">This is the homepage</label>
        <button type="button" class="ds-switch" id="ds-home-switch" role="switch" aria-checked="false" aria-describedby="ds-home-explain"></button>
      </div>
      <p class="ds-explain" id="ds-home-explain"></p>
      <div class="ds-deploy" id="ds-deploy" hidden>
        <div class="ds-status" id="ds-status" role="status" aria-live="polite"></div>
        <button type="button" class="ds-btn" id="ds-redeploy">Redeploy now</button>
      </div>
      <p class="ds-error" id="ds-home-error" role="alert"></p>
    </section>
    <section class="ds-site" id="ds-site" hidden aria-labelledby="ds-site-label">
      <div class="ds-field">
        <span class="ds-label" id="ds-site-label">Custom domain</span>
        <div id="ds-site-body"></div>
      </div>
      <p class="ds-error" id="ds-site-error" role="alert"></p>
    </section>
    <section class="ds-history" aria-labelledby="ds-history-title">
      <h3 id="ds-history-title">Versions <small id="ds-total"></small></h3>
      <ol class="ds-list" id="ds-list" aria-label="Recent versions"></ol>
      <p class="ds-error" id="ds-hist-error" role="alert"></p>
      <p class="ds-foot" id="ds-foot" hidden><span id="ds-foot-text"></span><button type="button" class="ds-quiet" id="ds-older">Show older versions</button></p>
    </section>`;
  document.body.append(pop);
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => pop.querySelector<T>(`#${id}`)!;
  const list = $("ds-list"), totalEl = $("ds-total"), foot = $("ds-foot"), footText = $("ds-foot-text"), olderBtn = $("ds-older"), histError = $("ds-hist-error");
  const homeSec = $("ds-home"), homeSwitch = $("ds-home-switch"), homeExplain = $("ds-home-explain");
  const deployBox = $("ds-deploy"), statusEl = $("ds-status"), redeploy = $("ds-redeploy"), homeError = $("ds-home-error");
  const siteSec = $("ds-site"), siteBody = $("ds-site-body"), siteError = $("ds-site-error");

  // ------------------------------------------------------------ the server

  const url = (path: string, params: Record<string, string> = {}) => {
    const q = new URLSearchParams(host.query);
    for (const [k, v] of Object.entries(params)) q.set(k, v);
    const s = q.toString();
    return `/api/docs/${encodeURIComponent(host.docId)}/${path}${s ? `?${s}` : ""}`;
  };
  async function call<T>(path: string, init?: RequestInit, params?: Record<string, string>): Promise<T> {
    let r: Response;
    try {
      r = await fetch(url(path, params), { ...init, headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) }, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new Error((e as Error).name == "TimeoutError" ? "The server didn't answer in time. Try again." : "Couldn't reach the server. Check your connection and try again.");
    }
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) {
      throw new Error(body.error || (r.status == 403 ? "You don't have permission to do that."
        : r.status == 404 ? "The server doesn't know this document's versions." : `The server had a problem (error ${r.status}). Try again.`));
    }
    return body as T;
  }

  // ------------------------------------------------------------ state

  let data: Versions | null = null;
  let loadError: string | null = null;
  /** Every version loaded, by number: the latest ten, and the older ones Show older versions brought. */
  let loaded = new Map<number, Version>();
  let home: Home | null = null;
  let homeBusy = false;
  let loadSeq = 0, homeSeq = 0, siteSeq = 0;
  let site: SiteState | null = null;
  let siteBusy = false, removeArmed = false, consenting = false;
  /** What's typed in the name, kept across redraws. */
  let siteName = "", siteZone = "";

  const add = (vs: Version[]) => { for (const v of vs) loaded.set(v.n, v); };
  /** The loaded versions, newest first. */
  const shown = () => [...loaded.values()].sort((a, b) => b.n - a.n);
  async function loadVersions() {
    const seq = ++loadSeq;
    try {
      const d = await call<Versions>("versions");
      if (seq != loadSeq) return;
      // What was loaded before stays (older versions shown), with the fresh copies over it.
      if (data && d.total < data.total) loaded = new Map();
      add(d.versions); add([d.current]);
      data = d;
      loadError = null;
      render();
    } catch (e) {
      if (seq != loadSeq) return;
      loadError = (e as Error).message;
      // What was shown stays, saying it may be out of date.
      if (data) histError.textContent = `Couldn't refresh the versions: ${loadError}`;
      else render();
    }
  }
  /** Show older versions: the ten before the oldest one shown. */
  let loadingOlder = false;
  async function loadOlder() {
    const oldest = shown().at(-1);
    if (!data || !oldest || oldest.n <= 1 || loadingOlder) return;
    loadingOlder = true;
    render();
    const r = await call<Versions>("versions", undefined, { before: oldest.id, limit: String(RECENT) }).catch((e: Error) => { histError.textContent = `Couldn't load older versions: ${e.message}`; return null; });
    loadingOlder = false;
    if (r) add(r.versions);
    render();
  }
  olderBtn.addEventListener("click", () => loadOlder());
  async function loadHome() {
    const seq = ++homeSeq;
    let h: Home | null = null;
    try { h = await call<Home>("home"); } catch { h = null; }
    if (seq != homeSeq) return;
    home = h;
    renderHome();
  }

  async function loadSite() {
    const seq = ++siteSeq;
    let st: SiteState | null = null;
    try { st = await call<SiteState>("site", undefined, { zones: "1" }); } catch (e) { if (seq == siteSeq) siteError.textContent = `Couldn't load the custom domain: ${(e as Error).message}`; }
    if (seq != siteSeq) return;
    if (st) { site = st; siteError.textContent = ""; }
    renderSite();
  }

  /** Edit on a version: a copy of it becomes the current version (the previous current one stays a version). */
  let restoring: string | null = null;
  async function restore(id: string) {
    if (!data || restoring) return;
    const v = data.versions.find((x) => x.id == id);
    restoring = id;
    histError.textContent = "";
    render();
    try {
      const r = await call<{ current: Version }>(`versions/${encodeURIComponent(id)}/restore`, { method: "POST" });
      restoring = null;
      // Shown at once; the event channel's "versions" brings the rest (its description, the total).
      if (data && !data.versions.some((x) => x.id == r.current.id)) {
        data = { ...data, current: r.current, versions: [r.current, ...data.versions], total: data.total + 1 };
        add([r.current]);
      }
      render();
      list.querySelector<HTMLElement>("li")?.scrollIntoView({ block: "nearest" });
      loadVersions();
    } catch (e) {
      restoring = null;
      histError.textContent = `Couldn't restore version ${v?.n ?? ""}: ${(e as Error).message}`;
      render();
    }
  }
  list.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-restore]");
    if (b) restore(b.dataset.restore!);
  });

  // ------------------------------------------------------------ rendering

  const desc = (v: Version) => (v.description ? esc(v.description) : `<span class="ds-desc-none">Describing the changes…</span>`);
  const whoWhen = (v: Version) => [ago(v.at), v.authors.join(", ")].filter(Boolean).join(" · ");

  function render() {
    if (!data) {
      histError.textContent = loadError ? `Couldn't load the versions: ${loadError}` : "";
      list.innerHTML = loadError ? "" : `<li aria-hidden="true" style="display:block"><div class="ds-skel" style="width:70%"></div><div class="ds-skel" style="width:45%"></div><div class="ds-skel" style="width:60%"></div></li>`;
      totalEl.textContent = "";
      foot.hidden = true;
      return;
    }
    const { current } = data;
    totalEl.textContent = data.total > 1 ? `${data.total} in all` : "";
    // The list is drawn afresh: an Edit button that had focus keeps it.
    const focused = (document.activeElement as HTMLElement | null)?.closest?.("#ds-list [data-restore]")?.getAttribute("data-restore");
    const vs = shown();
    list.innerHTML = vs.map((v) => {
      const tags = v.id == current.id ? `<span class="ds-tag">Current</span>` : "";
      const edit = v.id == current.id || !data!.canEdit ? ""
        : `<button type="button" class="ds-edit${restoring == v.id ? " busy" : ""}" data-restore="${esc(v.id)}" aria-label="Edit version ${v.n}: make a copy of it the current version" title="Make a copy of version ${v.n} the current version, to edit it">${restoring == v.id ? "Restoring…" : "Edit"}</button>`;
      return `<li data-n="${v.n}"><span class="ds-n">v${v.n}</span><span class="ds-desc">${desc(v)}</span><span class="ds-tags">${tags}</span><span class="ds-meta" title="${esc(new Date(v.at).toLocaleString())}">${esc(whoWhen(v))}</span>${edit}</li>`;
    }).join("");
    if (focused) [...list.querySelectorAll<HTMLElement>("[data-restore]")].find((b) => b.dataset.restore == focused)?.focus();
    const older = (vs.at(-1)?.n ?? 1) > 1;
    foot.hidden = !older;
    footText.textContent = `The latest ${vs.length} of ${data.total}.`;
    olderBtn.textContent = loadingOlder ? "Loading…" : "Show older versions";
    if (loadingOlder) olderBtn.setAttribute("aria-disabled", "true"); else olderBtn.removeAttribute("aria-disabled");
  }

  function renderHome() {
    homeSec.hidden = !home || !(home.isHome || home.canSet || host.admin);
    if (!home || homeSec.hidden) return;
    const d = home.deploy;
    homeSwitch.setAttribute("aria-checked", String(home.isHome));
    const blocked = !home.isHome && home.blocked ? home.blocked : null;
    const locked = !home.canSet || !!blocked || homeBusy;
    if (locked) homeSwitch.setAttribute("aria-disabled", "true"); else homeSwitch.removeAttribute("aria-disabled");
    homeExplain.textContent = !host.admin ? "Only admins can choose the homepage."
      : home.locked ? "This token has no admin power. Make a token with the admin scope at /tokens to change the homepage or deploy it."
      : blocked ? blocked
      : !home.canSet && d.state == "deploying" ? "You can change this once the deploy finishes."
      : !home.canSet ? "You can't change the homepage here: the server's configuration fixes it, or you can't edit this document."
      : home.isHome ? "The site's front page shows this document. Each new version goes live a few minutes later."
      : "Turn on to make this the site's front page, in place of the current one.";

    deployBox.hidden = !home.isHome;
    if (!home.isHome) return;
    const live = d.version != null ? ` · version ${d.version}` : "";
    const last = d.at ? `Last deployed ${esc(clock(d.at))}${live}.` : "Not deployed yet.";
    const line = d.state == "deploying" ? `<b>Deploying…</b>`
      : d.state == "scheduled" && d.scheduledFor ? `<span><b>Scheduled for ${esc(clock(d.scheduledFor))}</b> (${esc(until(d.scheduledFor))}). ${last}</span>`
      : d.state == "failed" ? `<span><b>Failed:</b> ${esc(d.error || "the deploy didn't finish.")} ${d.at ? last : ""}</span>`
      : d.at ? `<span><b>Deployed</b> at ${esc(clock(d.at))}${live}</span>` : `<span>Not deployed yet</span>`;
    statusEl.innerHTML = `<span class="ds-dot ${d.state}" aria-hidden="true"></span>${line}`;
    const can = host.admin && !home.locked && d.state != "deploying" && !homeBusy;
    if (can) { redeploy.removeAttribute("aria-disabled"); redeploy.title = "Deploy the document as it is now"; }
    else { redeploy.setAttribute("aria-disabled", "true"); redeploy.title = !host.admin ? "Only admins can redeploy the homepage." : home.locked ? "This token has no admin power." : "A deploy is running."; }
    redeploy.textContent = d.state == "deploying" ? "Deploying…" : "Redeploy now";
  }
  function until(iso: string, seconds = false): string {
    const ms = Date.parse(iso) - Date.now();
    if (seconds && ms < 90_000) return ms <= 1000 ? "any moment" : `in ${plural(Math.round(ms / 1000), "second")}`;
    const m = Math.round(ms / 60000);
    return m <= 0 ? "any moment" : `in ${plural(m, "minute")}`;
  }

  homeSwitch.addEventListener("click", async () => {
    if (!home || homeSwitch.getAttribute("aria-disabled") == "true") { if (home && !host.admin) homeError.textContent = "Only admins can choose the homepage."; return; }
    const want = !home.isHome;
    homeBusy = true;
    homeError.textContent = "";
    home = { ...home, isHome: want };
    renderHome();
    try { home = await call<Home>("home", { method: "POST", body: JSON.stringify({ isHome: want }) }); }
    catch (e) { home = { ...home, isHome: !want }; homeError.textContent = `Couldn't ${want ? "make this the homepage" : "stop this being the homepage"}: ${(e as Error).message}`; }
    homeBusy = false;
    renderHome();
    loadHome();
  });
  redeploy.addEventListener("click", async () => {
    if (redeploy.getAttribute("aria-disabled") == "true") return;
    homeBusy = true;
    homeError.textContent = "";
    if (home) home = { ...home, deploy: { ...home.deploy, state: "deploying", error: null } };
    renderHome();
    try { await call("home/deploy", { method: "POST" }); }
    catch (e) { homeError.textContent = `Couldn't redeploy: ${(e as Error).message}`; }
    homeBusy = false;
    loadHome();
  });

  // ------------------------------------------------------------ custom domain

  const EXT = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5h-2v7h7v-2M7 2.5h2.5V5M9.5 2.5 5.5 6.5"/></svg>`;
  function renderSite() {
    siteSec.hidden = !site || (!site.site && !site.canEdit);
    if (!site || siteSec.hidden) return;
    const st = site, d = st.deploy;
    if (st.site) {
      const live = d.version != null ? ` · version ${d.version}` : "";
      const line = d.state == "deploying" ? `<b>Deploying…</b>`
        : d.state == "scheduled" && d.scheduledFor ? `<span><b>New version goes live ${esc(until(d.scheduledFor, true))}.</b>${d.at ? ` Live now${live}.` : ""}</span>`
        : d.state == "failed" ? `<span><b>Failed:</b> ${esc(d.error || "the deploy didn't finish.")}${d.at ? ` The last good deploy${live} is still live.` : ""}</span>`
        : d.at ? `<span><b>Live</b>${live} · ${esc(ago(d.at))}</span>` : `<span>Not deployed yet</span>`;
      const can = st.canEdit && !siteBusy && d.state != "deploying";
      // The deploy failed on the connection (gone, or Cloudflare refused it): connect again here, then Deploy now.
      const reconnect = st.canEdit && (!st.connection.connected || (d.state == "failed" && /Cloudflare connection|connects? Cloudflare again/i.test(d.error ?? "")));
      siteBody.innerHTML = `<div class="ds-site-live"><a href="${esc(st.site.url)}" target="_blank" rel="noopener" id="ds-site-link">${esc(st.site.hostname)}</a>${EXT}</div>
        <div class="ds-deploy"><div class="ds-status" role="status" aria-live="polite"><span class="ds-dot ${d.state}" aria-hidden="true"></span>${line}</div></div>
        ${st.canEdit ? `<div class="ds-site-acts">
          ${reconnect ? `<button type="button" class="ds-btn primary" id="ds-site-connect"${consenting ? ` aria-disabled="true"` : ""}>${consenting ? "Waiting for Cloudflare…" : "Connect Cloudflare again"}</button>` : ""}
          <button type="button" class="ds-btn" id="ds-site-deploy"${can ? "" : ` aria-disabled="true"`}>${d.state == "deploying" ? "Deploying…" : "Deploy now"}</button>
          <a class="ds-btn" href="${esc(st.site.dashboard)}" target="_blank" rel="noopener">Open in Cloudflare</a>
          <button type="button" class="ds-quiet${removeArmed ? " armed" : ""}" id="ds-site-remove"${siteBusy ? ` aria-disabled="true"` : ""}>${removeArmed ? "Click again to take it down" : "Remove"}</button>
        </div>` : ""}
        <p class="ds-site-foot">From ${esc(st.site.by)}’s Cloudflare account. Each new version goes live there within a minute.</p>`;
      return;
    }
    const c = st.connection;
    if (!c.connected) {
      siteBody.innerHTML = `<p class="ds-explain">Publish this document at a domain of yours, such as <b>notes.example.com</b>. It is served from your own Cloudflare account, and follows each new version.</p>
        ${c.error ? `<p class="ds-explain">Your Cloudflare connection stopped working: ${esc(c.error)}.</p>` : ""}
        <div class="ds-site-go"><button type="button" class="ds-btn primary" id="ds-site-connect"${consenting ? ` aria-disabled="true"` : ""}>${consenting ? "Waiting for Cloudflare…" : c.unreadable || c.error ? "Connect Cloudflare again" : "Connect Cloudflare"}</button></div>
        <p class="ds-explain">Cloudflare asks you to allow Erga to put Workers on your domains, and to read your accounts and domains.</p>`;
      return;
    }
    const zones = st.zones ?? [];
    if (!zones.length) {
      // No domains (or they couldn't be read): add one on Cloudflare (the only place), then Check again here; or connect
      // again when the connection is what failed.
      siteBody.innerHTML = `<p class="ds-explain">${esc(st.zonesError ? `Erga couldn't read your domains: ${st.zonesError}` : "Your Cloudflare account has no domains yet. Add one on Cloudflare, then check again.")}</p>
        <div class="ds-site-go"><button type="button" class="ds-btn primary" id="ds-site-recheck">Check again</button>${st.zonesError ? `<button type="button" class="ds-btn" id="ds-site-connect"${consenting ? ` aria-disabled="true"` : ""}>${consenting ? "Waiting for Cloudflare…" : "Connect Cloudflare again"}</button>` : `<a class="ds-btn" href="https://dash.cloudflare.com/?to=/:account/add-site" target="_blank" rel="noopener">Add a domain on Cloudflare</a>`}</div>`;
      return;
    }
    if (!zones.some((z) => z.id == siteZone)) siteZone = zones[0].id;
    const accounts = new Set(zones.map((z) => z.account.id)).size > 1;
    siteBody.innerHTML = `<div class="ds-site-row">
        <input class="ds-input" id="ds-site-name" placeholder="name" aria-label="Name (leave empty for the domain itself)" autocomplete="off" spellcheck="false" value="${esc(siteName)}">
        <span class="ds-dot-sep" aria-hidden="true">.</span>
        <select class="ds-select" id="ds-site-zone" aria-label="Your domain">${zones.map((z) => `<option value="${esc(z.id)}"${z.id == siteZone ? " selected" : ""}>${esc(z.name)}${accounts ? ` (${esc(z.account.name)})` : ""}</option>`).join("")}</select>
      </div>
      <div class="ds-site-go"><button type="button" class="ds-btn primary" id="ds-site-publish"${siteBusy ? ` aria-disabled="true"` : ""}>${siteBusy ? "Publishing…" : `Publish to ${esc(hostnameNow() ?? "")}`}</button></div>
      <p class="ds-explain">Cloudflare serves the document from your account (${esc(c.accounts.map((a) => a.name).join(", "))}). Leave the name empty to use the domain itself.</p>`;
  }
  function hostnameNow(): string | null {
    const zone = site?.zones?.find((z) => z.id == siteZone);
    if (!zone) return null;
    const name = siteName.trim().toLowerCase().replace(/\.+$/, "");
    return name ? `${name}.${zone.name}` : zone.name;
  }
  siteBody.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (t.id == "ds-site-name") siteName = (t as HTMLInputElement).value;
    const b = siteBody.querySelector<HTMLElement>("#ds-site-publish");
    if (b && !siteBusy) b.textContent = `Publish to ${hostnameNow() ?? ""}`;
  });
  siteBody.addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    if (t.id == "ds-site-zone") { siteZone = (t as HTMLSelectElement).value; const b = siteBody.querySelector<HTMLElement>("#ds-site-publish"); if (b && !siteBusy) b.textContent = `Publish to ${hostnameNow() ?? ""}`; }
  });
  siteBody.addEventListener("keydown", (e) => { if (e.key == "Enter" && (e.target as HTMLElement).id == "ds-site-name") { e.preventDefault(); publishSite(); } });
  async function siteCall(path: string, init: RequestInit, failed: string) {
    siteBusy = true;
    siteError.textContent = "";
    renderSite();
    try {
      const st = await call<SiteState>(path, init);
      site = { ...st, zones: site?.zones };
      if (st.warning) siteError.textContent = st.warning;
    } catch (e) { siteError.textContent = `${failed}: ${(e as Error).message}`; }
    siteBusy = false;
    renderSite();
    // The deploy may have finished before this answer came back (its event refreshed first): read it again.
    loadSite();
  }
  async function publishSite() {
    const hostname = hostnameNow();
    if (!hostname || siteBusy) return;
    await siteCall("site", { method: "POST", body: JSON.stringify({ hostname }) }, `Couldn't publish to ${hostname}`);
  }
  siteBody.addEventListener("click", async (e) => {
    const b = (e.target as Element).closest<HTMLElement>("button");
    if (!b || b.getAttribute("aria-disabled") == "true") return;
    if (b.id == "ds-site-publish") return publishSite();
    if (b.id == "ds-site-connect") return connectCloudflare();
    if (b.id == "ds-site-recheck") return loadSite();
    if (b.id == "ds-site-deploy") return siteCall("site/deploy", { method: "POST" }, "Couldn't deploy");
    if (b.id == "ds-site-remove") {
      if (!removeArmed) { removeArmed = true; renderSite(); setTimeout(() => { removeArmed = false; renderSite(); }, 4000); return; }
      removeArmed = false;
      await siteCall("site", { method: "DELETE" }, "Couldn't take the site down");
    }
  });
  // Connect Cloudflare: Cloudflare's consent page in a popup, so this panel stays as it is. The popup's last page
  // (/auth/cloudflare/callback) says how it went on a BroadcastChannel (and to its opener, where it still has one).
  // A browser that blocks the popup goes there itself, and comes back to this document.
  function connectCloudflare() {
    siteError.textContent = "";
    const back = location.pathname + location.search + location.hash;
    const win = window.open(`/auth/cloudflare/start?popup=1&return=${encodeURIComponent(back)}`, "erga-cloudflare", "popup,width=560,height=760");
    if (!win) { location.href = `/auth/cloudflare/start?return=${encodeURIComponent(back)}`; return; }
    consenting = true;
    renderSite();
    const watch = window.setInterval(() => { if (win.closed) { clearInterval(watch); if (consenting) { consenting = false; loadSite(); } } }, 700);
  }
  function consented(m: unknown) {
    const r = m as { type?: string; ok?: boolean; error?: string } | null;
    if (r?.type != "erga-cloudflare") return;
    consenting = false;
    loadSite().then(() => { if (!r.ok) siteError.textContent = r.error || "Cloudflare didn't connect."; });
  }
  try { new BroadcastChannel("erga-cloudflare").onmessage = (e) => consented(e.data); } catch { /* the popup's opener message, and the focus, are enough */ }
  window.addEventListener("message", (e) => { if (e.origin == location.origin) consented(e.data); });
  // Back from Cloudflare (the popup closed, or another tab): the section shows the domains.
  window.addEventListener("focus", () => { if (!pop.hidden && site && !site.connection.connected) loadSite(); });

  // ------------------------------------------------------------ the popover

  let ticker = 0;
  function position() {
    const r = host.anchor.getBoundingClientRect();
    pop.style.setProperty("--ds-right", `${Math.max(12, Math.round(window.innerWidth - r.right - 4))}px`);
  }
  function toggle(force?: boolean) {
    const open = typeof force == "boolean" ? force : !!pop.hidden;
    if (open == !pop.hidden) return;
    pop.hidden = !open;
    host.anchor.setAttribute("aria-expanded", String(open));
    host.onToggle(open);
    if (!open) {
      clearInterval(ticker);
      return;
    }
    position();
    homeError.textContent = "";
    histError.textContent = "";
    siteError.textContent = "";
    render();
    renderHome();
    renderSite();
    loadVersions();
    loadHome();
    loadSite();
    // Relative times ("4 min ago", "in 3 minutes") move on while it's open.
    // The site's countdown ("goes live in 20 seconds") every 5 seconds, the rest every 30.
    let tick = 0;
    ticker = window.setInterval(() => {
      if (++tick % 6 == 0) { render(); renderHome(); }
      if (!siteBusy && !siteBody.contains(document.activeElement)) renderSite();
    }, 5_000);
    pop.tabIndex = -1;
    pop.focus();
  }
  const contains = (node: Node) => pop.contains(node);
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (!pop.hidden && !contains(t) && !host.anchor.contains(t)) toggle(false);
  }, true);
  // A click into the page (another document, out of reach of pointerdown here) closes it too.
  window.addEventListener("blur", () => setTimeout(() => { if (!pop.hidden && document.activeElement?.tagName == "IFRAME") toggle(false); }, 0));
  window.addEventListener("resize", () => { if (!pop.hidden) position(); });

  const pending: Record<string, number> = {};
  return {
    toggle,
    isOpen: () => !pop.hidden,
    escape() {
      if (pop.hidden) return false;
      toggle(false);
      host.anchor.focus();
      return true;
    },
    event(type) {
      if (pop.hidden) { if (type == "versions") data = null; return; }
      // A burst (a version cut, then its description) is one refresh.
      if (type != "home" && type != "versions" && type != "site") return;
      clearTimeout(pending[type]);
      pending[type] = window.setTimeout(() => (type == "home" ? loadHome() : type == "site" ? loadSite() : loadVersions()), 120);
    },
    contains,
    consented(error) {
      toggle(true);
      consented({ type: "erga-cloudflare", ok: !error, error });
      siteSec.scrollIntoView({ block: "nearest" });
    },
  };
}

window.ergaSettings = { mount };
