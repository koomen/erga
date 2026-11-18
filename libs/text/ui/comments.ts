// The comments on the page, in the editor: erga/text's own drawing of the document's comment table. Highlights are CSS
// highlights over the text (erga-comment, erga-comment-on: render.ts), never written into the page. The cards, the
// new comment's box and the "Resolved · Undo" pill draw in a shadow root of their own on the page's <html>, in the
// controls' look (controls.ts), and their events stay theirs. They keep their size on the screen at every zoom, and
// stand by the room that shows (all measures on the screen, after the zoom): with room beside the text's column, in a
// rail there, each beside its text; with less, a click on a highlight opens its thread under its text; on a phone
// (a narrow place), in a sheet at the bottom, and the page scrolls its text over the sheet.
// A card is at most 60% of the place high (a sheet: half of it): a long thread scrolls in it, and its box for a reply
// stays at its bottom.
//
// The box a person types in is not here: a script of the page could read it, type in it and send it as the person.
// The window around the page draws it (client/common/comment-box.ts) over the open card's empty place for it (.slot),
// and sends its comment with the person's session. This asks for it (`o.box`: the card, what it is for, and where,
// never text), makes its place as high as the box says, and hears what was sent and the answer (`fromShell`).
//
// The state and what moves it are comments-state.ts. This draws it, and does what its steps say: the edit op comment
// (through `o.call`: resolve and reopen), the undo's timer, the focus.

import type * as Y from "yjs";
import { MARK } from "../../../assets/logo/logo";
import { agentByline, VIA, type AgentNote } from "../../../shared/attribution";
import { esc } from "../../../shared/html";
import { anchorFromJSON, anchorOf, anchorToJSON, resolveAnchor, type Anchor } from "../api/anchors";
import {
  agentOf,
  boxOf,
  editKey,
  initial,
  step,
  type Action,
  type Comment,
  type CommentEvent,
  type Effect,
  type Thread,
} from "./comments-state";
import { KEPT, LOOK } from "./controls";
import type { Shows } from "../../../client/common/zoom";
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
  /** The part of the page that shows on the screen (mode.ts). */
  shows: () => Shows;
  shown: boolean;
  /** A "Comment" button at the page's selection: where the editor's style bar, which has one, isn't (a commenter's page). */
  button?: boolean;
  /** Asks the window around the page for the box (comment-box.ts), or none (null). */
  box: (box: unknown) => void;
}

/** How long "Resolved · Undo" stays. */
const UNDO_MS = 6000;
/** The rail's cards: their width, their gap to the text's column, and the room they need after it (8 px). */
const RAIL = { width: 272, gap: 24, after: 8 };
/** A thread's card under its text, where the rail has no room: its width. */
const UNDER = 320;
/** Under this width of the page's place on the screen (px), a thread opens in the sheet. */
const NARROW = 720;
/** A card's largest height: this fraction of the window's. */
const TALL = 0.6;

const STYLE = `
:host { all: initial; }
${LOOK}
[hidden] { display: none !important; }
.card { position: fixed; z-index: 2147483645; background: var(--bg); border: 1px solid var(--panel-border); box-shadow: var(--shadow);
  color: var(--fg); font: 13px/1.35 var(--font); box-sizing: border-box; }
.th { width: ${RAIL.width}px; border-radius: 12px; padding: 12px; cursor: default; display: flex; flex-direction: column; }
/* A long thread scrolls in its card (draw() sets the card's largest height); its box stays at the card's bottom, and a
   fade over the last line says that more is below. */
.msgs { flex: 0 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.more { position: relative; height: 0; flex: none; }
.more::before { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 28px; pointer-events: none;
  background: linear-gradient(to bottom, color-mix(in srgb, var(--bg) 0%, transparent), var(--bg)); }
.more[hidden] { display: none; }
.th.dim { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05); cursor: pointer; }
.who { display: flex; align-items: center; gap: 8px; margin: 0; }
.a { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; color: #fff; font: 600 11px/1 var(--font); flex: none; }
/* An agent's picture: Erga's mark, or a shared agent's letter, on black. */
.a.ag { background: #1c1c1f; }
.a.ag svg { width: 13px; height: 13px; stroke: none; }
.nm { font-weight: 600; }
.via { color: var(--soft); font-size: 12px; font-weight: 400; }
.t { color: var(--soft); font-size: 12px; }
.sp { flex: 1; }
.msg { margin: 4px 0 10px 30px; font-size: 13.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dim .msg:last-child { margin-bottom: 0; }
/* Sent, not answered yet. */
.msg.pending { color: var(--soft); }
.err { margin: 0 0 6px; color: #c2410c; font-size: 12.5px; }
.c.dark .err { color: #f59a6a; }
/* The box's place: the window around the page draws the box over it (comment-box.ts), and says how high it is. */
.slot { margin: 2px 0 0; height: 36px; flex: none; }
.draft .slot { margin-top: 10px; }
/* A comment open for editing: its box in its place, under its name. */
.slot.edit { margin: 4px 0 10px 30px; }
.err.edit { margin: 4px 0 0 30px; }
/* The person's agent, asked with @erga: at work until its reply comes, or why it didn't start. */
.dots { display: inline-flex; gap: 3px; vertical-align: middle; margin-left: 2px; }
.dots i { width: 4px; height: 4px; border-radius: 50%; background: var(--chrome); display: block; animation: dot 1.2s ease-in-out infinite; }
.dots i:nth-child(2) { animation-delay: 0.2s; }
.dots i:nth-child(3) { animation-delay: 0.4s; }
@keyframes dot { 50% { opacity: 0.35; } }
.msg.why { color: var(--soft); }
button { border: 0; background: transparent; padding: 0; font: inherit; color: inherit; cursor: pointer; display: grid; place-items: center; flex: none; }
button:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
svg { fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; }
.rs { width: 26px; height: 26px; border-radius: 7px; color: var(--chrome); }
.rs:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 14%, transparent); }
.rs svg { width: 17px; height: 17px; stroke-width: 1.8; }
.pill { left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; border-radius: 10px;
  padding: 7px 8px 7px 12px; white-space: nowrap; }
/* The button at the selection, on a commenter's page. */
.cbtn { display: flex; align-items: center; gap: 6px; border-radius: 9px; padding: 6px 11px 6px 9px; font-weight: 600; white-space: nowrap;
  border: 1px solid var(--panel-border); background: var(--bg); }
.cbtn svg { width: 16px; height: 16px; stroke-width: 1.8; }
.pill .u { color: var(--caret); font-weight: 600; padding: 2px 4px; border-radius: 6px; }
/* (Its bottom leaves room for the shell's agent circle, which floats over the page's bottom left.) */
.under { width: ${UNDER}px; }
.sheet { bottom: 0; border-radius: 16px 16px 0 0; padding: 8px 14px 72px; overflow-y: auto; overscroll-behavior: contain; }
.grab { width: 36px; height: 4px; border-radius: 2px; background: var(--rule); margin: 0 auto 10px; }
.th:not(.sheet) .grab { display: none; }
`;

const ICON = {
  check: '<path d="m5.5 12.5 4 4 9-9.5"/>',
  up: '<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/>',
  comment: '<path d="M5 6.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5.5L7.5 19v-3.5H7a2 2 0 0 1-2-2z"/>',
  pen: '<path d="M4.75 19.25l1-4L15.6 5.4a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L8.75 18.25zM13.75 7.25l3 3"/>',
};
const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

/**
 * When, as short as the card has room for: "now", "5 min", "2 h", "yesterday", "3 d", then the date. Not timeAgo
 * (shared/time.ts): its "5 minutes ago" is too long for the card's first line, beside the name and the buttons.
 */
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
<span>Resolved</span><button type="button" class="u" id="undo">Undo</button></div>
<button type="button" class="card cbtn" id="cbtn" hidden>${svg(ICON.comment)}Comment</button></div>`;
  doc.documentElement.append(host);
  for (const type of KEPT) root.addEventListener(type, (e) => e.stopPropagation());
  const box = root.getElementById("c")!,
    pill = root.getElementById("pill")!,
    cbtn = root.getElementById("cbtn")!;
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
    else if (f.do == "refresh") void refresh();
    else if (f.do == "explain") o.explain(f.message);
    else if (f.do == "timer") {
      const t = win.setTimeout(() => {
        timers.delete(t);
        send({ type: "expired", n: f.n });
      }, ms(UNDO_MS));
      timers.add(t);
    } else
      o.call("comment", { action: f.action, thread: f.thread.id }).then(
        (r) => send({ type: "answered", action: f.action, thread: r.thread ?? null }),
        (err: Error) => send({ type: "failed", action: f.action, message: err.message, thread: f.thread })
      );
  }

  // ------------------------------------------------------------ the box, in the window around the page

  /** The box's height, as the window around the page last said, for its card. */
  let boxHeight = { card: "", height: 36 };
  /** What the window was told last; and whether the box takes the focus with the next word (a new box, a click on its card). */
  let boxTold = "";
  let boxFocus = false;
  /** The box's place in the open card, where it is now (px of the page's window): the window draws the box there. */
  function askBox() {
    const b = state.shown ? boxOf(state) : null;
    const slot = b && cards.get(b.act == "edit" ? state.editing!.thread : b.card)?.el.querySelector<HTMLElement>(".slot");
    const r = slot?.getBoundingClientRect();
    const word = b && r?.width ? { ...b, place: { x: r.left, y: r.top, w: r.width }, dark: box.classList.contains("dark") } : null;
    const json = JSON.stringify(word);
    if (json == boxTold && !(word && boxFocus)) return;
    boxTold = json;
    o.box(word && boxFocus ? { ...word, focus: true } : word);
    if (word && boxFocus) {
      boxFocus = false;
      // The keys are the box's from now on: none goes into the page's text before the box has the focus. (The editor
      // keeps its selection, for the way back.)
      (doc.activeElement as HTMLElement | null)?.blur?.();
    }
  }

  /** What the window around the page says of its box (frame.ts hears it from there, and only from there). */
  function fromShell(m: Record<string, unknown>) {
    if (m.type == "erga-comment-turn" && typeof m.why == "string") return send({ type: "ended", why: m.why.slice(0, 300) });
    const card = typeof m.card == "string" ? m.card : null,
      action = m.action as Action;
    if (card == null) return;
    if (m.type == "erga-comment-height" && typeof m.height == "number" && m.height > 0 && m.height < 400) {
      boxHeight = { card, height: Math.round(m.height) };
      const slot = [...cards.values()].map((c) => c.el.querySelector<HTMLElement>(".slot")).find(Boolean);
      if (slot) slot.style.height = boxHeight.height + "px";
      queue();
    } else if (m.type == "erga-comment-sent" && typeof m.text == "string") send({ type: "sent", card, text: m.text });
    else if (m.type == "erga-comment-cancel") send({ type: "cancel" });
    else if (m.type == "erga-comment-answered" && ["add", "reply", "edit"].includes(action)) {
      const agent = m.agent as AgentNote | undefined;
      send({
        type: "answered",
        action,
        thread: (m.thread as Thread | null) ?? null,
        card,
        ...(agent && ("working" in agent || typeof (agent as { reason?: unknown }).reason == "string") ? { agent } : {}),
      });
    } else if (m.type == "erga-comment-failed" && typeof m.message == "string" && ["add", "reply", "edit"].includes(action))
      send({ type: "failed", action, message: m.message, card });
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

  /** The thread whose text the page last scrolled over the sheet (a phone). */
  let lifted: string | null = null;

  /**
   * The right edge of the text's column, px of the page: the outermost element around the text that leaves room at
   * the window's sides (more than 16 px at each); else the text's own element.
   */
  function columnRight(r: Range): number {
    const first = r.startContainer.nodeType == 1 ? (r.startContainer as Element) : r.startContainer.parentElement;
    let col = first;
    for (let el = first; el && el != doc.documentElement; el = el.parentElement) {
      if (el.getBoundingClientRect().width >= win.innerWidth - 32) break;
      col = el;
    }
    return col?.getBoundingClientRect().right ?? 0;
  }

  function draw() {
    if (gone) return;
    const z = o.zoom();
    host.style.zoom = String(1 / z);
    const view = viewOf(z),
      tall = win.innerHeight * z;
    const narrow = win.innerWidth < NARROW;
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
    // The rail: beside the widest column of the threads' texts, where the room that shows there takes a card.
    const column = Math.max(...placed.flatMap((p) => (p.ranges[0] ? [columnRight(p.ranges[0]) * z] : [])));
    const railLeft = Number.isFinite(column) ? column + RAIL.gap : view.right - RAIL.width - RAIL.after;
    const rail = !narrow && view.right - railLeft >= RAIL.width + RAIL.after;

    const want = new Set<string>();
    const shown: { el: HTMLElement; id: string; rects: DOMRect[] }[] = [];
    for (const { t, ranges } of placed) {
      const on = t.id == state.active;
      if (!rail && !on) continue;
      want.add(t.id);
      const editing = state.editing?.thread == t.id ? state.editing : null;
      const el = card(t.id, JSON.stringify([t.comments, on, state.sending, state.errors, editing, state.asked[t.id]]), () =>
        threadHTML(t, on)
      );
      el.classList.toggle("dim", !on);
      el.classList.toggle("sheet", narrow);
      el.classList.toggle("under", !rail && !narrow);
      shown.push({ el, id: t.id, rects: ranges.flatMap((r) => [...r.getClientRects()]) });
    }
    if (state.draft && (!narrow || !state.active)) {
      want.add("");
      const el = card("", JSON.stringify([state.sending[""], state.errors[""]]), draftHTML);
      el.classList.toggle("sheet", narrow);
      const last = draftRanges.at(-1)?.getClientRects();
      const r = last?.[last.length - 1];
      if (!narrow && r) {
        el.style.width = "";
        el.style.left = Math.max(view.left + 8, Math.min(view.right - RAIL.width - 8, r.left * z)) + "px";
        el.style.top = r.bottom * z + 8 + "px";
      }
    }
    for (const [id, c] of cards)
      if (!want.has(id)) {
        c.el.remove();
        cards.delete(id);
      }
    // A card is at most 60% of the place high; then a sheet (a phone) takes half of it (sheet()).
    for (const c of cards.values()) c.el.style.maxHeight = Math.round(tall * TALL) + "px";
    if (narrow && want.has("")) sheet(cards.get("")!.el, view, tall);
    if (!state.active) lifted = null;
    // Room to scroll under the page's end, as high as an open thread's sheet: its text can come over the sheet.
    const sheetOn = narrow && shown.length ? shown[0].el : null;
    if (sheetOn) sheet(sheetOn, view, tall);
    host.style.display = sheetOn ? "block" : "";
    host.style.height = sheetOn ? sheetOn.offsetHeight + "px" : "";
    if (narrow)
      for (const { el, id, rects } of shown) {
        sheet(el, view, tall);
        // Its text over the sheet: the page scrolls, once each time the thread opens.
        const first = rects[0],
          last = rects.at(-1);
        if (id != state.active || lifted == id || !first || !last) continue;
        lifted = id;
        // (Down until its last line is over the sheet, but never past its first line's top.)
        const by = first.top < 0 ? first.top * z - 8 : Math.min(last.bottom * z - (tall - el.offsetHeight - 8), first.top * z - 8);
        if (by > 0 || first.top < 0) win.scrollBy(0, by / z);
      }
    else if (rail) {
      // Each card beside its text, below the one before it.
      let below = -Infinity;
      for (const r of shown.map((c) => ({ ...c, top: (c.rects[0]?.top ?? 0) * z })).sort((a, b) => a.top - b.top)) {
        const top = Math.max(r.top, below);
        Object.assign(r.el.style, { top: top + "px", left: railLeft + "px", width: "" });
        below = top + r.el.offsetHeight + 10;
      }
    } else
      for (const { el, rects } of shown) {
        // Under the last line of its text, or over its first line when the place has no room below it.
        const first = rects[0],
          last = rects.at(-1);
        el.style.width = "";
        el.style.left = Math.max(view.left + 8, Math.min(view.right - UNDER - 8, (last?.left ?? 0) * z)) + "px";
        const h = el.offsetHeight,
          under = (last?.bottom ?? 0) * z + 8,
          over = (first?.top ?? 0) * z - 8 - h;
        el.style.top = (under + h > tall - 8 && over >= 8 ? over : under) + "px";
      }
    for (const c of cards.values()) fade(c.el);
    askBox();
    pill.hidden = !state.resolved;
    if (o.button) placeButton(z, view);
  }

  /**
   * The part of the page that shows, across, in the cards' px: the screen's (the host is drawn at 1 / z). No more than
   * the page's own window.
   */
  function viewOf(z: number) {
    const s = o.shows(),
      left = Math.max(0, s.left),
      right = Math.min(win.innerWidth, s.right);
    return right > left ? { left: left * z, right: right * z } : { left: 0, right: win.innerWidth * z };
  }

  /** A card as the sheet: across the part of the page that shows, at its bottom, at most half the place's height. */
  function sheet(el: HTMLElement, view: { left: number; right: number }, tall: number) {
    Object.assign(el.style, {
      left: view.left + "px",
      width: view.right - view.left + "px",
      top: "",
      maxHeight: Math.floor(tall / 2) + "px",
    });
  }

  /** The "Comment" button under the end of the page's selection, while it has text and no comment is being written. */
  function placeButton(z: number, view: { left: number; right: number }) {
    const { from, to } = state.draft ? { from: 0, to: 0 } : page.selectionNow();
    const rects = from < to ? page.textRanges(from, to).at(-1)?.getClientRects() : undefined;
    const r = rects?.[rects.length - 1];
    cbtn.hidden = !r;
    if (!r) return;
    cbtn.style.left = Math.max(view.left + 8, Math.min(view.right - cbtn.offsetWidth - 8, r.right * z - cbtn.offsetWidth)) + "px";
    cbtn.style.top = r.bottom * z + 8 + "px";
  }

  /** The fade over a thread's last line, while more of it is below. */
  function fade(el: Element) {
    const msgs = el.querySelector<HTMLElement>(".msgs"),
      more = el.querySelector<HTMLElement>(".more");
    if (msgs && more) more.hidden = msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 2;
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

  /** The card for `id`, made again when what it shows (`drawn`) changed; its thread keeps its place in its scroll. */
  function card(id: string, drawn: string, html: () => string): HTMLElement {
    const had = cards.get(id);
    if (had?.drawn == drawn) return had.el;
    // Its thread's place in its scroll: the same again, or the end when it was at the end (a new comment shows there).
    const was = had?.el.querySelector<HTMLElement>(".msgs");
    const end = !!was && was.scrollTop + was.clientHeight >= was.scrollHeight - 2,
      scrolled = was?.scrollTop ?? 0;
    const el = had?.el ?? doc.createElement("div");
    el.className = `card th${id ? "" : " draft"}`;
    if (id) el.dataset.thread = id;
    el.innerHTML = `<div class="grab" aria-hidden="true"></div>${html()}`;
    if (!had) box.append(el);
    cards.set(id, { el, drawn });
    const msgs = el.querySelector<HTMLElement>(".msgs");
    if (msgs && was) msgs.scrollTop = end ? msgs.scrollHeight : scrolled;
    return el;
  }

  /**
   * A comment's first line: who (the person, or an agent and whose it is: agentByline), when (as it shows), "· edited" (`edited`: when), ✎ to edit it
   * (`edit`: the comment's id), and ✓ to resolve its thread.
   */
  function whoHTML(
    login: string,
    via: string | undefined,
    when: string | null,
    resolve: boolean,
    more: { edited?: string; edit?: string } = {}
  ): string {
    const p = o.person(login),
      agent = agentByline(p.name, via),
      initial = esc([...(agent?.name ?? p.name)][0]?.toUpperCase() ?? "?");
    return `<p class="who">${
      agent
        ? `<span class="a ag">${agent.mark ? MARK : initial}</span><span class="nm">${esc(agent.name)} <span class="via">${esc(agent.whose)}</span>`
        : `<span class="a" style="background:${esc(p.color)}">${initial}</span><span class="nm">${esc(p.name)}`
    }</span>${when ? `<span class="t">${esc(when)}</span>` : ""}${
      more.edited ? `<span class="t" title="Edited ${esc(new Date(more.edited).toLocaleString())}">· edited</span>` : ""
    }${resolve || more.edit ? '<span class="sp"></span>' : ""}${
      more.edit
        ? `<button type="button" class="rs" data-act="edit" data-comment="${esc(more.edit)}" aria-label="Edit your comment" title="Edit">${svg(ICON.pen)}</button>`
        : ""
    }${
      resolve ? `<button type="button" class="rs" data-act="resolve" aria-label="Resolve" title="Resolve">${svg(ICON.check)}</button>` : ""
    }</p>`;
  }
  /** A card's place for the box (the window around the page draws it), with the reason the server refused its text over it. */
  const slotHTML = (card: string, edit = false) => {
    const error = state.errors[card];
    return `${error ? `<p class="err${edit ? " edit" : ""}" role="alert">${esc(error)}</p>` : ""}<div class="slot${edit ? " edit" : ""}" style="height:${boxHeight.card == card ? boxHeight.height : 36}px"></div>`;
  };
  /** The text a card sent, as it shows until the server answers. */
  const pendingHTML = (card: string, who: boolean) =>
    card in state.sending
      ? (who ? whoHTML(o.me, undefined, "sending…", false) : "") + `<p class="msg pending">${esc(state.sending[card])}</p>`
      : "";
  /** One comment: as it is, with ✎ on one's own (not an agent's); its edit's box; or its edit on its way, pending. */
  function commentHTML(c: Comment, first: boolean, on: boolean) {
    const key = editKey(c.id),
      who = (edit: boolean) =>
        whoHTML(c.by, c.via, shortTime(c.at), on && first, {
          ...(c.edited_at ? { edited: c.edited_at } : {}),
          ...(edit && c.by == o.me && !c.via ? { edit: c.id } : {}),
        });
    if (key in state.sending) return who(false) + `<p class="msg pending">${esc(state.sending[key])}</p>`;
    if (state.editing?.comment == c.id) return who(false) + slotHTML(key, true);
    return who(true) + `<p class="msg">${esc(c.text)}</p>`;
  }
  /** The person's agent, asked in this thread with @erga: at work, or why it didn't start. */
  const agentHTML = (t: Thread) => {
    const a = agentOf(state, t);
    if (!a) return "";
    const working = `<span class="t">working <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span>`;
    return (
      whoHTML(o.me, VIA.agent, null, false).replace(/<\/p>$/, `${a.reason == null ? working : ""}</p>`) +
      `<p class="msg${a.reason == null ? "" : " why"}">${esc(a.reason ?? "")}</p>`
    );
  };
  const threadHTML = (t: Thread, on: boolean) =>
    `<div class="msgs">${t.comments.map((c, i) => commentHTML(c, i == 0, on)).join("") + pendingHTML(t.id, true) + agentHTML(t)}</div><div class="more" hidden></div>` +
    (on && state.editing?.thread != t.id ? slotHTML(t.id) : "");
  const draftHTML = () =>
    `<div class="msgs">${whoHTML(o.me, undefined, "" in state.sending ? "sending…" : null, false) + pendingHTML("", false)}</div><div class="more" hidden></div>` +
    slotHTML("");

  // ------------------------------------------------------------ their events

  const threadOf = (el: Element) => (el.closest("[data-thread]") as HTMLElement | null)?.dataset.thread;
  box.addEventListener("mousedown", (e) => e.preventDefault());
  box.addEventListener("click", (e) => {
    const target = e.target as Element;
    if (target.closest("#undo")) return send({ type: "undo" });
    if (target.closest("#cbtn")) return compose();
    const id = threadOf(target);
    const act = (target.closest("button") as HTMLButtonElement | null)?.dataset.act;
    if (act == "resolve" && id) return send({ type: "resolve", id });
    if (act == "edit" && id) {
      boxFocus = true;
      return send({ type: "edit", thread: id, comment: (target.closest("button") as HTMLElement).dataset.comment! });
    }
    if (id && id != state.active) send({ type: "activate", id });
    // A click on a card: the box takes the focus.
    if (target.closest(".card.th")) {
      boxFocus = true;
      queue();
    }
  });
  root.addEventListener(
    "scroll",
    (e) => {
      const card = (e.target as Element).closest?.(".card");
      if (card) fade(card);
    },
    true
  );
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

  /** The Comment button, or ⌘⌥M: a new comment on the selection. */
  function compose() {
    const text = o.text(),
      { from, to } = page.selectionNow();
    const a = text && anchorOf(text, from, to);
    if (!a) return o.explain("Select the text to comment on, then press Comment.");
    boxFocus = true;
    send({ type: "compose", anchor: anchorToJSON(a) });
    // (At once: the next key typed goes into its box, not the page.)
    draw();
  }

  void refresh();

  return {
    queue,
    refresh,
    compose,
    fromShell,
    /** A box is open and has the keys (the page has no focus): the style bar waits. */
    writing: () => !!boxOf(state) && !doc.hasFocus(),
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
      o.box(null);
      host.remove();
    },
  };
}

export type Comments = ReturnType<typeof mountComments>;
