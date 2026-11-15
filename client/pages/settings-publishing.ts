// Document settings' Publishing section (client/pages/settings.ts mounts it), for anyone who may edit the document
// (ls's publishing: server/operations/publishing.ts): "Publish to", a menu of the server's domains, each with the
// document that has it now or "Free", which starts at "Not published" (set_publishing); "Show the Erga header bar",
// which works only on the Erga domain; and one line with how its publish is going and Publish (publish_document),
// which is blue when the document is newer than the live version. Nothing publishes by itself. A domain that another
// document has, and a domain left while it serves something, ask first, in the panel (confirmStep). Only an admin
// changes any of it: anyone else sees it grey, with a tip that says why.

import { clock } from "./versions";
import { runTool } from "../common/tools";
import { esc } from "../../shared/html";

/** A domain of "Publish to": its name, whether it is the Erga domain, and the document that has it now (null: free). */
interface Choice {
  domain: string;
  erga: boolean;
  document: { id: string; title: string } | null;
}
/** ls's publishing (server/operations/publishing.ts, publishingOf). */
export interface Publishing {
  domains: Choice[];
  /** This document's domain, or null: not published. */
  domain: string | null;
  bars: boolean;
  state: "free" | "linked" | "publishing" | "published" | "failed";
  /** This document's live version there, and when it went live. */
  at: string | null;
  version: number | null;
  /** The domain serves something now: this document's version, or still the one before's. */
  serving: boolean;
  error: string | null;
  canPublish: boolean;
}

export const PUBLISHING_CSS = `/* Publishing: "Publish to" and its menu, the header bar, and one line with Publish. */
.ds-field { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; font-size: 13px; color: var(--fg); position: relative; }
.ds-field[aria-disabled="true"] { color: var(--chrome); }
.ds-select { display: inline-flex; align-items: center; justify-content: space-between; gap: 14px; min-width: 150px; max-width: 220px; height: 28px; padding: 0 9px; border: 1px solid var(--rule); border-radius: 7px; background: var(--bg); color: var(--fg); font: 12.5px var(--font-text); cursor: pointer; }
.ds-select span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-select::after { content: ""; flex: none; width: 13px; height: 13px; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1a9' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E") center / 13px no-repeat; }
.ds-select:hover:not([aria-disabled="true"]) { border-color: color-mix(in srgb, var(--chrome) 55%, var(--rule)); }
.ds-select:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
.ds-select[aria-disabled="true"] { color: var(--chrome); cursor: default; }
.ds-menu { margin: 6px 0 0; padding: 4px; list-style: none; border: 1px solid var(--panel-border); border-radius: 9px; background: var(--bg); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12); }
.ds-menu li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 8px; border-radius: 6px; font-size: 12.5px; color: var(--fg); cursor: pointer; }
.ds-menu li span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-menu li span + span { flex: none; max-width: 55%; color: var(--chrome); }
.ds-menu li.at { background: color-mix(in srgb, var(--caret) 12%, transparent); }
.ds-menu li[aria-selected="true"] span:first-child { font-weight: 600; }
.ds-confirm { margin: 10px 0 0; padding: 10px 12px; border-radius: 9px; background: #fff7e6; border: 1px solid #f2dfb4; }
.ds-confirm p { margin: 0 0 8px; font-size: 12.5px; line-height: 1.45; color: #6b4e12; }
.ds-confirm-acts { display: flex; justify-content: flex-end; gap: 8px; }
html.page-dark body:not(.source) .ds-confirm { background: color-mix(in srgb, #d9a441 14%, transparent); border-color: color-mix(in srgb, #d9a441 35%, transparent); }
html.page-dark body:not(.source) .ds-confirm p { color: #ecd9a8; }
.ds-publish { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--rule); }
.ds-publish > svg { flex: none; align-self: flex-start; margin-top: 1px; width: 16px; height: 16px; fill: none; stroke: var(--caret); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.ds-pub-text { flex: 1; min-width: 0; font-size: 12.5px; line-height: 1.4; color: var(--soft); }
.ds-pub-text b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 13px/1.35 var(--font-text); color: var(--fg-strong, var(--fg)); }
.ds-status span { white-space: nowrap; }
.ds-dot { display: inline-block; margin-right: 6px; vertical-align: 0; width: 8px; height: 8px; border-radius: 50%; background: var(--chrome); }
.ds-dot.live { background: #2f9e5b; }
.ds-dot.failed { background: #d0453a; }
.ds-dot.publishing { vertical-align: -1px; width: 10px; height: 10px; background: transparent; border: 1.6px solid color-mix(in srgb, var(--caret) 25%, transparent); border-top-color: var(--caret); box-sizing: border-box; animation: agent-spin 0.8s linear infinite; }
`;

export const PUBLISHING_HTML = `    <section class="ds-pub" id="ds-pub" hidden aria-labelledby="ds-pub-title">
      <h3 id="ds-pub-title">Publishing</h3>
      <div class="ds-field" id="ds-pub-field"><span id="ds-pub-label">Publish to</span><button type="button" class="ds-select" id="ds-pub-domain" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="ds-pub-menu" aria-labelledby="ds-pub-label ds-pub-domain"><span></span></button></div>
      <ul class="ds-menu" id="ds-pub-menu" role="listbox" aria-labelledby="ds-pub-label" hidden></ul>
      <div class="ds-confirm" id="ds-pub-confirm" role="group" aria-labelledby="ds-pub-ask" hidden>
        <p id="ds-pub-ask"></p>
        <div class="ds-confirm-acts"><button type="button" class="ds-btn" id="ds-pub-cancel">Cancel</button><button type="button" class="ds-btn newer" id="ds-pub-ok"></button></div>
      </div>
      <div class="ds-checks" id="ds-pub-checks"><label class="ds-check" id="ds-bars"><input type="checkbox" id="ds-bars-on">Show the Erga header bar</label></div>
      <div class="ds-publish">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>
        <div class="ds-pub-text"><b id="ds-pub-name"></b><span class="ds-status" id="ds-status" role="status" aria-live="polite"></span></div>
        <button type="button" class="ds-btn" id="ds-publish">Publish</button>
      </div>
      <p class="ds-error" id="ds-pub-error" role="alert"></p>
    </section>
`;

export interface PublishingHost {
  /** The settings popover. */
  pop: HTMLElement;
  docId: string;
  /** A hover tip ("" removes it). */
  tip(el: Element, text: string): void;
  /** The document's current version's number, if the versions are read. */
  current(): number | null;
  /** The publishing changed: what else shows it draws again. */
  changed(): void;
  /** Read the document again. */
  reload(): void;
}

export interface PublishingSection {
  /** ls's publishing, as just read (null: not for this person). */
  set(pub: Publishing | null): void;
  get(): Publishing | null;
  render(): void;
  /** The popover opens: no question, no menu, no error from before. */
  reset(): void;
  /** Escape: closes the menu or the question. False if neither was open. */
  escape(): boolean;
}

export function publishingSection(host: PublishingHost): PublishingSection {
  const { pop, tip } = host;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => pop.querySelector<T>(`#${id}`)!;
  const pubSec = $("ds-pub"),
    pubField = $("ds-pub-field"),
    pubDomain = $("ds-pub-domain"),
    pubMenu = $("ds-pub-menu"),
    pubConfirm = $("ds-pub-confirm"),
    pubAsk = $("ds-pub-ask"),
    pubOk = $("ds-pub-ok"),
    pubChecks = $("ds-pub-checks"),
    pubName = $("ds-pub-name"),
    statusEl = $("ds-status"),
    publish = $("ds-publish"),
    pubError = $("ds-pub-error");
  const barsOn = $<HTMLInputElement>("ds-bars-on");
  let pub: Publishing | null = null;
  let pubBusy = false;

  /** A question the panel asks before a change of the domain: its words, the button's, and what a yes does. */
  let confirmStep: { ask: string; ok: string; yes: () => void } | null = null;
  /** The menu's row the keys are at, while it's open. */
  let menuAt = -1;
  const NONE = "Not published";
  /** The menu's rows: "Not published", then each domain. */
  const rows = () => [null, ...(pub?.domains ?? [])];
  const why = () => (pub && !pub.canPublish ? "Only an admin can publish." : "");

  /** For everyone who may edit the document: its domain, its header bar, and how its publish goes. */
  function renderPub() {
    pubSec.hidden = !pub;
    if (!pub) return;
    const can = pub.canPublish && !pubBusy;
    const erga = pub.domains.find((d) => d.erga)?.domain ?? "";
    const here = pub.domains.find((d) => d.domain == pub!.domain);
    // "Publish to": the document's domain, or "Not published".
    pubDomain.querySelector("span")!.textContent = pub.domain ?? NONE;
    for (const el of [pubField, pubDomain])
      if (can) el.removeAttribute("aria-disabled");
      else el.setAttribute("aria-disabled", "true");
    tip(pubDomain, why());
    if (!can) openMenu(false);
    pubMenu.innerHTML = rows()
      .map((d, i) => {
        const has = !d ? "" : d.document ? (d.document.id == host.docId ? "This document" : d.document.title) : "Free";
        return `<li role="option" id="ds-pub-o${i}" data-i="${i}" aria-selected="${(d?.domain ?? null) == pub!.domain}"${i == menuAt ? ' class="at"' : ""}><span>${esc(d?.domain ?? NONE)}</span>${d ? `<span>${esc(has)}</span>` : ""}</li>`;
      })
      .join("");
    // A question, while one waits: the header bar steps aside for it.
    pubConfirm.hidden = !confirmStep;
    pubChecks.hidden = !!confirmStep;
    if (confirmStep) {
      pubAsk.innerHTML = confirmStep.ask;
      pubOk.textContent = confirmStep.ok;
    }
    // The header bar: only on the Erga domain.
    barsOn.checked = pub.bars;
    barsOn.disabled = !can || !here?.erga;
    tip($("ds-bars"), why() || (here?.erga ? "" : `The Erga header bar can only be shown on ${erga}`));
    // The line: the domain, and how the publish goes. Each part keeps its words together, and the line wraps only between them.
    pubName.textContent = pub.domain ?? NONE;
    const at = pub.at
      ? `<span>Published ${esc(clock(pub.at))}</span>${pub.version != null ? ` <span>· version ${pub.version}</span>` : ""}`
      : "";
    const dot = (kind: string) => `<span class="ds-dot ${kind}" aria-hidden="true"></span>`;
    statusEl.innerHTML = !pub.domain
      ? `${dot("")}Choose a domain to publish`
      : pub.state == "publishing"
        ? `${dot("publishing")}Publishing…`
        : pub.state == "failed"
          ? `${dot("failed")}Failed: ${esc(pub.error || "the publish didn't finish.")} ${at}`
          : at
            ? dot("live") + at
            : `${dot("")}Not published yet`;
    // Publish: for a document with a domain. Blue when the document has versions the live site hasn't, or none is live.
    const ready = can && !!pub.domain && pub.state != "publishing" && !confirmStep;
    const now = host.current();
    const newer = pub.version == null || (now != null && now > pub.version);
    publish.classList.toggle("newer", ready && newer);
    if (ready) publish.removeAttribute("aria-disabled");
    else publish.setAttribute("aria-disabled", "true");
    tip(
      publish,
      why() ||
        (!pub.domain
          ? "Choose a domain first."
          : !ready
            ? ""
            : pub.version != null && newer
              ? `The document is at version ${now}: the live site is older.`
              : "Publish the document as it is now.")
    );
    publish.textContent = pub.state == "publishing" ? "Publishing…" : "Publish";
  }

  function openMenu(open: boolean) {
    if (open == !pubMenu.hidden) return;
    pubMenu.hidden = !open;
    pubDomain.setAttribute("aria-expanded", String(open));
    menuAt = open
      ? Math.max(
          0,
          rows().findIndex((d) => (d?.domain ?? null) == pub?.domain)
        )
      : -1;
    markMenu();
  }
  function markMenu() {
    pubMenu.querySelectorAll("li").forEach((li, i) => li.classList.toggle("at", i == menuAt));
    if (menuAt >= 0) pubDomain.setAttribute("aria-activedescendant", `ds-pub-o${menuAt}`);
    else pubDomain.removeAttribute("aria-activedescendant");
  }
  /** The server's answer to a change says what holds now. */
  async function setPublishing(args: Record<string, unknown>) {
    pubBusy = true;
    pubError.textContent = "";
    renderPub();
    try {
      pub = (await runTool<{ publishing: Publishing }>("set_publishing", { document: host.docId, ...args })).publishing;
    } catch (e) {
      pubError.textContent = `Couldn't change it: ${(e as Error).message}`;
    }
    pubBusy = false;
    renderPub();
    host.changed();
  }
  /**
   * A domain chosen in the menu (null: "Not published"). It asks first when the document leaves a domain that serves
   * something (the site goes at once), and when another document has the new domain (it is unlinked).
   */
  function choose(to: Choice | null) {
    openMenu(false);
    if (!pub || (to?.domain ?? null) == pub.domain) return;
    const from = pub.domain;
    const other = to?.document && to.document.id != host.docId ? to.document : null;
    const set = () => {
      confirmStep = null;
      void setPublishing({ domain: to?.domain ?? "", ...(other ? { replace: true } : {}) });
    };
    const replace = () => {
      if (!other) return set();
      const title = `<strong>${esc(other.title)}</strong>`;
      confirmStep = {
        ask: `${title} is currently published to ${esc(to!.domain)}. Link this document instead? Visitors will see ${title} until this document is published.`,
        ok: "Link this document",
        yes: set,
      };
      renderPub();
      pubOk.focus();
    };
    if (from && pub.serving) {
      confirmStep = { ask: `Confirm you want to unpublish ${esc(from)}?`, ok: "Unpublish", yes: replace };
      renderPub();
      pubOk.focus();
    } else replace();
  }
  pubDomain.addEventListener("click", () => {
    if (pubDomain.getAttribute("aria-disabled") != "true") openMenu(!!pubMenu.hidden);
  });
  // A listbox's keys: the arrows move, Enter or Space chooses. (Escape closes it: `escape`, below.)
  pubDomain.addEventListener("keydown", (e) => {
    if (pubDomain.getAttribute("aria-disabled") == "true") return;
    const n = rows().length;
    if (e.key == "ArrowDown" || e.key == "ArrowUp") {
      e.preventDefault();
      if (pubMenu.hidden) return openMenu(true);
      menuAt = (menuAt + (e.key == "ArrowDown" ? 1 : n - 1)) % n;
      markMenu();
    } else if ((e.key == "Enter" || e.key == " ") && !pubMenu.hidden) {
      e.preventDefault();
      choose(rows()[menuAt] ?? null);
    }
  });
  // A click elsewhere in the panel closes the menu.
  pop.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (!pubMenu.contains(t) && !pubDomain.contains(t)) openMenu(false);
  });
  pubMenu.addEventListener("click", (e) => {
    const li = (e.target as Element).closest<HTMLElement>("li[data-i]");
    if (li) choose(rows()[Number(li.dataset.i)] ?? null);
  });
  pubOk.addEventListener("click", () => confirmStep?.yes());
  $("ds-pub-cancel").addEventListener("click", () => {
    confirmStep = null;
    renderPub();
    pubDomain.focus();
  });
  barsOn.addEventListener("change", () => setPublishing({ bars: barsOn.checked }));
  publish.addEventListener("click", async () => {
    if (publish.getAttribute("aria-disabled") == "true") return;
    pubBusy = true;
    pubError.textContent = "";
    if (pub) pub = { ...pub, state: "publishing", error: null };
    renderPub();
    try {
      pub = (await runTool<{ publishing: Publishing }>("publish_document", { document: host.docId })).publishing;
    } catch (e) {
      pubError.textContent = `Couldn't publish: ${(e as Error).message}`;
    }
    pubBusy = false;
    renderPub();
    host.changed();
    host.reload();
  });

  return {
    set(next) {
      pub = next;
      renderPub();
    },
    get: () => pub,
    render: renderPub,
    reset() {
      pubError.textContent = "";
      confirmStep = null;
      openMenu(false);
    },
    escape() {
      if (pubMenu.hidden && !confirmStep) return false;
      confirmStep = null;
      openMenu(false);
      renderPub();
      pubDomain.focus();
      return true;
    },
  };
}
