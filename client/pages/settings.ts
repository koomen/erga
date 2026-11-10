// Document settings: the popover under the gear in the editor's top row
// (client/editor.html, #btn-settings). Built on its own, so it
// costs viewing the page nothing: the editor mounts it once it's idle. It reads what it shows
// as it mounts, keeps it fresh from the event channel (and again behind as the pointer comes
// to the gear), so a click opens it whole on the next frame, and nothing pops in after.
//
// Readers always see the document as it is now. No line of help anywhere: what needs a word has a hover tip
// (data-tip, which tip() sets). It holds, top to bottom:
//   - Document (one page, and files beside it) or Project (pages, each with its own address), a switch (set_kind).
//     A project with more than one page can't be a document yet: its tip says why.
//   - Page details: the page shown now, with its icon, title and description, and Edit, which opens its details
//     (client/pages/page-head.ts: its title, description, icon and link picture, in its <head>).
//   - Viewer settings, for anyone who may edit it (their state from ls's access): whether the people who view it, and
//     can't edit it, see Erga's header bar (share_document's reader_bars; on at first), and whether they may use the
//     Erga agent on it (reader_agent). The agent is off, and not to be turned on, while anyone with the link may open
//     it. And whether its page may call a model as its visitor, which, and for whom: signed-in viewers or all of them
//     (page_llm, page_llm_model, page_llm_who: window.ergaLLM).
//   - Homepage, only on the homepage: one line, with its own domain (a link) when it has one, with how its deploy is going and Deploy (admins), which is blue when
//     the document is newer than the live page. Nothing deploys by itself. The homepage is chosen on /admin/settings
//     (the landing_document setting), never here.
//   - Versions: the latest ten, each with its number, the model's five-word
//     description (a quiet placeholder until it arrives), when and who; the
//     current one marked, and on the homepage the deployed one. A deployed version older than the latest ten shows
//     in its own place: the latest five, a gap, then five around it (two newer, it, two older); only those five are
//     read. Show older versions loads the ten before the oldest one shown. Edit, on hover or
//     focus, makes a copy of a version the current one (restore_version).
//
// It runs the operations (server/operations/: versions, restore_version, ls, set_kind, deploy_homepage,
// share_document; over POST /api/tools/<name>), and refreshes on the event channel's
// { type: "versions" }, { type: "home" } and { type: "tree" } (main.ts passes them on), open or not.
// Someone who can't edit sees it all read-only.

import { ago, clock, RECENT, type Version, type Versions } from "./versions";
import { runTool } from "../common/tools";
import { esc } from "../../shared/html";
import { EDITORS_READ_VERSIONS } from "../../document/content";
import { isModelChoice, MODELS, PROVIDER_LABEL } from "../../shared/models";
import { openPageHead } from "./page-head";
import { headUrl, tabTitle, type PageHead } from "../../shared/page-head";

export interface Deploy {
  state: "idle" | "deploying" | "deployed" | "failed";
  at: string | null;
  version: number | null;
  error: string | null;
}
/** ls's homepage: on the homepage only. */
export interface Home {
  isHome: boolean;
  canDeploy: boolean /** An admin acting through a token without the admin scope. */;
  locked?: boolean /** Its own domain, or null. */;
  domain?: string | null;
  deploy: Deploy;
}
export type DocKind = "document" | "project";
/** ls's answer, as far as this panel reads it. */
interface Tree {
  entries: { path: string; type: string; head?: PageHead }[];
  canEdit?: boolean;
  kind?: DocKind;
  /** The document's own page; and its title. */
  index?: string;
  title?: string;
}
/** ls's access, as far as Readers need it (the readers' options, for anyone who may edit it). */
type Access = {
  readerAgent: boolean;
  readerBars: boolean;
  /** models: the ones the owner may choose now (Claude's, and OpenAI's where the server has a key). */
  pageLlm: { on: boolean; model: string; models: string[]; who: "signed_in" | "all" };
  anyoneWithLink: boolean;
};
interface Doc extends Tree {
  homepage?: Home;
  access?: Access;
}

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
.ds-error:empty { display: none; }
/* A hover tip: plain text in a small card, under the control, inside the panel. */
.ds [data-tip] { position: relative; }
.ds [data-tip]::after {
  content: attr(data-tip); position: absolute; left: 0; top: calc(100% + 6px); z-index: 5; width: max-content; max-width: 250px;
  padding: 6px 9px; border-radius: 7px; border: 1px solid var(--panel-border); background: var(--bg); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  font: 400 12px/1.4 var(--font-text); color: var(--soft); text-align: left; white-space: normal; text-transform: none; letter-spacing: 0;
  opacity: 0; pointer-events: none; transition: opacity 80ms ease 250ms;
}
.ds :is(.ds-btn, [data-kind="project"])[data-tip]::after { left: auto; right: 0; }
@media (hover: hover) { .ds [data-tip]:hover::after { opacity: 1; } }
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
.ds-list li.ds-gap { display: block; padding: 3px 0 3px 42px; font-size: 11.5px; color: var(--chrome); }
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
/* (Never opacity on a control with a tip: its tip would fade too.) */
.ds-kind button[aria-disabled="true"] { color: color-mix(in srgb, var(--soft) 50%, transparent); cursor: not-allowed; }
.ds-kind button[aria-disabled="true"]:hover { color: color-mix(in srgb, var(--soft) 50%, transparent); }
/* Page details: the icon and the title on one line, the description under them, and Edit. */
.ds-page-row { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; align-items: center; margin-top: 8px; }
.ds-page-title { display: flex; align-items: center; gap: 8px; min-width: 0; font: 600 13px/1.35 var(--font-text); color: var(--fg-strong, var(--fg)); }
.ds-page-title span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-page-icon { flex: none; width: 16px; height: 16px; border-radius: 3px; object-fit: contain; }
span.ds-page-icon { background: color-mix(in srgb, var(--chrome) 35%, transparent); }
.ds-page-desc { grid-column: 1; margin: 0; font-size: 12.5px; line-height: 1.4; color: var(--soft); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ds-page-desc:empty { display: none; }
.ds-page-row .ds-btn { grid-column: 2; grid-row: 1 / span 2; }
/* Viewer settings: three switches and the model, for anyone who may edit it. */
.ds-checks { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-top: 10px; }
.ds-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fg); cursor: pointer; }
.ds-check input { margin: 0; width: 15px; height: 15px; accent-color: var(--caret); cursor: inherit; }
.ds-check:has(input:disabled) { color: var(--chrome); cursor: default; }
.ds-check input:disabled { opacity: 0.55; }
.ds-llm-opts { display: flex; flex-wrap: wrap; gap: 8px; margin: -2px 0 0 23px; }
.ds-llm-model { min-width: 150px; height: 28px; padding: 0 26px 0 9px; border: 1px solid var(--rule); border-radius: 7px; color: var(--fg); font: 12.5px var(--font-text); cursor: pointer;
  appearance: none; -webkit-appearance: none; background: var(--bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1a9' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E") no-repeat right 7px center / 13px; }
.ds-llm-model:hover:not(:disabled) { border-color: color-mix(in srgb, var(--chrome) 55%, var(--rule)); }
.ds-llm-model:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
.ds-llm-model:disabled { opacity: 0.55; cursor: default; }
.ds-llm-model[hidden] { display: none; }
/* The homepage, only on the homepage: one line, and Deploy. */
.ds-deploy { display: flex; align-items: center; gap: 10px; }
.ds-deploy > svg { flex: none; align-self: flex-start; margin-top: 1px; width: 16px; height: 16px; fill: none; stroke: var(--caret); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.ds-home-text { flex: 1; min-width: 0; font-size: 12.5px; line-height: 1.4; color: var(--soft); }
.ds-home-text a { font-weight: 500; color: var(--caret); text-decoration: none; }
.ds-home-text a:hover { text-decoration: underline; text-underline-offset: 2px; }
.ds-home-text b { display: block; font: 600 13px/1.35 var(--font-text); color: var(--fg-strong, var(--fg)); }
.ds-status span { white-space: nowrap; }
.ds-dot { display: inline-block; margin-right: 6px; vertical-align: 0; width: 8px; height: 8px; border-radius: 50%; }
.ds-dot.failed { background: #d0453a; }
.ds-dot.deploying { vertical-align: -1px; width: 10px; height: 10px; background: transparent; border: 1.6px solid color-mix(in srgb, var(--caret) 25%, transparent); border-top-color: var(--caret); box-sizing: border-box; animation: agent-spin 0.8s linear infinite; }
.ds-btn { flex: none; font: 600 12.5px var(--font-text); border-radius: 7px; padding: 6px 11px; cursor: pointer; border: 1px solid var(--panel-border); background: var(--bg); color: var(--fg); white-space: nowrap; }
.ds-btn:hover { border-color: color-mix(in srgb, var(--chrome) 45%, var(--panel-border)); }
.ds-btn:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
.ds-btn[aria-disabled="true"] { color: var(--chrome); cursor: default; }
.ds-btn.newer { border-color: var(--caret); background: var(--caret); color: #fff; }
.ds-btn.newer:hover { border-color: var(--caret); background: color-mix(in srgb, var(--caret) 88%, #000); }
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


/** The page model menu's options, under their providers' names. */
function modelOptions(models: string[]): string {
  const known = models.filter(isModelChoice);
  return [...new Set(known.map((m) => MODELS[m].provider))]
    .map(
      (p) =>
        `<optgroup label="${PROVIDER_LABEL[p]}">${known
          .filter((m) => MODELS[m].provider == p)
          .map((m) => `<option value="${m}">${MODELS[m].label}</option>`)
          .join("")}</optgroup>`
    )
    .join("");
}

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
    <section class="ds-kind-sec">
      <div class="ds-kind" id="ds-kind" role="radiogroup" aria-label="Kind">
        <button type="button" role="radio" data-kind="document" aria-checked="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/></svg>Document</button>
        <button type="button" role="radio" data-kind="project" aria-checked="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>Project</button>
      </div>
      <p class="ds-error" id="ds-kind-error" role="alert"></p>
    </section>
    <section class="ds-page" id="ds-page" hidden aria-labelledby="ds-page-title">
      <h3 id="ds-page-title">Page details</h3>
      <div class="ds-page-row"><div class="ds-page-title" id="ds-page-tab"></div><p class="ds-page-desc" id="ds-page-desc"></p><button type="button" class="ds-btn" id="ds-page-edit" aria-label="Edit the page's details">Edit</button></div>
    </section>
    <section class="ds-agent" id="ds-agent" hidden aria-labelledby="ds-agent-title">
      <h3 id="ds-agent-title">Viewer settings</h3>
      <div class="ds-checks">
        <label class="ds-check" id="ds-bars"><input type="checkbox" id="ds-bars-on">Show the Erga header bar</label>
        <label class="ds-check" id="ds-agent-label"><input type="checkbox" id="ds-agent-on">Viewers can use the Erga agent</label>
        <label class="ds-check" id="ds-llm" data-tip="The page's script can ask this model for each viewer (window.ergaLLM). The server pays, with an hourly limit."><input type="checkbox" id="ds-llm-on">Viewers have access to the LLM API</label>
        <div class="ds-llm-opts">
          <select class="ds-llm-model" id="ds-llm-who" aria-label="Who may use it" hidden><option value="signed_in">Signed-in viewers</option><option value="all">All viewers</option></select>
          <select class="ds-llm-model" id="ds-llm-model" aria-label="The model"></select>
        </div>
      </div>
      <p class="ds-error" id="ds-agent-error" role="alert"></p>
    </section>
    <section class="ds-home" id="ds-home" hidden aria-labelledby="ds-home-note">
      <div class="ds-deploy" id="ds-deploy">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/></svg>
        <div class="ds-home-text"><b id="ds-home-note">Homepage</b><span class="ds-status" id="ds-status" role="status" aria-live="polite"></span></div>
        <button type="button" class="ds-btn" id="ds-redeploy">Deploy</button>
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
  const list = $("ds-list"),
    totalEl = $("ds-total"),
    foot = $("ds-foot"),
    footText = $("ds-foot-text"),
    olderBtn = $("ds-older"),
    histError = $("ds-hist-error");
  const homeSec = $("ds-home");
  const statusEl = $("ds-status"),
    redeploy = $("ds-redeploy"),
    homeError = $("ds-home-error");
  const kindBox = $("ds-kind"),
    kindError = $("ds-kind-error");
  const agentSec = $("ds-agent"),
    agentOn = $<HTMLInputElement>("ds-agent-on"),
    agentError = $("ds-agent-error"),
    barsOn = $<HTMLInputElement>("ds-bars-on"),
    llmOn = $<HTMLInputElement>("ds-llm-on"),
    llmModel = $<HTMLSelectElement>("ds-llm-model"),
    llmWho = $<HTMLSelectElement>("ds-llm-who");

  /** A hover tip ("" removes it): the same words for a screen reader. */
  const tip = (el: Element, text: string) => {
    if (text) {
      el.setAttribute("data-tip", text);
      el.setAttribute("aria-description", text);
    } else {
      el.removeAttribute("data-tip");
      el.removeAttribute("aria-description");
    }
  };
  tip($("ds-llm"), $("ds-llm").dataset.tip!);

  // ------------------------------------------------------------ state

  let data: Versions | null = null;
  let loadError: string | null = null;
  /** Every version loaded, by number: the latest ten, and the older ones Show older versions brought. */
  let loaded = new Map<number, Version>();
  let home: Home | null = null;
  let homeBusy = false;
  let loadSeq = 0,
    docSeq = 0;
  /** The tree as last read: its pages (a project with more than one can't be a document yet) and whether you may change it. */
  let tree: Tree | null = null;
  /** The kind being switched to, while the server does it. */
  let kindBusy: DocKind | null = null;
  /** Readers, for anyone who may edit it (ls answers no one else): their bars and their agent, and whether anyone with the link may open it. */
  let access: Access | null = null;
  let agentBusy = false;

  const add = (vs: Version[]) => { for (const v of vs) loaded.set(v.n, v); };
  /** The loaded versions, newest first. */
  const shown = () => [...loaded.values()].sort((a, b) => b.n - a.n);
  async function loadVersions() {
    const seq = ++loadSeq;
    try {
      const d = await runTool<Versions>("versions", { document: host.docId });
      if (seq != loadSeq) return;
      // What was loaded before stays (older versions shown), with the fresh copies over it.
      if (data && d.total < data.total) loaded = new Map();
      add(d.versions); add([d.current]);
      data = d;
      loadError = null;
      render();
      renderHome();
      loadAround();
    } catch (e) {
      if (seq != loadSeq) return;
      loadError = (e as Error).message;
      // No longer theirs to read (they may only view now): what was shown goes.
      if (loadError == EDITORS_READ_VERSIONS) {
        data = null;
        loaded = new Map();
      }
      // What was shown stays, saying it may be out of date.
      if (data) histError.textContent = `Couldn't refresh the versions: ${loadError}`;
      else render();
    }
  }
  /** Show older versions: the ten before the oldest one shown. */
  let loadingOlder = false;
  async function loadOlder() {
    const oldest = visible().at(-1);
    if (!data || !oldest || oldest.n <= 1 || loadingOlder) return;
    loadingOlder = true;
    render();
    const r = await runTool<Versions>("versions", { document: host.docId, before: oldest.id, limit: RECENT }).catch((e: Error) => {
      histError.textContent = `Couldn't load older versions: ${e.message}`;
      return null;
    });
    loadingOlder = false;
    if (r) add(r.versions);
    render();
  }
  olderBtn.addEventListener("click", () => loadOlder());
  /** The homepage's deployed version, on the homepage only. */
  const deployed = () => (home?.isHome ? home.deploy.version : null);
  /** The deployed version, when it's older than the latest ten: the list shows it apart, after a gap. */
  const apart = () => {
    const d = deployed();
    return data && d != null && d < (data.versions.at(-1)?.n ?? 1) ? d : null;
  };
  /** The versions the list shows, newest first: with a deployed version apart, the latest five, then from two newer than it down. */
  const visible = () => {
    const all = shown(),
      d = apart();
    return d == null ? all : [...all.slice(0, 5), ...all.filter((v) => v.n <= d + 2)];
  };
  /** The five around a deployed version that's apart: read only those, once. */
  let aroundSeq = 0;
  async function loadAround() {
    const d = apart();
    if (d == null || loaded.has(d)) return;
    const seq = ++aroundSeq;
    const r = await runTool<Versions>("versions", { document: host.docId, before: `v${d + 3}`, limit: 5 }).catch((e: Error) => {
      histError.textContent = `Couldn't load the deployed version: ${e.message}`;
      return null;
    });
    if (!r || seq != aroundSeq) return;
    add(r.versions);
    render();
  }
  /** The document as ls answers it: its tree and kind, the homepage's state (on the homepage), and its access (for the owner). */
  async function loadDoc() {
    const seq = ++docSeq;
    const d = await runTool<Doc>("ls", { document: host.docId }).catch(() => null);
    if (seq != docSeq) return;
    if (d) {
      tree = d;
      if (d.kind) host.onKind(d.kind);
    }
    home = d?.homepage ?? null;
    access = d?.access ?? null;
    renderKind();
    renderHome();
    renderAgent();
    renderPage();
    if (data) render();
    loadAround();
  }

  /** The page shown now: its file, the tab's title, and Details. */
  const pageSec = $("ds-page");
  const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? "";
  const shownPage = () => tree?.entries.find((e) => e.type == "page" && e.path == (meta("erga-page") || tree?.index));
  function renderPage() {
    const p = shownPage();
    pageSec.hidden = !p;
    if (!p) return;
    const head = p.head ?? {};
    const icon = head.icon ? headUrl(head.icon, p.path, meta("erga-pages") || `${location.origin}/`) : null;
    $("ds-page-tab").innerHTML =
      `${icon ? `<img class="ds-page-icon" alt="" src="${esc(icon)}">` : `<span class="ds-page-icon"></span>`}<span>${esc(tabTitle(head, tree?.title ?? ""))}</span>`;
    $("ds-page-desc").textContent = head.description ?? "";
  }
  $("ds-page-edit").addEventListener("click", () => {
    const p = shownPage();
    if (!p || !tree) return;
    toggle(false);
    openPageHead({
      docId: host.docId,
      page: p.path,
      head: p.head ?? {},
      docTitle: tree.title ?? "",
      images: tree.entries.filter((e) => e.type == "file" && /\.(png|jpe?g|gif|webp|svg|ico|avif)$/i.test(e.path)).map((e) => e.path),
      canEdit: !!tree.canEdit,
      files: meta("erga-pages"),
      onSaved: (head) => {
        p.head = head;
        renderPage();
        loadDoc();
      },
    });
  });

  function renderAgent() {
    agentSec.hidden = !access;
    if (!access) return;
    agentOn.checked = access.readerAgent;
    barsOn.checked = access.readerBars;
    barsOn.disabled = agentBusy;
    llmOn.checked = access.pageLlm.on;
    // The choices, and the model chosen now even when the server's keys no longer run it.
    const { model, models } = access.pageLlm;
    const shown = models.includes(model) ? models : [model, ...models];
    if ([...llmModel.options].map((o) => o.value).join() != shown.join()) llmModel.innerHTML = modelOptions(shown);
    llmModel.value = model;
    llmWho.value = access.pageLlm.who;
    // Who may call it: only while it's on.
    llmWho.hidden = !access.pageLlm.on;
    llmOn.disabled = llmModel.disabled = llmWho.disabled = agentBusy;
    agentOn.disabled = access.anyoneWithLink || agentBusy;
    tip($("ds-agent-label"), access.anyoneWithLink ? "Anyone with the link can open it, so viewers have no agent here." : "");
  }
  /** One of the switches (share_document's options): the server's answer says what holds now. */
  async function setReader(options: Record<string, boolean | string>) {
    agentBusy = true;
    agentError.textContent = "";
    renderAgent();
    try {
      access = await runTool<Access>("share_document", { document: host.docId, ...options });
    } catch (e) {
      agentError.textContent = `Couldn't change it: ${(e as Error).message}`;
    }
    agentBusy = false;
    renderAgent();
  }
  agentOn.addEventListener("change", () => setReader({ reader_agent: agentOn.checked }));
  barsOn.addEventListener("change", () => setReader({ reader_bars: barsOn.checked }));
  // Each sends only its own change: a model the server's keys no longer run stays chosen (share_document refuses it).
  llmOn.addEventListener("change", () => setReader({ page_llm: llmOn.checked }));
  llmModel.addEventListener("change", () => setReader({ page_llm_model: llmModel.value }));
  llmWho.addEventListener("change", () => setReader({ page_llm_who: llmWho.value }));

  /** Edit on a version: a copy of it becomes the current version (the previous current one stays a version). */
  let restoring: string | null = null;
  async function restore(id: string) {
    if (!data || restoring) return;
    const v = [...loaded.values()].find((x) => x.id == id);
    restoring = id;
    histError.textContent = "";
    render();
    try {
      const r = await runTool<{ current: Version }>("restore_version", { document: host.docId, version: id });
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
    // A deployed version apart: the latest five, a gap, then what's loaded from two newer than it down.
    const vs = visible(),
      d = apart();
    const row = (v: Version) => {
      const tags = [v.id == current.id ? "Current" : "", v.n == deployed() ? "Deployed" : ""]
        .filter(Boolean)
        .map((t) => `<span class="ds-tag">${t}</span>`)
        .join("");
      const edit =
        v.id == current.id || !data!.canEdit
          ? ""
        : `<button type="button" class="ds-edit${restoring == v.id ? " busy" : ""}" data-restore="${esc(v.id)}" aria-label="Edit version ${v.n}: make a copy of it the current version" title="Make a copy of version ${v.n} the current version, to edit it">${restoring == v.id ? "Restoring…" : "Edit"}</button>`;
      return `<li data-n="${v.n}"><span class="ds-n">v${v.n}</span><span class="ds-desc">${desc(v)}</span><span class="ds-tags">${tags}</span><span class="ds-meta" title="${esc(new Date(v.at).toLocaleString())}">${esc(whoWhen(v))}</span>${edit}</li>`;
    };
    const hidden = d == null || vs.length <= 5 ? 0 : vs[4].n - vs[5].n - 1;
    list.innerHTML = vs
      .map(
        (v, i) => (i == 5 && hidden ? `<li class="ds-gap" aria-label="${hidden} versions not shown">… ${hidden} more</li>` : "") + row(v)
      )
      .join("");
    if (focused) [...list.querySelectorAll<HTMLElement>("[data-restore]")].find((b) => b.dataset.restore == focused)?.focus();
    const older = (vs.at(-1)?.n ?? 1) > 1;
    foot.hidden = !older;
    footText.textContent = d == null ? `The latest ${vs.length} of ${data.total}.` : `${vs.length} of ${data.total}.`;
    olderBtn.textContent = loadingOlder ? "Loading…" : "Show older versions";
    if (loadingOlder) olderBtn.setAttribute("aria-disabled", "true"); else olderBtn.removeAttribute("aria-disabled");
  }

  /** Only on the homepage: a note that says so, and its deploy (Deploy for admins). Nothing elsewhere. */
  function renderHome() {
    homeSec.hidden = !home?.isHome;
    if (!home || !home.isHome) return;
    const d = home.deploy;
    // Its own domain, a link that opens it there (with this server's port, locally).
    const site = home.domain ? `${location.protocol}//${home.domain}${location.port ? `:${location.port}` : ""}/` : "";
    $("ds-home-note").innerHTML =
      `Homepage${site ? ` · <a id="ds-home-domain" href="${esc(site)}" target="_blank" rel="noopener">${esc(home.domain!)}</a>` : ""}`;
    // Each part keeps its words together, and the line wraps only between them.
    const at = d.at
      ? `<span>Deployed ${esc(clock(d.at))}</span>${d.version != null ? ` <span>· version ${d.version}</span>` : ""}`
      : `<span>Not deployed yet</span>`;
    statusEl.innerHTML =
      d.state == "deploying"
        ? `<span class="ds-dot deploying" aria-hidden="true"></span>Deploying…`
        : d.state == "failed"
          ? `<span class="ds-dot failed" aria-hidden="true"></span>Failed: ${esc(d.error || "the deploy didn't finish.")} ${d.at ? at : ""}`
          : at;
    // Redeploy is an admin's: others see how the deploy goes, and no button.
    redeploy.hidden = !host.admin;
    const can = home.canDeploy && d.state != "deploying" && !homeBusy;
    // The document has versions the live page hasn't: Deploy is blue, and its tip says so.
    const now = data?.current.n;
    const newer = d.state != "deploying" && now != null && d.version != null && now > d.version;
    redeploy.classList.toggle("newer", newer && can);
    if (can) redeploy.removeAttribute("aria-disabled");
    else redeploy.setAttribute("aria-disabled", "true");
    tip(
      redeploy,
      !can
        ? home.locked
          ? "This token has no admin power."
          : "A deploy is running."
        : newer
          ? `The document is at version ${now}: the live page is older.`
          : "Deploy the document as it is now."
    );
    redeploy.textContent = d.state == "deploying" ? "Deploying…" : "Deploy";
  }

  /** Document or Project: the kind now, whether you may switch, and why a project can't be a document yet. */
  function renderKind() {
    const kind = kindBusy ?? tree?.kind ?? host.kind();
    const canEdit = tree?.canEdit ?? false;
    const pages = (tree?.entries ?? []).filter((e) => e.type == "page");
    // A document has one page: a project with more can't be one until the others go (nothing is deleted for you).
    const blocked =
      kind == "project" && pages.length > 1 ? `A document has one page. This project has ${pages.length}: delete the others first.` : null;
    const only = tree && !canEdit ? " Only its editors can change this." : "";
    for (const b of kindBox.querySelectorAll<HTMLElement>("[data-kind]")) {
      const on = b.dataset.kind == kind;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      const off = !canEdit || !!kindBusy || (b.dataset.kind == "document" && !on && !!blocked);
      if (off) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled");
      const doc = b.dataset.kind == "document";
      tip(
        b,
        (doc && blocked
          ? blocked
          : doc
            ? "A document is one page, with its files beside it."
            : "A project has pages, each with its own address.") + only
      );
    }
  }
  async function switchKind(want: DocKind) {
    const now = tree?.kind ?? host.kind();
    if (want == now || kindBusy || !tree?.canEdit) return;
    kindBusy = want;
    kindError.textContent = "";
    renderKind();
    try {
      await runTool("set_kind", { document: host.docId, kind: want });
      tree = { ...tree, kind: want };
      host.onKind(want);
    } catch (e) { kindError.textContent = `Couldn't make it a ${want}: ${(e as Error).message}`; }
    kindBusy = null;
    renderKind();
    loadDoc();
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
  redeploy.addEventListener("click", async () => {
    if (redeploy.getAttribute("aria-disabled") == "true") return;
    homeBusy = true;
    homeError.textContent = "";
    if (home) home = { ...home, deploy: { ...home.deploy, state: "deploying", error: null } };
    renderHome();
    try {
      await runTool("deploy_homepage", {});
    } catch (e) {
      homeError.textContent = `Couldn't deploy: ${(e as Error).message}`;
    }
    homeBusy = false;
    loadDoc();
  });

  // ------------------------------------------------------------ the popover

  // What it shows, read as it mounts (the editor's idle time, chrome.ts), kept fresh by the event channel and read
  // again behind as the pointer or focus comes to the gear: a click opens it whole, on the next frame.
  loadVersions();
  loadDoc();
  let readAt = 0;
  const again = () => {
    if (!pop.hidden || Date.now() - readAt < 2000) return;
    readAt = Date.now();
    loadVersions();
    loadDoc();
  };
  host.anchor.addEventListener("pointerenter", again);
  host.anchor.addEventListener("focus", again);

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
    // (A refresh that failed while it was closed says so.)
    histError.textContent = loadError && data ? `Couldn't refresh the versions: ${loadError}` : "";
    kindError.textContent = "";
    agentError.textContent = "";
    render();
    renderHome();
    renderKind();
    renderAgent();
    renderPage();
    if (!data) loadVersions();
    // Relative times ("4 min ago") move on while it's open, every 30 seconds.
    ticker = window.setInterval(() => { render(); renderHome(); }, 30_000);
    pop.tabIndex = -1;
    pop.focus();
  }
  const contains = (node: Node) => pop.contains(node);
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (!pop.hidden && !contains(t) && !host.anchor.contains(t)) toggle(false);
  }, true);
  // A click into the page (another document, out of reach of pointerdown here) closes it too: the shell's onPointer (main.ts).
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
      // Open or not, so that it opens with what holds now. A burst (a version cut, then its description) is one refresh.
      if (type != "home" && type != "versions" && type != "tree") return;
      const key = type == "versions" ? type : "doc";
      clearTimeout(pending[key]);
      pending[key] = window.setTimeout(() => (key == "doc" ? loadDoc() : loadVersions()), 120);
    },
    contains,
  };
}

window.ergaSettings = { mount };
