// The box a person types a comment in. The window around the document's page draws it (the editor's shell, and a
// commenter's viewer), over the page's frame, where the page's open card has its place for it (libs/text/ui/comments.ts).
// It is on this origin, so the page's scripts can't read it, type in it or send it. Its comment goes with the person's
// session (runTool), never with the page's edit key: it is always the person's own words, and their @erga runs at once
// (server/operations/comments.ts). The page asks for a box by its card, never with text; an edit's text comes from the
// server. The page hears what was sent and the answer (with what an @erga did), and its card shows them; and the end of
// each turn of the person's agent, so a thread that waits for its reply never waits for good.
//
// The state is comment-box-state.ts; this draws it and does what its steps say. Everything from the page is checked:
// the page itself could have sent it.

import { LOOK } from "../../libs/text/ui/controls";
import { initial, step, type Ask, type BoxEvent, type Effect } from "./comment-box-state";
import { runTool } from "./tools";

/** Where the page's card has its place for the box: px of the page's window. */
interface Place {
  x: number;
  y: number;
  w: number;
}

const STYLE = `
:host { all: initial; position: fixed; inset: 0; pointer-events: none; }
${LOOK}
.reply { position: absolute; display: flex; align-items: flex-end; gap: 6px; box-sizing: border-box; pointer-events: auto; background: var(--bg);
  border: 1px solid var(--rule); border-radius: 9px; padding: 5px 5px 5px 10px; }
.reply[hidden] { display: none; }
.reply:focus-within { border-color: var(--caret); }
.reply.busy { opacity: 0.6; }
textarea { flex: 1; min-width: 0; border: 0; outline: none; resize: none; background: transparent; color: var(--fg); font: 13px/18px var(--font);
  box-sizing: border-box; padding: 3px 0; margin: 0; height: 24px; max-height: 160px; }
textarea::placeholder { color: var(--chrome); }
button { border: 0; padding: 0; font: inherit; cursor: pointer; display: grid; place-items: center; flex: none; }
button:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
.go { width: 24px; height: 24px; border-radius: 6px; background: var(--rule); color: var(--soft); }
.reply.has .go { background: var(--caret); color: #fff; }
svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
@media (pointer: coarse) { textarea { font-size: 16px; line-height: 22px; padding: 1px 0; } }
`;

const LABEL = { add: "Comment", reply: "Reply", edit: "Edit your comment" } as const;

const str = (v: unknown, max: number) => (typeof v == "string" && v.length <= max ? v : null);
const num = (v: unknown): v is number => typeof v == "number" && Number.isFinite(v) && Math.abs(v) < 1e6;

/** The page's word for a box, if it is one: a card, what it is for, and where. */
function askOf(m: Record<string, unknown>): { ask: Ask | null; place: Place | null; dark: boolean; focus: boolean } | null {
  const b = m.box as Record<string, unknown> | null;
  if (b === null) return { ask: null, place: null, dark: false, focus: false };
  if (typeof b != "object") return null;
  const at = b.place as Record<string, unknown> | undefined;
  if (!at || !num(at.x) || !num(at.y) || !num(at.w) || at.w <= 0) return null;
  const place = { x: at.x, y: at.y, w: Math.min(at.w, 2000) };
  const a = b.anchor as Record<string, unknown> | undefined;
  const id = (k: string) => str(b[k], 100);
  let ask: Ask | null = null;
  if (b.act == "add" && b.card === "" && a && str(a.start, 1000) && str(a.end, 1000) && str(a.quote, 10_000) != null)
    ask = { card: "", act: "add", anchor: { start: a.start as string, end: a.end as string, quote: a.quote as string } };
  else if (b.act == "reply" && id("thread") && b.card === b.thread) ask = { card: id("thread")!, act: "reply", thread: id("thread")! };
  else if (b.act == "edit" && id("comment") && b.card === `e:${b.comment}`)
    ask = { card: b.card as string, act: "edit", comment: id("comment")! };
  return ask && { ask, place, dark: b.dark === true, focus: b.focus === true };
}

/**
 * The box over the page's frame, for document `doc` (its id) and the page the frame shows (`page`: its path). `on`:
 * whether the page may have one now (it is in the editor, or a commenter's).
 */
export function mountCommentBox(doc: string, page: () => string, on: () => boolean = () => true) {
  const host = document.createElement("erga-comment-box");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}</style><div class="c" id="c"><div class="reply" id="box" hidden><textarea rows="1"></textarea><button type="button" class="go" aria-label="Send (Enter)" title="Send  Enter"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/></svg></button></div></div>`;
  const look = root.getElementById("c")!,
    box = root.getElementById("box")!,
    area = box.querySelector("textarea")!;

  let state = initial;
  let place: Place | null = null;
  /** The height last told to the page. */
  let told = 0;

  function send(e: BoxEvent) {
    const next = step(state, e);
    state = next.state;
    // (Shown before its effects: a box out of sight takes no focus, and has no height.)
    box.hidden = !state.ask || !place;
    for (const f of next.effects) run(f);
    draw();
  }

  const tell = (m: unknown) => ergaFrames.send(m);

  function run(f: Effect) {
    if (f.do == "fill") {
      area.value = f.text;
      grow();
    } else if (f.do == "focus") {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    } else if (f.do == "page") {
      if (root.activeElement == area) ergaFrames.frame.focus();
    } else if (f.do == "tell") tell(f.message);
    else if (f.do == "read") {
      runTool<{ threads: { comments: { id: string; text: string }[] }[] }>("comments", { document: doc, page: page() }).then(
        (r) => {
          const c = r.threads.flatMap((t) => t.comments).find((x) => x.id == f.comment);
          if (c) send({ type: "loaded", card: f.card, text: c.text });
          else tell({ type: "erga-comment-failed", card: f.card, action: "edit", message: "The comment is gone." });
        },
        (err: Error) => tell({ type: "erga-comment-failed", card: f.card, action: "edit", message: err.message })
      );
    } else {
      const { ask, text } = f;
      const args =
        ask.act == "add"
          ? { action: "add", page: page(), anchor: ask.anchor, text }
          : ask.act == "reply"
            ? { action: "reply", thread: ask.thread, text }
            : { action: "edit", comment: ask.comment, text };
      runTool<{ thread?: unknown; agent?: { working: true } | { reason: string } }>("comment", { document: doc, ...args }).then(
        (r) =>
          send({
            type: "answered",
            card: ask.card,
            action: ask.act,
            thread: r.thread ?? null,
            ...(r.agent ? { agent: r.agent } : {}),
            busy: !!window.ergaAgentPanel?.busy,
          }),
        (err: Error) => send({ type: "failed", card: ask.card, action: ask.act, message: err.message, text })
      );
    }
  }

  function grow() {
    area.style.height = "";
    area.style.height = Math.min(160, area.scrollHeight) + "px";
    box.classList.toggle("has", !!area.value.trim());
  }

  /** The part of the window the frame's page shows in: its place, and of that what the frame covers. */
  function frameView() {
    const f = ergaFrames.frame,
      r = f.getBoundingClientRect();
    return {
      r,
      left: Math.max(r.left, f.offsetLeft),
      right: Math.min(r.right, f.offsetLeft + f.offsetWidth),
      top: r.top,
      bottom: r.bottom,
    };
  }

  let looping = false;
  /** The box where its place is on the screen, each frame while it is open: the page and the frame move under it. */
  function draw() {
    const ask = state.ask;
    box.hidden = !ask || !place;
    if (!ask || !place) return;
    area.placeholder = LABEL[ask.act];
    area.setAttribute("aria-label", LABEL[ask.act]);
    const busy = state.busy.includes(ask.card) || (ask.act == "edit" && state.was == null);
    area.readOnly = busy;
    box.classList.toggle("busy", busy);
    const v = frameView(),
      z = ergaFrames.scale();
    const left = v.r.left + place.x * z,
      top = v.r.top + place.y * z;
    Object.assign(box.style, { left: left + "px", top: top + "px", width: place.w * z + "px" });
    // Only over the frame's place: never over the window's bars, the agent's panel, or a page that is hidden.
    host.style.clipPath = `inset(${v.top}px ${innerWidth - v.right}px ${innerHeight - v.bottom}px ${v.left}px)`;
    host.style.visibility = ergaFrames.frame.checkVisibility({ visibilityProperty: true }) ? "" : "hidden";
    const h = box.offsetHeight;
    if (h != told) {
      told = h;
      tell({ type: "erga-comment-height", card: ask.card, height: h });
    }
    if (!looping) {
      looping = true;
      requestAnimationFrame(() => {
        looping = false;
        draw();
      });
    }
  }

  addEventListener("message", (e) => {
    if (!ergaFrames.from(e) || typeof e.data?.type != "string") return;
    const m = e.data as Record<string, unknown>;
    // A page that came in the frame: the box of the one before closes.
    if (m.type == "erga-hello" || m.type == "erga-nav") {
      place = null;
      send({ type: "asked", ask: null, focus: false });
      return;
    }
    if (m.type != "erga-comment-box") return;
    const a = on() ? askOf(m) : { ask: null, place: null, dark: false, focus: false };
    if (!a) return;
    place = a.place;
    look.classList.toggle("dark", a.dark);
    if (a.ask?.card != state.ask?.card) {
      told = 0;
      // (Over the frame: a load of the page again puts a new frame in its place.)
      if (host.previousElementSibling != ergaFrames.frame) ergaFrames.frame.after(host);
    }
    send({ type: "asked", ask: a.ask, focus: a.focus });
  });

  // The person's agent ended a turn (its panel says so: client/agent/person-agent.ts): a thread that waits for its
  // reply, and has none, says why (libs/text/ui/comments-state.ts).
  addEventListener("erga:agent-turn-end", (e) => {
    if (on()) send({ type: "ended", why: String((e as CustomEvent).detail) });
  });

  // Its keys are its own: Enter sends, Shift+Enter is a new line, Esc closes it. (The window's shortcuts hear theirs
  // first, at the window, as they come down.)
  root.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    k.stopPropagation();
    if (k.isComposing) return;
    if (k.key == "Enter" && !k.shiftKey) {
      k.preventDefault();
      send({ type: "send", text: area.value });
    } else if (k.key == "Escape") {
      k.preventDefault();
      send({ type: "cancel" });
    }
  });
  area.addEventListener("input", () => grow());
  box.querySelector("button")!.addEventListener("click", () => send({ type: "send", text: area.value }));
  box.addEventListener("mousedown", (e) => {
    if (e.target != area) e.preventDefault();
  });

  ergaFrames.frame.after(host);
}
