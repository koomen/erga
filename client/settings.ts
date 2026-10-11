// Document settings: the popover under the gear in the editor's top row
// (client/editor.html, #btn-settings). Built on its own and
// loaded only when the gear is reached for, so it
// costs viewing and opening the editor nothing.
//
// It holds, top to bottom:
//   - Publishing: Latest (viewers see the current version, as it's typed) or
//     Manual (viewers see the version picked), and in Manual the picker,
//     which always shows the published version, the latest ten and the few
//     before the published one, with a row for each run in between that
//     loads more.
//     Below it, "Publish the current version" when that isn't the published one.
//   - Homepage (for admins, and on the homepage itself): whether this is the
//     server's homepage, how its deploy is going, and Redeploy now.
//   - Custom domain: the document published at a domain of the person's own,
//     from their Cloudflare account: Connect Cloudflare
//     (on /settings) if they haven't, else a name and one of their domains,
//     and once it's up, the site's address, how its deploy is going, Deploy
//     now and Remove.
//   - Versions: the latest ten, each with its number, the model's five-word
//     description (a quiet placeholder until it arrives), when and who; the
//     current and the published one marked. Edit, on hover or focus, makes a
//     copy of a version the current one (POST .../versions/<id>/restore).
//
// It talks to the server's API as the shared contract says (server/versions.ts
// server/home.ts and server/site-publish.ts), and refreshes on the event channel's
// { type: "versions" }, { type: "home" } and { type: "site" } (main.ts passes them on).
// Someone who can't edit sees it all read-only, with a line saying why: what
// viewers see is worth knowing even when you can't change it.

import { ago, clock, nearNeed, pickerRows, RECENT, type Published, type Row, type Version, type Versions } from "./versions";

export interface Deploy { state: "idle" | "scheduled" | "deploying" | "deployed" | "failed"; at: string | null; scheduledFor: string | null; version: number | null; error: string | null }
/** GET /api/docs/<id>/home. `blocked`: why this document can't be made the homepage (others may edit it), or null. */
export interface Home { isHome: boolean; canSet: boolean; /** An admin acting through a token without the admin scope. */ locked?: boolean; blocked?: string | null; deploy: Deploy }

/** GET /api/docs/<id>/site. */
export interface SiteState {
  canEdit: boolean;
  connection: { connected: boolean; last4: string | null; accounts: { id: string; name: string }[]; canStore: boolean; unreadable: boolean };
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
  /** Escape: closes an open menu, else the popover. False if neither was open. */
  escape(): boolean;
  /** An event from the channel ("versions", "home"). */
  event(type: string): void;
  /** Whether a node is part of it (the popover or one of its menus). */
  contains(node: Node): boolean;
}

declare global { interface Window { ergaSettings?: { mount(host: SettingsHost): Settings } } }

const CSS = `
.help.ds:focus { outline: none; }
.ds [hidden] { display: none !important; }
.help.ds { width: min(380px, calc(100vw - 24px)); box-sizing: border-box; padding: 0; right: var(--ds-right, 16px); overflow-x: hidden; }
.ds section { padding: 14px 16px; }
.ds section + section { border-top: 1px solid var(--rule); }
.ds h2 { margin: 0 0 10px; font: 600 14px/1.3 var(--font-text); color: var(--fg-strong, var(--fg)); }
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
.ds-select[aria-expanded="true"] { border-color: var(--caret); }
.ds-select[aria-disabled="true"] { cursor: default; opacity: 0.7; }
.ds-select[aria-disabled="true"]:hover { border-color: var(--panel-border); }
.ds-select .ds-val { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; overflow: hidden; }
.ds-select .ds-val span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-select svg.ds-chev { flex: none; width: 12px; height: 12px; fill: none; stroke: var(--chrome); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
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
.ds-pub-current { justify-self: start; margin-top: 4px; }
.ds-list .ds-n { grid-row: span 2; }
.ds-list .ds-desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-strong, var(--fg)); font-size: 13px; }
.ds-list .ds-meta { grid-column: 2 / span 2; font-size: 11.5px; color: var(--chrome); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-tags { display: flex; gap: 4px; }
.ds-tag { font: 600 10.5px/1 var(--font-text); padding: 3px 6px; border-radius: 999px; color: var(--soft); background: var(--code-bg); white-space: nowrap; }
.ds-tag.pub { color: var(--caret); background: color-mix(in srgb, var(--caret) 13%, transparent); }
.ds-foot { margin: 6px 0 0; font-size: 11.5px; color: var(--chrome); }
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
.ds-menu {
  position: fixed; z-index: 45; box-sizing: border-box; padding: 5px; overflow-y: auto; overscroll-behavior: contain;
  background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 11px; box-shadow: var(--shadow);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); color: var(--fg); font: 13px/1.35 var(--font-text); outline: none;
  animation: pop 120ms var(--ease);
}
.ds-menu [role="option"] { display: grid; grid-template-columns: 16px 1fr; gap: 0 8px; align-items: start; padding: 7px 9px 7px 7px; border-radius: 7px; cursor: pointer; }
.ds-menu [role="option"].active { background: color-mix(in srgb, var(--chrome) 15%, transparent); }
.ds-menu .ds-check { width: 14px; height: 14px; margin-top: 1px; fill: none; stroke: var(--caret); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; visibility: hidden; }
.ds-menu [aria-selected="true"] .ds-check { visibility: visible; }
.ds-menu .ds-opt-title { font-weight: 600; color: var(--fg-strong, var(--fg)); }
.ds-menu .ds-opt-sub { display: block; font-size: 12px; color: var(--soft); margin-top: 1px; }
.ds-menu .ds-ver { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.ds-menu .ds-ver .ds-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-strong, var(--fg)); }
.ds-menu .ds-ver .ds-when { flex: none; font-size: 11.5px; color: var(--chrome); }
.ds-menu .ds-more { color: var(--soft); font-size: 12px; }
.ds-menu .ds-more .ds-dots { letter-spacing: 2px; color: var(--chrome); }
.ds-menu [role="separator"] { height: 1px; margin: 4px 6px; background: var(--rule); }
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
@media (pointer: coarse) { .ds-menu [role="option"] { padding-top: 10px; padding-bottom: 10px; } .ds-select { min-height: 42px; } }
@media (prefers-reduced-motion: reduce) { .ds-dot.deploying, .ds-skel { animation-duration: 3s; } .help.ds { animation: none; } }
`;

const CHEV = `<svg class="ds-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3"/></svg>`;
const CHECK = `<svg class="ds-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>`;

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
    <section class="ds-publish">
      <h2 id="ds-title">Document settings</h2>
      <div class="ds-field">
        <span class="ds-label" id="ds-mode-label">Publishing</span>
        <button type="button" class="ds-select" id="ds-mode" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="ds-mode-label ds-mode"></button>
      </div>
      <div class="ds-field" id="ds-pick-field" hidden>
        <span class="ds-label" id="ds-pick-label">Published version</span>
        <button type="button" class="ds-select" id="ds-pick" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="ds-pick-label ds-pick"></button>
        <button type="button" class="ds-btn ds-pub-current" id="ds-pub-current" hidden></button>
      </div>
      <p class="ds-explain" id="ds-explain"></p>
      <p class="ds-error" id="ds-pub-error" role="alert"></p>
    </section>
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
      <p class="ds-foot" id="ds-foot" hidden></p>
    </section>`;
  document.body.append(pop);
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => pop.querySelector<T>(`#${id}`)!;
  const modeBtn = $("ds-mode"), pickBtn = $("ds-pick"), pickField = $("ds-pick-field");
  const explainEl = $("ds-explain"), pubError = $("ds-pub-error");
  const list = $("ds-list"), totalEl = $("ds-total"), foot = $("ds-foot"), histError = $("ds-hist-error"), pubCurrent = $("ds-pub-current");
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
  /** Every version the picker has, by number. */
  let loaded = new Map<number, Version>();
  let publishing = false;
  let home: Home | null = null;
  let homeBusy = false;
  let loadSeq = 0, homeSeq = 0, siteSeq = 0;
  let site: SiteState | null = null;
  let siteBusy = false, removeArmed = false;
  /** What's typed in the name, kept across redraws. */
  let siteName = "", siteZone = "";

  const add = (vs: Version[]) => { for (const v of vs) loaded.set(v.n, v); };
  /**
   * The picker starts afresh (another published version: its neighbours, not the last one's). Versions loaded for
   * the one before, still on their way, are dropped; a plain refresh (a new version, a description) keeps them.
   */
  let loadedEpoch = 0;
  const fresh = () => { loaded = new Map(); loadedEpoch++; };
  async function loadVersions() {
    const seq = ++loadSeq;
    try {
      const d = await call<Versions>("versions");
      if (seq != loadSeq) return;
      // What was loaded before stays (more rows opened in the picker), with the fresh copies over it.
      // A different published version starts afresh: its neighbours, not the last one's.
      if (data && (d.total < data.total || d.published.version.id != data.published.version.id || d.published.mode != data.published.mode)) fresh();
      add(d.versions); add([d.current, d.published.version]);
      data = d;
      loadError = null;
      render();
      await loadNear();
    } catch (e) {
      if (seq != loadSeq) return;
      loadError = (e as Error).message;
      // What was shown stays, saying it may be out of date.
      if (data) pubError.textContent = `Couldn't refresh the versions: ${loadError}`;
      else render();
    }
  }
  /** The few versions before the published one, for rolling back to (Manual only). */
  async function loadNear() {
    if (!data || data.published.mode != "manual") return;
    const need = nearNeed(loaded, data.published.version);
    if (!need) return;
    const epoch = loadedEpoch;
    const more = await call<Versions>("versions", undefined, { before: need.before, limit: String(need.limit) }).catch(() => null);
    if (!more || epoch != loadedEpoch) return;
    add(more.versions);
    renderMenu();
  }
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
    if (st) { site = st; siteError.textContent = st.zonesError && st.connection.connected && !st.site ? st.zonesError : ""; }
    renderSite();
  }

  async function publish(next: Published, body: unknown) {
    if (!data || publishing) return;
    const was = data.published;
    data.published = next;
    publishing = true;
    pubError.textContent = "";
    render();
    try {
      const r = await call<{ published: Published }>("publish", { method: "POST", body: JSON.stringify(body) });
      data.published = r.published;
      // The picker shows the new published version's neighbours, not the last one's.
      fresh();
      add(data.versions); add([data.current, r.published.version]);
    } catch (e) {
      data.published = was;
      pubError.textContent = `Couldn't change what's published: ${(e as Error).message}`;
    } finally {
      publishing = false;
      render();
      loadNear();
    }
  }
  const setMode = (mode: "latest" | "manual") => {
    if (!data || mode == data.published.mode) return;
    // Manual starts on what viewers see now, so nothing changes for them until a version is picked.
    if (mode == "latest") publish({ mode, version: data.current }, { mode });
    else publish({ mode, version: data.published.version }, { mode, versionId: data.published.version.id });
  };
  const pickVersion = (v: Version) => {
    if (!data || v.id == data.published.version.id) return;
    publish({ mode: "manual", version: v }, { mode: "manual", versionId: v.id });
  };

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
        data = { ...data, current: r.current, versions: [r.current, ...data.versions], total: data.total + 1,
          published: data.published.mode == "latest" ? { mode: "latest", version: r.current } : data.published };
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
  pubCurrent.addEventListener("click", () => {
    if (!data || pubCurrent.getAttribute("aria-disabled") == "true") return;
    // The server cuts a version of edits not yet in one first, so this is the document up to the keystroke.
    publish({ mode: "manual", version: data.current }, { mode: "manual", versionId: data.current.id });
  });

  // ------------------------------------------------------------ rendering

  const canEdit = () => !!data?.canEdit && !publishing;
  const desc = (v: Version) => (v.description ? esc(v.description) : `<span class="ds-desc-none">Describing the changes…</span>`);
  const whoWhen = (v: Version) => [ago(v.at), v.authors.join(", ")].filter(Boolean).join(" · ");

  function render() {
    if (!data) {
      modeBtn.innerHTML = `<span class="ds-val"><span>${loadError ? "Unavailable" : "Loading…"}</span></span>${CHEV}`;
      modeBtn.setAttribute("aria-disabled", "true");
      pickField.hidden = true;
      explainEl.textContent = "";
      pubError.textContent = loadError ? `Couldn't load the versions: ${loadError}` : "";
      list.innerHTML = loadError ? "" : `<li aria-hidden="true" style="display:block"><div class="ds-skel" style="width:70%"></div><div class="ds-skel" style="width:45%"></div><div class="ds-skel" style="width:60%"></div></li>`;
      totalEl.textContent = "";
      foot.hidden = true;
      return;
    }
    const { published: pub, current } = data;
    const manual = pub.mode == "manual";
    modeBtn.innerHTML = `<span class="ds-val"><span>${manual ? "Manual" : "Latest"}</span></span>${CHEV}`;
    for (const b of [modeBtn, pickBtn]) if (!canEdit()) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled");
    pickField.hidden = !manual;
    pickBtn.innerHTML = `<span class="ds-val"><span class="ds-n">v${pub.version.n}</span><span>${desc(pub.version)}</span></span>${CHEV}`;
    const newer = current.n - pub.version.n;
    // Edits not yet cut into a version count too: publishing cuts them first (the server's next version).
    const unpublished = newer > 0 || !!data.pending;
    pubCurrent.hidden = !manual || !unpublished || !data.canEdit;
    pubCurrent.textContent = newer > 0 ? `Publish the current version (v${current.n})` : "Publish the latest edits";
    pubCurrent.title = "Viewers see the document as it is now, up to the keystroke";
    if (publishing) pubCurrent.setAttribute("aria-disabled", "true"); else pubCurrent.removeAttribute("aria-disabled");
    explainEl.textContent = !data.canEdit
      ? `Only the document's editors can change what's published. Viewers see version ${pub.version.n}${manual ? "" : ", the latest"}.`
      : publishing ? "Saving…"
      : !manual ? "Viewers see the latest version, up to the keystroke."
      : newer > 0 ? `Viewers see version ${pub.version.n} until you pick another. ${plural(newer, "newer version")} ${newer == 1 ? "isn't" : "aren't"} published.`
      : data.pending ? `Viewers see version ${pub.version.n} until you pick another. The latest edits aren't published.`
      : "Viewers see this version until you pick another, even as the document changes.";

    totalEl.textContent = data.total > 1 ? `${data.total} in all` : "";
    // The list is drawn afresh: an Edit button that had focus keeps it.
    const focused = (document.activeElement as HTMLElement | null)?.closest?.("#ds-list [data-restore]")?.getAttribute("data-restore");
    list.innerHTML = data.versions.slice(0, RECENT).map((v) => {
      const tags = [v.id == current.id ? `<span class="ds-tag">Current</span>` : "", v.id == pub.version.id ? `<span class="ds-tag pub">Published</span>` : ""].join("");
      const edit = v.id == current.id || !data!.canEdit ? ""
        : `<button type="button" class="ds-edit${restoring == v.id ? " busy" : ""}" data-restore="${esc(v.id)}" aria-label="Edit version ${v.n}: make a copy of it the current version" title="Make a copy of version ${v.n} the current version, to edit it">${restoring == v.id ? "Restoring…" : "Edit"}</button>`;
      return `<li data-n="${v.n}"><span class="ds-n">v${v.n}</span><span class="ds-desc">${desc(v)}</span><span class="ds-tags">${tags}</span><span class="ds-meta" title="${esc(new Date(v.at).toLocaleString())}">${esc(whoWhen(v))}</span>${edit}</li>`;
    }).join("");
    if (focused) [...list.querySelectorAll<HTMLElement>("[data-restore]")].find((b) => b.dataset.restore == focused)?.focus();
    const shown = Math.min(RECENT, data.versions.length);
    foot.hidden = data.total <= shown;
    foot.textContent = manual ? `The latest ${shown} of ${data.total}. The published-version menu reaches the older ones.` : `The latest ${shown} of ${data.total}.`;
    renderMenu();
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
      : home.isHome ? "The site's front page shows this document. Each version you publish goes live a few minutes later."
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
    if (can) { redeploy.removeAttribute("aria-disabled"); redeploy.title = "Deploy the published version now"; }
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
      siteBody.innerHTML = `<div class="ds-site-live"><a href="${esc(st.site.url)}" target="_blank" rel="noopener" id="ds-site-link">${esc(st.site.hostname)}</a>${EXT}</div>
        <div class="ds-deploy"><div class="ds-status" role="status" aria-live="polite"><span class="ds-dot ${d.state}" aria-hidden="true"></span>${line}</div></div>
        ${st.canEdit ? `<div class="ds-site-acts">
          <button type="button" class="ds-btn" id="ds-site-deploy"${can ? "" : ` aria-disabled="true"`}>${d.state == "deploying" ? "Deploying…" : "Deploy now"}</button>
          <a class="ds-btn" href="${esc(st.site.dashboard)}" target="_blank" rel="noopener">Open in Cloudflare</a>
          <button type="button" class="ds-quiet${removeArmed ? " armed" : ""}" id="ds-site-remove"${siteBusy ? ` aria-disabled="true"` : ""}>${removeArmed ? "Click again to take it down" : "Remove"}</button>
        </div>` : ""}
        <p class="ds-site-foot">From ${esc(st.site.by)}’s Cloudflare account. Each new published version goes live there within a minute.</p>`;
      return;
    }
    const c = st.connection;
    if (!c.connected) {
      siteBody.innerHTML = `<p class="ds-explain">Publish this document at a domain of yours, such as <b>notes.example.com</b>. It is served from your own Cloudflare account, and follows each published version.</p>
        <div class="ds-site-go"><a class="ds-btn primary" id="ds-site-connect" href="/settings#cloudflare" target="_blank" rel="noopener">${c.unreadable ? "Connect Cloudflare again" : "Connect Cloudflare"}</a></div>`;
      return;
    }
    const zones = st.zones ?? [];
    if (!zones.length) {
      siteBody.innerHTML = `<p class="ds-explain">${esc(st.zonesError ? "" : "Your Cloudflare token reaches no domains. Add a domain to Cloudflare, or give the token Zone Read on your domains.")}</p>
        <div class="ds-site-go"><a class="ds-btn" href="/settings#cloudflare" target="_blank" rel="noopener">Cloudflare settings</a></div>`;
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
      <p class="ds-explain">Cloudflare serves the published version from your account (${esc(c.accounts.map((a) => a.name).join(", "))}). Leave the name empty to use the domain itself.</p>`;
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
    if (b.id == "ds-site-deploy") return siteCall("site/deploy", { method: "POST" }, "Couldn't deploy");
    if (b.id == "ds-site-remove") {
      if (!removeArmed) { removeArmed = true; renderSite(); setTimeout(() => { removeArmed = false; renderSite(); }, 4000); return; }
      removeArmed = false;
      await siteCall("site", { method: "DELETE" }, "Couldn't take the site down");
    }
  });
  // Back from connecting Cloudflare in another tab: the section shows the domains.
  window.addEventListener("focus", () => { if (!pop.hidden && site && !site.connection.connected) loadSite(); });

  // ------------------------------------------------------------ menus

  // A listbox under its button, on the page itself (fixed), so the popover's
  // scrolling never cuts it off. Focus moves into it; the arrows, Home and
  // End move, Enter or Space chooses, Escape or Tab closes it.
  interface Item { id: string; html: string; selected?: boolean; separator?: boolean; act(): void | Promise<void>; keepOpen?: boolean; label: string }
  let menu: { kind: "mode" | "pick"; el: HTMLElement; btn: HTMLElement; items: Item[]; active: number } | null = null;

  function items(kind: "mode" | "pick"): Item[] {
    if (!data) return [];
    if (kind == "mode") {
      const m = data.published.mode;
      return [
        { id: "ds-opt-latest", label: "Latest", selected: m == "latest", act: () => setMode("latest"),
          html: `<span class="ds-opt-title">Latest</span><span class="ds-opt-sub">Viewers see every change, up to the keystroke.</span>` },
        { id: "ds-opt-manual", label: "Manual", selected: m == "manual", act: () => setMode("manual"),
          html: `<span class="ds-opt-title">Manual</span><span class="ds-opt-sub">Viewers see the version you pick, until you pick another.</span>` },
      ];
    }
    const cur = data.current.id, pub = data.published.version.id;
    return pickerRows(loaded, data.total).map((r: Row): Item => {
      if (r.kind == "more") {
        return { id: `ds-more-${r.before}`, keepOpen: true, label: `Show ${r.older ? "older" : "more"} versions (${r.count})`, act: () => loadMore(r.before, r.count),
          html: `<span></span><span class="ds-more"><span class="ds-dots">···</span> ${plural(r.count, r.older ? "older version" : "more version")}</span>` };
      }
      const v = r.v;
      const tag = v.id == cur ? ` <span class="ds-tag">Current</span>` : "";
      return { id: `ds-ver-${v.n}`, selected: v.id == pub, label: `Version ${v.n}: ${v.description ?? "not described yet"}${v.id == cur ? ", current" : ""}`, act: () => pickVersion(v),
        html: `${CHECK}<span class="ds-ver"><span class="ds-n">v${v.n}</span><span class="ds-desc">${desc(v)}</span>${tag}<span class="ds-when">${esc(ago(v.at))}</span></span>` };
    });
  }
  async function loadMore(before: string, count: number) {
    if (!menu) return;
    const epoch = loadedEpoch;
    const at = menu.active;
    const r = await call<Versions>("versions", undefined, { before, limit: String(Math.min(count, RECENT)) }).catch((e: Error) => { pubError.textContent = `Couldn't load more versions: ${e.message}`; return null; });
    if (!r || epoch != loadedEpoch) return;
    add(r.versions);
    renderMenu();
    // The first of the newly loaded versions, where the row was.
    if (menu) { menu.active = Math.min(at, menu.items.length - 1); paintActive(); }
  }
  function openMenu(kind: "mode" | "pick", btn: HTMLElement) {
    closeMenu(false);
    if (btn.getAttribute("aria-disabled") == "true" || !data) return;
    const el = document.createElement("div");
    el.className = "ds-menu";
    el.id = `ds-menu-${kind}`;
    el.setAttribute("role", "listbox");
    el.setAttribute("aria-labelledby", kind == "mode" ? "ds-mode-label" : "ds-pick-label");
    el.tabIndex = -1;
    document.body.append(el);
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-controls", el.id);
    menu = { kind, el, btn, items: [], active: 0 };
    renderMenu();
    menu.active = Math.max(0, menu.items.findIndex((i) => i.selected));
    paintActive();
    place();
    el.focus();
    el.addEventListener("keydown", menuKey);
    el.addEventListener("pointermove", (e) => {
      const o = (e.target as Element).closest<HTMLElement>("[role=option]");
      if (o && menu) { const i = menu.items.findIndex((it) => it.id == o.id); if (i >= 0 && i != menu.active) { menu.active = i; paintActive(false); } }
    });
    el.addEventListener("click", (e) => {
      const o = (e.target as Element).closest<HTMLElement>("[role=option]");
      if (!o || !menu) return;
      const i = menu.items.findIndex((it) => it.id == o.id);
      if (i >= 0) choose(i);
    });
  }
  function renderMenu() {
    if (!menu) return;
    const activeId = menu.items[menu.active]?.id;
    menu.items = items(menu.kind);
    menu.el.innerHTML = menu.items.map((i) => `<div role="option" id="${i.id}" aria-selected="${!!i.selected}" aria-label="${esc(i.label)}">${i.html}</div>`).join("");
    const keep = menu.items.findIndex((i) => i.id == activeId);
    if (keep >= 0) menu.active = keep;
    paintActive(false);
    place();
  }
  function paintActive(scroll = true) {
    if (!menu) return;
    menu.active = Math.max(0, Math.min(menu.active, menu.items.length - 1));
    for (const o of menu.el.querySelectorAll(".active")) o.classList.remove("active");
    const it = menu.items[menu.active];
    const o = it && menu.el.querySelector<HTMLElement>(`#${it.id}`);
    if (!o) return;
    o.classList.add("active");
    menu.el.setAttribute("aria-activedescendant", it.id);
    if (scroll) o.scrollIntoView({ block: "nearest" });
  }
  function place() {
    if (!menu) return;
    const r = menu.btn.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, menu.kind == "mode" ? 300 : 340), vw - 16);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    const below = vh - r.bottom - 12, above = r.top - 12;
    const natural = menu.el.scrollHeight + 2;
    const down = below >= Math.min(natural, 240) || below >= above;
    const max = Math.max(120, Math.min(natural, down ? below : above, 420));
    Object.assign(menu.el.style, { left: `${left}px`, width: `${width}px`, maxHeight: `${max}px`, top: down ? `${r.bottom + 4}px` : `${r.top - 4 - Math.min(natural, max)}px` });
  }
  function choose(i: number) {
    if (!menu) return;
    const it = menu.items[i];
    if (!it) return;
    if (it.keepOpen) { menu.active = i; it.act(); return; }
    closeMenu(true);
    it.act();
  }
  function closeMenu(focus: boolean) {
    if (!menu) return;
    const { el, btn } = menu;
    menu = null;
    el.remove();
    btn.setAttribute("aria-expanded", "false");
    btn.removeAttribute("aria-controls");
    if (focus) btn.focus();
  }
  function menuKey(e: KeyboardEvent) {
    if (!menu) return;
    const n = menu.items.length;
    if (e.key == "ArrowDown") menu.active = (menu.active + 1) % n;
    else if (e.key == "ArrowUp") menu.active = (menu.active - 1 + n) % n;
    else if (e.key == "Home") menu.active = 0;
    else if (e.key == "End") menu.active = n - 1;
    else if (e.key == "Enter" || e.key == " ") { e.preventDefault(); choose(menu.active); return; }
    else if (e.key == "Tab") { closeMenu(false); return; }
    else return;
    e.preventDefault();
    paintActive();
  }
  for (const [btn, kind] of [[modeBtn, "mode"], [pickBtn, "pick"]] as const) {
    btn.addEventListener("click", () => (menu?.btn == btn ? closeMenu(true) : openMenu(kind, btn)));
    btn.addEventListener("keydown", (e) => { if (e.key == "ArrowDown" || e.key == "ArrowUp") { e.preventDefault(); openMenu(kind, btn); } });
  }

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
      closeMenu(false);
      clearInterval(ticker);
      return;
    }
    position();
    pubError.textContent = "";
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
    (modeBtn.getAttribute("aria-disabled") == "true" ? pop : modeBtn).focus();
  }
  const contains = (node: Node) => pop.contains(node) || !!menu?.el.contains(node);
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (menu && !menu.el.contains(t) && !menu.btn.contains(t)) closeMenu(false);
    if (!pop.hidden && !contains(t) && !host.anchor.contains(t)) toggle(false);
  }, true);
  // A click into the page (another document, out of reach of pointerdown here) closes it too.
  window.addEventListener("blur", () => setTimeout(() => { if (!pop.hidden && document.activeElement?.tagName == "IFRAME") toggle(false); }, 0));
  window.addEventListener("resize", () => { if (!pop.hidden) { position(); place(); } });

  const pending: Record<string, number> = {};
  return {
    toggle,
    isOpen: () => !pop.hidden,
    escape() {
      if (menu) { closeMenu(true); return true; }
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
  };
}

window.ergaSettings = { mount };
