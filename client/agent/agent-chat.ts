// The agent panel's conversation, as both agents' panels draw it: the
// editor's and the admin's, on every admin page.
// It renders the transcript into the panel's log, keeps it
// following the agent's output as a terminal does, and shows a message the
// moment it's sent, dimmed until the agent's host echoes it back (or with
// "Not sent" and a way to try again). The styles are style.css's (.agent-log,
// .msg-*), so both panels look the same.

import { emptyLog, reduce, type Log, type LogEvent, type LogItem, type Offer } from "../../shared/agent-log";
import type { FileRef } from "../../shared/attach";
import { fileChip } from "./attach-ui";

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const inline = (s: string) => escapeHtml(s).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

export interface ChatOptions {
  /** The log's element (#agent-log) and its "Jump to latest" button. */
  logEl: HTMLElement;
  jump: HTMLButtonElement;
  /** What a tool call says while it runs, and once done: [doing, done]; others show their name. */
  verbs: Record<string, [string, string]>;
  /** The tooltip on a call an outside agent made (the share button's), as "External agent:". */
  externalTip?: string;
  /** The alt text of a picture a tool returned. */
  imageAlt?: string;
}

export interface Chat {
  /** The transcript as drawn. */
  readonly log: Log;
  /** Draws the whole log again (a tab that just loaded, a reset), at the bottom. */
  render(): void;
  /** One event from the agent's host: the transcript and the log follow it. */
  apply(ev: LogEvent): void;
  /** Follow the output (on), or stop (reading back). */
  follow(on: boolean): void;
  /** Keeps the log at the bottom while following. */
  pin(): void;
  /** A message just sent (with what's attached): shown dimmed until the host echoes it; `fail` says it wasn't sent, with Try again. */
  pending(text: string, files?: FileRef[]): { fail(reason: string, retry: () => void): void };
}

/**
 * A tool's offer, as a button under its call: Connect Cloudflare opens the consent in a popup (the control Worker's
 * /install/start), Connect GitHub the App's install page (the control Worker's /github/connect), and the button says
 * how it ended when the popup tells this page.
 * Only those two addresses: the tool's code makes the offer, but the panel trusts nothing else.
 */
function offerButton(offer: Offer): HTMLElement | null {
  let url: URL;
  try { url = new URL(offer.url, location.href); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || !["/install/start", "/github/connect"].includes(url.pathname) || url.searchParams.get("popup") != "1") return null;
  const github = url.pathname == "/github/connect", service = github ? "GitHub" : "Cloudflare";
  const wrap = document.createElement("span");
  wrap.className = "offer";
  const button = Object.assign(document.createElement("button"), { type: "button", className: "offer-button", textContent: offer.label });
  const note = Object.assign(document.createElement("span"), { className: "offer-note" });
  note.setAttribute("role", "status");
  const ended = (m: { ok?: boolean; error?: string }) => {
    note.textContent = m.ok ? "Connected." : `Not connected: ${m.error ?? `${service} didn't say why`}`;
    if (m.ok) button.disabled = true;
  };
  const onMessage = (e: MessageEvent) => {
    const m = e.data as { type?: string; ok?: boolean; error?: string } | null;
    if (!m || (m.type != "erga-deploy-credential" && m.type != "erga-github") || (e.origin != url.origin && e.origin != location.origin)) return;
    window.removeEventListener("message", onMessage);
    ended(m);
  };
  button.addEventListener("click", () => {
    const w = window.open(url.href, github ? "erga-github-connect" : "erga-cloudflare-consent", github ? "popup,width=720,height=820" : "popup,width=600,height=760");
    if (!w) { note.textContent = `The browser blocked the ${service} window. Allow pop-ups for this page, then click again.`; return; }
    note.textContent = github ? "Waiting for GitHub: pick the account and the repository in the window that opened." : "Waiting for Cloudflare: finish the consent in the window that opened.";
    window.addEventListener("message", onMessage);
    try { const bc = new BroadcastChannel(github ? "erga-github" : "erga-deploy-credential"); bc.onmessage = (e) => { bc.close(); onMessage(new MessageEvent("message", { data: e.data, origin: location.origin })); }; } catch { /* no BroadcastChannel */ }
  });
  wrap.append(button, note);
  return wrap;
}

export function chat(opts: ChatOptions): Chat {
  const { logEl, jump, verbs } = opts;
  const log: Log = emptyLog();
  let els: HTMLElement[] = [];

  /** A failed tool call that a later call on the same file got past is history, not an error. */
  const retried = (i: number) => {
    const item = log.items[i];
    if (item.kind != "tool" || item.status != "error") return false;
    return log.items.slice(i + 1).some((x) => x.kind == "tool" && x.status == "done" && x.path == item.path && (x.name == item.name || x.name == "write"));
  };
  /** A message of yours: its text, and what was attached, as chips (thumbnails for images). */
  function userMessage(el: HTMLElement, text: string, files?: FileRef[]) {
    if (text) el.append(text);
    if (!files?.length) return;
    const list = document.createElement("span");
    list.className = "msg-files";
    for (const f of files) list.append(fileChip(f));
    el.append(list);
  }
  function renderItem(item: LogItem, i: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "msg-" + item.kind;
    if (item.kind == "user") userMessage(el, item.text, item.files);
    else if (item.kind == "thinking" || item.kind == "error") el.textContent = item.text;
    else if (item.kind == "assistant") el.innerHTML = inline(item.text);
    else {
      const [doing, done] = verbs[item.name] ?? [item.name, item.name];
      const what = item.path ? ` <code>${escapeHtml(item.path)}</code>` : "";
      // A call from an agent you shared the page with (the share button) says so.
      const via = item.via == "external" ? `<span class="via" title="${escapeHtml(opts.externalTip ?? "An outside agent, working as your agent")}">External agent:</span> ` : "";
      if (retried(i)) {
        el.classList.add("retried");
        el.title = item.detail ?? "";
        el.innerHTML = `<span>${via}${doing}${what} didn't apply; retried</span>`;
      } else {
        el.classList.add(item.status);
        el.innerHTML = `<span>${via}${item.status == "running" ? doing : item.status == "error" ? `${doing} failed:` : done}${what}${item.detail ? `<span class="detail">${escapeHtml(item.detail)}</span>` : ""}${item.image ? `<img class="shot" alt="${escapeHtml(opts.imageAlt ?? "What the agent saw")}" src="${item.image}">` : ""}</span>`;
        if (item.status == "done" && item.offer) { const b = offerButton(item.offer); if (b) el.append(b); }
      }
    }
    return el;
  }

  // The log follows the agent's output, as a terminal does, until you
  // scroll back to read something; scrolling to the bottom again (or the
  // "Jump to latest" button, or sending a message) picks it back up. It's
  // kept pinned whenever the log's content changes size, not just when an
  // event arrives, so text that wraps later or a screenshot that loads after
  // its event doesn't leave it behind.
  let following = true, lastScrollTop = 0;
  const atBottom = () => logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= 8;
  function pin() {
    if (following) logEl.scrollTop = logEl.scrollHeight;
    else if (!atBottom()) jump.hidden = false;
  }
  function follow(on: boolean) {
    following = on;
    if (on) jump.hidden = true;
    pin();
  }
  // A wheel or touch moving up is you reading back: stop following at once,
  // before the next pin can pull you down again.
  logEl.addEventListener("wheel", (e) => { if (e.deltaY < 0 && logEl.scrollHeight > logEl.clientHeight) following = false; }, { passive: true });
  logEl.addEventListener("touchmove", () => { if (!atBottom()) following = false; }, { passive: true });
  logEl.addEventListener("keydown", (e) => { if (["ArrowUp", "PageUp", "Home"].includes(e.key)) following = false; });
  logEl.addEventListener("scroll", () => {
    if (atBottom()) follow(true);
    else if (following && logEl.scrollTop < lastScrollTop) following = false; // dragged the scrollbar up
    lastScrollTop = logEl.scrollTop;
  }, { passive: true });
  new MutationObserver(() => pin()).observe(logEl, { childList: true, subtree: true, characterData: true });
  new ResizeObserver(() => pin()).observe(logEl);
  logEl.addEventListener("load", () => pin(), true); // screenshots arrive after their event
  jump.addEventListener("click", () => follow(true));

  function render() {
    logEl.textContent = "";
    els = log.items.map((it, i) => renderItem(it, i));
    // Messages on their way (or that weren't sent, with Try again) stay at the end: a reconnect mustn't lose them.
    logEl.append(...els, ...loose);
    follow(true);
  }

  // A message shows in the log the moment it's sent, dimmed until the host
  // echoes it back as the conversation's (which replaces it).
  const sends: { text: string; el: HTMLElement }[] = [];
  /** The dimmed and the failed messages, not part of the transcript. */
  let loose: HTMLElement[] = [];
  const drop = (el: HTMLElement) => { loose = loose.filter((x) => x != el); el.remove(); };
  function apply(ev: LogEvent) {
    // The host's copy of a message sent from this tab takes the place of the dimmed one.
    if (ev.t == "user") {
      const i = sends.findIndex((p) => p.text == ev.text);
      if (i >= 0) { drop(sends[i].el); sends.splice(i, 1); }
    }
    const before = log.items.length;
    const i = reduce(log, ev);
    if (ev.t == "reset") { for (const el of loose) if (el.classList.contains("failed")) drop(el); render(); return; }
    if (i >= 0) {
      const el = renderItem(log.items[i], i);
      if (i < before) { els[i].replaceWith(el); els[i] = el; }
      else { logEl.append(el); els[i] = el; }
    }
    // A success may turn earlier failures on the same file into retries.
    if (ev.t == "tool" && ev.status == "done") {
      for (let j = 0; j < i; j++) if (retried(j) && !els[j].classList.contains("retried")) { const el = renderItem(log.items[j], j); els[j].replaceWith(el); els[j] = el; }
    }
    pin();
  }

  function pending(text: string, files?: FileRef[]) {
    const el = document.createElement("div");
    el.className = "msg-user pending";
    userMessage(el, text, files);
    logEl.append(el);
    loose.push(el);
    const p = { text, el };
    sends.push(p);
    // Asking something means you want to see the answer.
    follow(true);
    return {
      fail(reason: string, retry: () => void) {
        const at = sends.indexOf(p);
        if (at >= 0) sends.splice(at, 1);
        el.classList.replace("pending", "failed");
        const note = document.createElement("span");
        note.className = "send-failed";
        note.textContent = `Not sent: ${reason}. `;
        const again = Object.assign(document.createElement("button"), { type: "button", textContent: "Try again" });
        again.addEventListener("click", () => { drop(el); retry(); });
        note.append(again);
        el.append(note);
        pin();
      },
    };
  }

  return { log, render, apply, follow, pin, pending };
}
