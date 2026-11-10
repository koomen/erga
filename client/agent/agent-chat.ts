// The agent panel's conversation, as both agents' panels draw it: the
// editor's and the admin's, on every admin page.
// It renders the transcript into the panel's log, keeps it
// following the agent's output as a terminal does, and shows a message the
// moment it's sent, dimmed until the agent's host echoes it back (or with
// "Not sent" and a way to try again): sends.ts has each message's states. The
// styles are style.css's (.agent-log, .msg-*), so both panels look the same.

import { emptyLog, reduce, type Log, type LogEvent, type LogItem } from "../../shared/agent-log";
import type { FileRef } from "../../shared/attach";
import { fileChip } from "./attach-ui";
import { sendStep, type SendEvent, type SendState } from "./sends";
import { esc } from "../../shared/html";

const inline = (s: string) =>
  esc(s)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

export interface ChatOptions {
  /** The log's element (#agent-log) and its "Jump to latest" button. */
  logEl: HTMLElement;
  jump: HTMLButtonElement;
  /** What a tool call says while it runs, and once done: [doing, done]; others show their name. */
  verbs: Record<string, [string, string]>;
  /** The tooltip on a call an outside agent made (the share button's), as "External agent:". */
  externalTip?: string;
  /** The person's click on Approve or Deny, for the tool call `id` that waits for it. */
  answer?: (id: string, approve: boolean) => void;
  /** The alt text of a picture a tool returned. */
  imageAlt?: string;
}

export interface Chat {
  /** The transcript as drawn. */
  readonly log: Log;
  /**
   * Draws the whole log again (a tab that just loaded, a reset), at the bottom; a log already drawn the same (as the
   * tab's last page left it) stays as it is, at its scroll place.
   */
  render(): void;
  /** The transcript's markup as drawn, without the messages on their way. */
  drawn(): string;
  /** One event from the agent's host: the transcript and the log follow it. */
  apply(ev: LogEvent): void;
  /** Follow the output (on), or stop (reading back). */
  follow(on: boolean): void;
  /** Keeps the log at the bottom while following. */
  pin(): void;
  /**
   * A message just sent (with what's attached), with the tab's id for it: shown dimmed until the transcript has a
   * message with that id. `resend` sends it again, with the same id (Try again).
   */
  pending(id: string, text: string, files: FileRef[] | undefined, resend: () => void): void;
  /** The message `id` wasn't sent: it says so, with Try again. */
  failed(id: string, reason: string): void;
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
      const what = item.path ? ` <code>${esc(item.path)}</code>` : "";
      // A call from an agent you shared the page with (the share button) says so.
      const via =
        item.via == "external"
          ? `<span class="via" title="${esc(opts.externalTip ?? "An outside agent, working as your agent")}">External agent:</span> `
          : "";
      if (item.status == "asking") {
        // The agent's call waits for the person: what it would do, in the server's words, and their answer.
        el.classList.add("asking");
        el.innerHTML = `<span>Your agent asks to:<span class="detail">${esc(item.detail ?? item.name)}</span></span><span class="ask-acts"><button type="button" data-answer="deny" data-call="${esc(item.id)}">Deny</button><button type="button" class="run" data-answer="approve" data-call="${esc(item.id)}">Approve</button></span>`;
      } else if (retried(i)) {
        el.classList.add("retried");
        el.title = item.detail ?? "";
        el.innerHTML = `<span>${via}${doing}${what} didn't apply; retried</span>`;
      } else {
        el.classList.add(item.status);
        el.innerHTML = `<span>${via}${item.status == "running" ? doing : item.status == "error" ? `${doing} failed:` : done}${what}${item.detail ? `<span class="detail">${esc(item.detail)}</span>` : ""}${item.image ? `<img class="shot" alt="${esc(opts.imageAlt ?? "What the agent saw")}" src="${item.image}">` : ""}</span>`;
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
  const atBottom = () => logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= 8;
  // A log drawn as the last page left it, read back, stays read back.
  let following = atBottom(),
    lastScrollTop = logEl.scrollTop;
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
  // Approve or Deny on a call that waits (one listener on the log: a log drawn before this script ran has the buttons too).
  logEl.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button[data-answer]");
    if (!b || !e.isTrusted) return;
    for (const x of b.parentElement!.querySelectorAll("button")) x.disabled = true;
    opts.answer?.(b.dataset.call ?? "", b.dataset.answer == "approve");
  });

  function render() {
    const next = log.items.map((it, i) => renderItem(it, i));
    const now = [...logEl.children] as HTMLElement[];
    // A message on its way that the transcript has now (its echo came while the socket was down) is done.
    for (const it of log.items) if (it.kind == "user" && it.id) step(it.id, { t: "echo" });
    if (!sends.size && now.length == next.length && next.every((el, i) => el.isEqualNode(now[i]))) {
      els = now;
      return;
    }
    logEl.textContent = "";
    els = next;
    // Messages on their way (or that weren't sent, with Try again) stay at the end: a reconnect mustn't lose them.
    logEl.append(...els, ...[...sends.values()].map((m) => m.el));
    follow(true);
  }

  // A message shows in the log the moment it's sent, dimmed until the host
  // echoes it back as the conversation's (which replaces it). Each is in one
  // state (sends.ts), by the tab's id for it; the transcript's copy has the id.
  const sends = new Map<string, { state: SendState; el: HTMLElement; resend: () => void }>();
  function step(id: string, ev: SendEvent) {
    const m = sends.get(id);
    if (!m) return;
    const { state, effect } = sendStep(m.state, ev);
    m.state = state;
    if (state == "echoed" || state == "dropped") sends.delete(id);
    if (effect?.t == "remove") m.el.remove();
    else if (effect?.t == "show-failed") {
      m.el.classList.replace("pending", "failed");
      const note = document.createElement("span");
      note.className = "send-failed";
      note.textContent = `Not sent: ${effect.reason}. `;
      const again = Object.assign(document.createElement("button"), { type: "button", textContent: "Try again" });
      again.addEventListener("click", () => step(id, { t: "retry" }));
      note.append(again);
      m.el.append(note);
      pin();
    } else if (effect?.t == "resend") {
      m.el.querySelector(".send-failed")?.remove();
      m.el.classList.replace("failed", "pending");
      logEl.append(m.el);
      follow(true);
      m.resend();
    }
  }
  function apply(ev: LogEvent) {
    // The host's copy of a message sent from this tab takes the place of the dimmed one.
    if (ev.t == "user" && ev.id) step(ev.id, { t: "echo" });
    const before = log.items.length;
    const i = reduce(log, ev);
    if (ev.t == "reset") {
      for (const id of [...sends.keys()]) step(id, { t: "reset" });
      render();
      return;
    }
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

  function pending(id: string, text: string, files: FileRef[] | undefined, resend: () => void) {
    const el = document.createElement("div");
    el.className = "msg-user pending";
    userMessage(el, text, files);
    logEl.append(el);
    sends.set(id, { state: "pending", el, resend });
    // Asking something means you want to see the answer.
    follow(true);
  }

  const drawn = () => els.map((el) => el.outerHTML).join("");

  return { log, render, drawn, apply, follow, pin, pending, failed: (id, reason) => step(id, { t: "fail", reason }) };
}
