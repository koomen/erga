// The comments on the page, in the editor: erga/text's own drawing of the document's comment table. Highlights are CSS
// highlights over the text (erga-comment, erga-comment-on: page-style.ts), never written into the page. The cards, the
// new comment's box and the "Resolved · Undo" pill draw in a shadow root of their own on the page's <html>, in the
// controls' look (controls.ts), and their events stay theirs. Wide, the threads stand in a rail at the right, each
// beside its text; narrow (a phone), a tap on a highlight opens its thread in a sheet at the bottom.
//
// The state and what moves it are comments-state.ts. This draws it, and does what its steps say: the edit op comment
// (through `o.call`), the undo's timer, the focus.

import type * as Y from "yjs";
import { anchorFromJSON, anchorOf, anchorToJSON, resolveAnchor, type Anchor } from "../api/anchors";
import { initial, step, type CommentEvent, type Effect, type Thread } from "./comments-state";
import { KEPT, LOOK } from "./controls";
import { ms } from "./timescale";

/** What the comments ask of the editor on the page. */
export interface CommentsPage {
  selectionNow(): { from: number; to: number };
  /** DOM ranges over the page's text of source [from, to). */
  textRanges(from: number, to: number): Range[];
  focus(): void;
}

/** A person, as a comment shows them. */
export interface Person {
  name: string;
  color: string;
}

export interface CommentsOptions {
  /** The room's text of this page, which the anchors name; null before the room has it. */
  text: () => Y.Text | null;
  /** The person a login is. */
  person: (login: string) => Person;
  /** This tab's person's login. */
  me: string;
  /** The edit op comment, and the read op comments, on this page: the answer's result, or throws with the reason. */
  call: (op: "comment" | "comments", args: Record<string, unknown>) => Promise<{ thread?: Thread | null; threads?: Thread[] }>;
  explain: (message: string) => void;
  zoom: () => number;
  shown: boolean;
}

/** How long "Resolved · Undo" stays. */
const UNDO_MS = 6000;
/** The rail's width, and its gap to the window's edge. */
const RAIL = { width: 272, gap: 16 };
/** Under this width (CSS pixels of the window), the sheet takes the place of the rail. */
const NARROW = 720;

const STYLE = `
:host { all: initial; }
${LOOK}
[hidden] { display: none !important; }
.card { position: fixed; z-index: 2147483645; background: var(--bg); border: 1px solid var(--panel-border); box-shadow: var(--shadow);
  color: var(--fg); font: 13px/1.35 var(--font); box-sizing: border-box; }
.th { width: ${RAIL.width}px; border-radius: 12px; padding: 12px; cursor: default; }
.th.dim { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05); cursor: pointer; }
.who { display: flex; align-items: center; gap: 8px; margin: 0; }
.a { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; color: #fff; font: 600 11px/1 var(--font); flex: none; }
.nm { font-weight: 600; }
.via { color: var(--soft); font-size: 12px; font-weight: 400; }
.t { color: var(--soft); font-size: 12px; }
.sp { flex: 1; }
.msg { margin: 4px 0 10px 30px; font-size: 13.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg:last-child { margin-bottom: 0; }
/* Sent, not answered yet. */
.msg.pending { color: var(--soft); }
.err { margin: 0 0 6px; color: #c2410c; font-size: 12.5px; }
.c.dark .err { color: #f59a6a; }
.reply.busy { opacity: 0.6; }
button { border: 0; background: transparent; padding: 0; font: inherit; color: inherit; cursor: pointer; display: grid; place-items: center; flex: none; }
button:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
svg { fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; }
.rs { width: 26px; height: 26px; border-radius: 7px; color: var(--chrome); }
.rs:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 14%, transparent); }
.rs svg { width: 17px; height: 17px; stroke-width: 1.8; }
.reply { display: flex; align-items: flex-end; gap: 6px; margin: 2px 0 0; border: 1px solid var(--rule); border-radius: 9px; padding: 5px 5px 5px 10px; }
.reply:focus-within { border-color: var(--caret); }
.draft .reply { margin-top: 10px; }
/* One line is as high as the send button (3 + 18 + 3 = 24), so the line and the button share a middle. Border-box: its
   height is the scrollHeight that grow() sets, padding and all. */
textarea { flex: 1; min-width: 0; border: 0; outline: none; resize: none; background: transparent; color: var(--fg); font: 13px/18px var(--font);
  box-sizing: border-box; padding: 3px 0; margin: 0; height: 24px; max-height: 160px; }
textarea::placeholder { color: var(--chrome); }
.go { width: 24px; height: 24px; border-radius: 6px; background: var(--rule); color: var(--soft); }
.reply.has .go { background: var(--caret); color: #fff; }
.go svg { width: 14px; height: 14px; stroke-width: 2; }
.pill { left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; border-radius: 10px;
  padding: 7px 8px 7px 12px; white-space: nowrap; }
.pill .u { color: var(--caret); font-weight: 600; padding: 2px 4px; border-radius: 6px; }
/* (Its bottom leaves room for the shell's agent circle, which floats over the page's bottom left.) */
.sheet { left: 0; right: 0; bottom: 0; width: auto; border-radius: 16px 16px 0 0; padding: 8px 14px 72px; }
.grab { width: 36px; height: 4px; border-radius: 2px; background: var(--rule); margin: 0 auto 10px; }
.th:not(.sheet) .grab { display: none; }
@media (pointer: coarse) { textarea { font-size: 16px; line-height: 22px; padding: 1px 0; } }
`;

const ICON = {
  check: '<path d="m5.5 12.5 4 4 9-9.5"/>',
  up: '<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/>',
};
const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

/** When, as short as the card has room for: "now", "5 min", "2 h", "yesterday", "3 d", then the date. */
export function shortTime(at: string, now = Date.now()): string {
  const s = (now - Date.parse(at)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 2 * 86400) return "yesterday";
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The comments on the page in `win`. */
export function mountComments(win: Window, page: CommentsPage, o: CommentsOptions) {
  const doc = win.document;
  const host = doc.createElement("erga-comments");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}</style><div class="c" id="c"><div class="card pill" id="pill" role="status" hidden>
<span>Resolved</span><button type="button" class="u" id="undo">Undo</button></div></div>`;
  doc.documentElement.append(host);
  for (const type of KEPT) root.addEventListener(type, (e) => e.stopPropagation());
  const box = root.getElementById("c")!,
    pill = root.getElementById("pill")!;
  const registry = ((win as Window & typeof globalThis).CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const Highlight = (win as Window & { Highlight?: new (...r: Range[]) => unknown }).Highlight;

  let state = initial(o.shown);
  let gone = false;
  const timers = new Set<number>();
  /** The cards on the page, by thread ("" for the new comment's), with what each was drawn from. */
  const cards = new Map<string, { el: HTMLElement; drawn: string }>();
  /** Each thread's anchor, decoded once. */
  const anchors = new WeakMap<object, Anchor | null>();

  function send(e: CommentEvent) {
    if (gone) return;
    const next = step(state, e);
    state = next.state;
    for (const f of next.effects) run(f);
    queue();
  }

  function run(f: Effect) {
    if (f.do == "focus") page.focus();
    else if (f.do == "explain") o.explain(f.message);
    else if (f.do == "cleared" || f.do == "restore") {
      const area = cards.get(f.card)?.el.querySelector("textarea");
      if (area) {
        area.value = f.do == "restore" ? f.text : "";
        grow(area);
      }
    } else if (f.do == "timer") {
      const t = win.setTimeout(() => {
        timers.delete(t);
        send({ type: "expired", n: f.n });
      }, ms(UNDO_MS));
      timers.add(t);
    } else {
      const args =
        f.action == "add"
          ? { action: "add", anchor: f.anchor, text: f.text }
          : f.action == "reply"
            ? { action: "reply", thread: f.thread, text: f.text }
            : { action: f.action, thread: f.thread.id };
      // What a failure is about: the card whose text it sent, or the thread it changed.
      const about = f.action == "add" ? { card: "" } : f.action == "reply" ? { card: f.thread } : { thread: f.thread };
      o.call("comment", args).then(
        (r) => send({ type: "answered", action: f.action, thread: r.thread ?? null }),
        (err: Error) => send({ type: "failed", action: f.action, message: err.message, ...about })
      );
    }
  }

  /** The server's open threads again: after a change the document told of, and at the start. */
  async function refresh() {
    try {
      const r = await o.call("comments", {});
      send({ type: "listed", threads: r.threads ?? [] });
    } catch {
      /* the next change tells again */
    }
  }

  // ------------------------------------------------------------ where each thread's text is

  function anchorOfThread(t: Thread): Anchor | null {
    if (!anchors.has(t)) {
      let a: Anchor | null = null;
      try {
        a = t.anchor ? anchorFromJSON(t.anchor) : null;
      } catch {
        /* a position that isn't base64: no place */
      }
      anchors.set(t, a);
    }
    return anchors.get(t)!;
  }

  /** The page's ranges over an anchor's text now; [] when its text is deleted. */
  function rangesOf(a: Anchor): Range[] {
    const text = o.text();
    if (!text) return [];
    const at = resolveAnchor(text, a);
    return at.kind == "found" ? page.textRanges(at.from, at.to) : [];
  }

  // ------------------------------------------------------------ drawing

  let queued = false;
  function queue() {
    if (queued || gone) return;
    queued = true;
    win.requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  }

  function draw() {
    if (gone) return;
    const z = o.zoom();
    host.style.zoom = String(1 / z);
    const narrow = win.innerWidth * z < NARROW;
    // The threads that show, each with its ranges on the page (a thread with no anchor: on the page as a whole).
    const placed = state.shown
      ? state.threads.flatMap((t) => {
          const a = anchorOfThread(t);
          const ranges = a ? rangesOf(a) : [];
          return !a || ranges.length ? [{ t, ranges }] : [];
        })
      : [];
    const draftRanges = state.draft ? rangesOf(anchorFromJSON(state.draft.anchor)) : [];
    paint(
      placed.filter((p) => p.t.id != state.active).flatMap((p) => p.ranges),
      [...(placed.find((p) => p.t.id == state.active)?.ranges ?? []), ...draftRanges]
    );

    const want = new Set<string>();
    const rects: { el: HTMLElement; top: number }[] = [];
    for (const { t, ranges } of placed) {
      const on = t.id == state.active;
      if (narrow && !on) continue;
      want.add(t.id);
      const el = card(t.id, JSON.stringify([t.comments, on, state.sending[t.id], state.errors[t.id]]), () => threadHTML(t, on));
      el.classList.toggle("dim", !on);
      el.classList.toggle("sheet", narrow);
      const top = ranges[0]?.getClientRects()[0]?.top ?? 0;
      rects.push({ el, top: top * z });
    }
    if (state.draft && (!narrow || !state.active)) {
      want.add("");
      const el = card("", JSON.stringify([state.sending[""], state.errors[""]]), draftHTML);
      el.classList.toggle("sheet", narrow);
      const last = draftRanges.at(-1)?.getClientRects();
      const r = last?.[last.length - 1];
      if (!narrow && r) {
        const width = win.innerWidth * z;
        el.style.left = Math.max(8, Math.min(width - RAIL.width - 8, r.left * z)) + "px";
        el.style.top = r.bottom * z + 8 + "px";
      }
      if (narrow) el.style.left = el.style.top = "";
    }
    for (const [id, c] of cards)
      if (!want.has(id)) {
        c.el.remove();
        cards.delete(id);
      }
    // The rail: each card beside its text, below the one before it.
    if (!narrow) {
      let below = -Infinity;
      for (const r of rects.sort((a, b) => a.top - b.top)) {
        const top = Math.max(r.top, below);
        r.el.style.top = top + "px";
        r.el.style.left = "";
        r.el.style.right = RAIL.gap + "px";
        below = top + r.el.offsetHeight + 10;
      }
    } else for (const r of rects) r.el.style.top = r.el.style.right = "";
    pill.hidden = !state.resolved;
  }

  function paint(dim: Range[], on: Range[]) {
    if (!registry || !Highlight) return;
    for (const [name, ranges] of [
      ["erga-comment", dim],
      ["erga-comment-on", on],
    ] as const)
      if (ranges.length) registry.set(name, new Highlight(...ranges));
      else registry.delete(name);
  }

  /** The card for `id`, made again when what it shows (`drawn`) changed; what's typed in its box stays. */
  function card(id: string, drawn: string, html: () => string): HTMLElement {
    const had = cards.get(id);
    if (had?.drawn == drawn) return had.el;
    const area = had?.el.querySelector("textarea");
    const typed = area?.value ?? "",
      focused = !!area && root.activeElement == area;
    const el = had?.el ?? doc.createElement("div");
    el.className = `card th${id ? "" : " draft"}`;
    if (id) el.dataset.thread = id;
    el.innerHTML = `<div class="grab" aria-hidden="true"></div>${html()}`;
    if (!had) box.append(el);
    cards.set(id, { el, drawn });
    const next = el.querySelector("textarea");
    if (next) {
      next.value = typed;
      grow(next);
      if (focused || (!had && !id)) next.focus();
    }
    return el;
  }

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  /** A comment's first line: who, how (an agent), when (as it shows), and ✓ to resolve its thread. */
  function whoHTML(login: string, via: string | undefined, when: string | null, resolve: boolean): string {
    const p = o.person(login);
    return `<p class="who"><span class="a" style="background:${esc(p.color)}">${esc([...p.name][0]?.toUpperCase() ?? "?")}</span><span class="nm">${esc(p.name)}${
      via ? ` <span class="via">via ${esc(via)}</span>` : ""
    }</span>${when ? `<span class="t">${esc(when)}</span>` : ""}${
      resolve
        ? `<span class="sp"></span><button type="button" class="rs" data-act="resolve" aria-label="Resolve" title="Resolve">${svg(ICON.check)}</button>`
        : ""
    }</p>`;
  }
  /** A card's box: it waits while its text is on its way; the reason the server refused it shows above it. */
  const replyHTML = (label: string, card: string) => {
    const busy = card in state.sending,
      error = state.errors[card];
    return `${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}<div class="reply${busy ? " busy" : ""}"><textarea rows="1" placeholder="${label}" aria-label="${label}"${
      busy ? ' readonly aria-disabled="true"' : ""
    }></textarea><button type="button" class="go" data-act="send" aria-label="Send (Enter)" title="Send  Enter"${busy ? ' aria-disabled="true"' : ""}>${svg(ICON.up)}</button></div>`;
  };
  /** The text a card sent, as it shows until the server answers. */
  const pendingHTML = (card: string, who: boolean) =>
    card in state.sending
      ? (who ? whoHTML(o.me, undefined, "sending…", false) : "") + `<p class="msg pending">${esc(state.sending[card])}</p>`
      : "";
  const threadHTML = (t: Thread, on: boolean) =>
    t.comments.map((c, i) => whoHTML(c.by, c.via, shortTime(c.at), on && i == 0) + `<p class="msg">${esc(c.text)}</p>`).join("") +
    pendingHTML(t.id, true) +
    (on ? replyHTML("Reply", t.id) : "");
  const draftHTML = () =>
    whoHTML(o.me, undefined, "" in state.sending ? "sending…" : null, false) + pendingHTML("", false) + replyHTML("Comment", "");

  function grow(area: HTMLTextAreaElement) {
    area.style.height = "";
    area.style.height = Math.min(160, area.scrollHeight) + "px";
    area.closest(".reply")?.classList.toggle("has", !!area.value.trim());
  }

  // ------------------------------------------------------------ their events

  const threadOf = (el: Element) => (el.closest("[data-thread]") as HTMLElement | null)?.dataset.thread;
  box.addEventListener("mousedown", (e) => {
    if (!(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
  });
  box.addEventListener("click", (e) => {
    const target = e.target as Element;
    if (target.closest("#undo")) return send({ type: "undo" });
    const id = threadOf(target);
    const act = (target.closest("button") as HTMLButtonElement | null)?.dataset.act;
    if (act == "resolve" && id) return send({ type: "resolve", id });
    if (act == "send") return submit(target.closest(".card")!.querySelector("textarea")!);
    if (id && id != state.active) send({ type: "activate", id });
    target.closest(".card")?.querySelector("textarea")?.focus();
  });
  box.addEventListener("input", (e) => {
    if (e.target instanceof HTMLTextAreaElement) grow(e.target);
  });
  box.addEventListener("keydown", (e) => {
    if (!(e.target instanceof HTMLTextAreaElement) || e.isComposing) return;
    if (e.key == "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(e.target);
    } else if (e.key == "Escape") {
      e.preventDefault();
      send({ type: "cancel" });
    }
  });
  function submit(area: HTMLTextAreaElement) {
    const id = threadOf(area);
    send({ type: "send", text: area.value, ...(id ? { thread: id } : {}) });
  }

  // A click on a highlight opens its thread; a click elsewhere on the page closes the one open. (Read from the click's
  // place: the highlights are no elements.)
  const onClick = (e: MouseEvent) => {
    if ((e.target as Element | null)?.localName == "erga-comments" || !state.shown) return;
    const hit = state.threads.find((t) => {
      const a = anchorOfThread(t);
      return (
        a &&
        rangesOf(a).some((r) =>
          [...r.getClientRects()].some((b) => e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom)
        )
      );
    });
    if (hit) send({ type: "activate", id: hit.id });
    else if (state.active) send({ type: "activate", id: null });
  };
  doc.addEventListener("click", onClick, true);

  void refresh();

  return {
    queue,
    refresh,
    /** The Comment button, or ⌘⌥M: a new comment on the selection. */
    compose() {
      const text = o.text(),
        { from, to } = page.selectionNow();
      const a = text && anchorOf(text, from, to);
      if (!a) return o.explain("Select the text to comment on, then press Comment.");
      send({ type: "compose", anchor: anchorToJSON(a) });
      // (At once: the next key typed goes into its box, not the page.)
      draw();
    },
    /** The page's colours: the cards take their dark look on a dark page. */
    dark(on: boolean) {
      box.classList.toggle("dark", on);
    },
    /** The shell's word: comments shown or hidden. */
    show(on: boolean) {
      send({ type: "show", on });
    },
    /** Esc on the page: the new comment or the open thread closes. Whether one was open. */
    cancel(): boolean {
      if (!state.draft && !state.active) return false;
      send({ type: "cancel" });
      return true;
    },
    remove() {
      gone = true;
      for (const t of timers) win.clearTimeout(t);
      doc.removeEventListener("click", onClick, true);
      paint([], []);
      host.remove();
    },
  };
}

export type Comments = ReturnType<typeof mountComments>;
