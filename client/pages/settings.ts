// Document settings: the popover under the gear in the editor's top row
// (client/editor.html, #btn-settings). Built on its own and
// loaded only when the gear is reached for, so it
// costs viewing and opening the editor nothing.
//
// Readers always see the document as it is now. It holds, top to bottom:
//   - Kind: Document (one page, and files beside it) or Project (pages, each
//     with its own address), a switch (the tree's make_project and
//     make_document). A project with more than one page says, in place, why
//     it can't be a document yet.
//   - Homepage, only on the homepage: a note that says so, how its deploy is
//     going, and Redeploy now (admins). The homepage is chosen on /admin
//     (the landing_document setting), never here.
//   - Versions: the latest ten, each with its number, the model's five-word
//     description (a quiet placeholder until it arrives), when and who; the
//     current one marked; Show older versions loads ten more. Edit, on hover or
//     focus, makes a copy of a version the current one (POST .../versions/<id>/restore).
//
// It talks to the server's API as the shared contract says (document/versions.ts,
// server/home/api.ts, and the tree's API: document/host.ts), and refreshes on the event channel's
// { type: "versions" }, { type: "home" } and { type: "tree" } (main.ts passes them on).
// Someone who can't edit sees it all read-only.

import { ago, clock, RECENT, type Version, type Versions } from "./versions";
import { esc } from "../../shared/html";
import { plural } from "../../shared/time";

export interface Deploy { state: "idle" | "scheduled" | "deploying" | "deployed" | "failed"; at: string | null; scheduledFor: string | null; version: number | null; error: string | null }
/** GET /api/docs/<id>/home. */
export interface Home { isHome: boolean; canDeploy: boolean; /** An admin acting through a token without the admin scope. */ locked?: boolean; deploy: Deploy }
export type DocKind = "document" | "project";
/** GET /api/docs/<id>/tree, as far as this panel reads it. */
interface Tree { entries: { path: string; type: string }[]; canEdit?: boolean; kind?: DocKind }

export interface SettingsHost {
  /** The document's id (its /d/<id>). */
  docId: string;
  /** What every request carries (a local tab's ?user=), or "". */
  query: string;
  /** The gear. */
  anchor: HTMLElement;
  /** Whether you're an admin (the homepage's deploy is theirs). */
  admin: boolean;
  /** The document's kind as the editor knows it now (its hello, or the last "tree" event). */
  kind(): DocKind;
  /** The kind changed here: the editor shows it at once (the breadcrumb), before the event comes. */
  onKind(kind: DocKind): void;
  /** The popover opened or closed. */
  onToggle(open: boolean): void;
}

export interface Settings {
  toggle(open?: boolean): void;
  isOpen(): boolean;
  /** Escape: closes the popover. False if it wasn't open. */
  escape(): boolean;
  /** An event from the channel ("versions", "home", "tree"). */
  event(type: string): void;
  /** Whether a node is part of the popover. */
  contains(node: Node): boolean;
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
/* Document or Project: two halves of one control, the chosen one raised. */
.ds-kind { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 2px; border-radius: 9px; background: var(--code-bg); border: 1px solid var(--panel-border); }
.ds-kind button { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; padding: 4px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--soft); font: 600 13px/1.2 var(--font-text); cursor: pointer; transition: background-color 120ms ease, color 120ms ease; }
.ds-kind button svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.ds-kind button:hover { color: var(--fg); }
.ds-kind button[aria-checked="true"] { background: var(--bg); color: var(--fg-strong, var(--fg)); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.ds-kind button:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
.ds-kind button[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
.ds-kind button[aria-disabled="true"]:hover { color: var(--soft); }
/* The homepage: a note, only on the homepage. */
.ds-home-note { display: flex; align-items: center; gap: 8px; margin: 0; font: 600 13.5px/1.3 var(--font-text); color: var(--fg-strong, var(--fg)); }
.ds-home-note svg { flex: none; width: 16px; height: 16px; fill: none; stroke: var(--caret); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
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
.ds-quiet { font: 500 12px var(--font-text); color: var(--soft); background: none; border: 0; padding: 4px 2px; cursor: pointer; text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 0.2em; }
.ds-quiet:hover { color: var(--fg); }
@media (max-width: 520px) {
  .help.ds { z-index: 22; top: auto; left: 0; right: 0; bottom: 0; width: auto; max-height: min(82vh, calc(100% - var(--top-clear))); border-radius: 16px 16px 0 0; border-bottom: 0; padding-bottom: env(safe-area-inset-bottom); animation: ds-sheet 240ms var(--agent-ease, ease); }
  .ds section { padding: 14px 18px; }
  .ds-sheet-grip { display: block; width: 36px; height: 4px; margin: 8px auto -4px; border-radius: 2px; background: color-mix(in srgb, var(--chrome) 40%, transparent); }
}
.ds-sheet-grip { display: none; }
@keyframes ds-sheet { from { transform: translateY(40px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (pointer: coarse) { .ds-kind button { min-height: 38px; } }
@media (prefers-reduced-motion: reduce) { .ds-dot.deploying, .ds-skel { animation-duration: 3s; } .help.ds { animation: none; } }
`;


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
    <section class="ds-kind-sec" aria-labelledby="ds-kind-title">
      <h3 id="ds-kind-title">Kind</h3>
      <div class="ds-kind" id="ds-kind" role="radiogroup" aria-labelledby="ds-kind-title" aria-describedby="ds-kind-explain">
        <button type="button" role="radio" data-kind="document" aria-checked="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/></svg>Document</button>
        <button type="button" role="radio" data-kind="project" aria-checked="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>Project</button>
      </div>
      <p class="ds-explain" id="ds-kind-explain"></p>
      <p class="ds-error" id="ds-kind-error" role="alert"></p>
    </section>
    <section class="ds-home" id="ds-home" hidden aria-labelledby="ds-home-note">
      <p class="ds-home-note" id="ds-home-note"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/></svg>This is the homepage</p>
      <p class="ds-explain" id="ds-home-explain"></p>
      <div class="ds-deploy" id="ds-deploy">
        <div class="ds-status" id="ds-status" role="status" aria-live="polite"></div>
        <button type="button" class="ds-btn" id="ds-redeploy">Redeploy now</button>
      </div>
      <p class="ds-error" id="ds-home-error" role="alert"></p>
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
  const homeSec = $("ds-home"), homeExplain = $("ds-home-explain");
  const statusEl = $("ds-status"), redeploy = $("ds-redeploy"), homeError = $("ds-home-error");
  const kindBox = $("ds-kind"), kindExplain = $("ds-kind-explain"), kindError = $("ds-kind-error");

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
  let loadSeq = 0, homeSeq = 0, treeSeq = 0;
  /** The tree as last read: its pages (a project with more than one can't be a document yet) and whether you may change it. */
  let tree: Tree | null = null;
  /** The kind being switched to, while the server does it. */
  let kindBusy: DocKind | null = null;

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

  async function loadTree() {
    const seq = ++treeSeq;
    const t = await call<Tree>("tree").catch(() => null);
    if (seq != treeSeq) return;
    if (t) { tree = t; if (t.kind) host.onKind(t.kind); }
    renderKind();
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

  /** Only on the homepage: a note that says so, and its deploy (Redeploy for admins). Nothing elsewhere. */
  function renderHome() {
    homeSec.hidden = !home?.isHome;
    if (!home || !home.isHome) return;
    const d = home.deploy;
    homeExplain.textContent = "The site's front page shows this document. Each new version goes live a few minutes later.";
    const live = d.version != null ? ` · version ${d.version}` : "";
    const last = d.at ? `Last deployed ${esc(clock(d.at))}${live}.` : "Not deployed yet.";
    const line = d.state == "deploying" ? `<b>Deploying…</b>`
      : d.state == "scheduled" && d.scheduledFor ? `<span><b>Scheduled for ${esc(clock(d.scheduledFor))}</b> (${esc(until(d.scheduledFor))}). ${last}</span>`
      : d.state == "failed" ? `<span><b>Failed:</b> ${esc(d.error || "the deploy didn't finish.")} ${d.at ? last : ""}</span>`
      : d.at ? `<span><b>Deployed</b> at ${esc(clock(d.at))}${live}</span>` : `<span>Not deployed yet</span>`;
    statusEl.innerHTML = `<span class="ds-dot ${d.state}" aria-hidden="true"></span>${line}`;
    // Redeploy is an admin's: others see how the deploy goes, and no button.
    redeploy.hidden = !host.admin;
    const can = home.canDeploy && d.state != "deploying" && !homeBusy;
    if (can) { redeploy.removeAttribute("aria-disabled"); redeploy.title = "Deploy the document as it is now"; }
    else { redeploy.setAttribute("aria-disabled", "true"); redeploy.title = home.locked ? "This token has no admin power." : "A deploy is running."; }
    redeploy.textContent = d.state == "deploying" ? "Deploying…" : "Redeploy now";
  }

  /** Document or Project: the kind now, whether you may switch, and why a project can't be a document yet. */
  function renderKind() {
    const kind = kindBusy ?? tree?.kind ?? host.kind();
    const canEdit = tree?.canEdit ?? false;
    const pages = (tree?.entries ?? []).filter((e) => e.type == "page");
    // A document has one page: a project with more can't be one until the others go (nothing is deleted for you).
    const blocked = kind == "project" && pages.length > 1 ? `It has ${pages.length} pages, and a document has one. Delete the others first.` : null;
    for (const b of kindBox.querySelectorAll<HTMLElement>("[data-kind]")) {
      const on = b.dataset.kind == kind;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      const off = !canEdit || !!kindBusy || (b.dataset.kind == "document" && !on && !!blocked);
      if (off) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled");
    }
    kindExplain.textContent = blocked ?? (kind == "project" ? "Pages, each with its own address. The title, top left, opens them."
      : "One page, with its files beside it. A project has more pages.");
    if (tree && !canEdit) kindExplain.textContent += " Only its editors can change this.";
  }
  async function switchKind(want: DocKind) {
    const now = tree?.kind ?? host.kind();
    if (want == now || kindBusy || !tree?.canEdit) return;
    kindBusy = want;
    kindError.textContent = "";
    renderKind();
    try {
      await call("tree", { method: "POST", body: JSON.stringify({ op: want == "project" ? "make_project" : "make_document" }) });
      tree = { ...tree, kind: want };
      host.onKind(want);
    } catch (e) { kindError.textContent = `Couldn't make it a ${want}: ${(e as Error).message}`; }
    kindBusy = null;
    renderKind();
    loadTree();
  }
  kindBox.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-kind]");
    if (b && b.getAttribute("aria-disabled") != "true") switchKind(b.dataset.kind as DocKind);
  });
  // A radio group's keys: the arrows move to the other choice and choose it.
  kindBox.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const other = kindBox.querySelector<HTMLElement>(`[data-kind="${(tree?.kind ?? host.kind()) == "document" ? "project" : "document"}"]`)!;
    if (other.getAttribute("aria-disabled") == "true") return;
    other.focus();
    switchKind(other.dataset.kind as DocKind);
  });
  function until(iso: string): string {
    const ms = Date.parse(iso) - Date.now();
    const m = Math.round(ms / 60000);
    return m <= 0 ? "any moment" : `in ${plural(m, "minute")}`;
  }

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
    kindError.textContent = "";
    render();
    renderHome();
    renderKind();
    loadVersions();
    loadHome();
    loadTree();
    // Relative times ("4 min ago", "in 3 minutes") move on while it's open, every 30 seconds.
    ticker = window.setInterval(() => { render(); renderHome(); }, 30_000);
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
      if (type != "home" && type != "versions" && type != "tree") return;
      clearTimeout(pending[type]);
      pending[type] = window.setTimeout(() => (type == "home" ? loadHome() : type == "tree" ? loadTree() : loadVersions()), 120);
    },
    contains,
  };
}

window.ergaSettings = { mount };
