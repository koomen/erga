// Helpers for the comments' journey (comments.e2e.ts): the comments' cards as the page shows them, the box over them
// that the window around the page draws, the document's comment table as a person reads it, a person's agent's
// conversation, and a selection made with the mouse.
import type { Editor } from "../helpers/editor";
import { expect } from "../helpers/fixtures";
import { runTool } from "../helpers/tools";

/** A name that no other test (nor a repeat of this one) uses: for logins and titles. */
export const unique = (name: string) => `${name}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

/** Signs in as someone by the dev sign-in (/auth/github?as=): their session cookie. */
export async function signIn(root: string, as: string): Promise<string> {
  const r = await fetch(`${root}/auth/github?as=${as}&next=/documents`, { redirect: "manual" });
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => /^erga_\d+=/.test(c));
  if (!cookie) throw new Error(`signing in as ${as}: ${r.status}`);
  return cookie;
}

/** The threads' cards, one string for each card, as the page shows them. */
export const cards = (ed: Editor) =>
  ed.comments<string[]>(`[...C.querySelectorAll(".card.th")].map((c) => c.innerText.replace(/\\s+/g, " ").trim())`);

export interface Thread {
  id: string;
  quote: string;
  comments: { by: string; via?: string; text: string; edited_at?: string }[];
}

/** A document's open threads, from its comment table, as its owner (DEV_LOGIN) reads them (the read op comments). */
export async function threadsOf(root: string, document: string): Promise<Thread[]> {
  const r = await runTool<{ threads: Thread[] }>(root, "comments", { document });
  if (!r.ok) throw new Error(`comments: ${r.error}`);
  return r.result!.threads;
}

/** A person's agent's thread for the document `doc` (DEV_LOGIN's, or the person's whose session `cookie` is): its items, in order. */
export async function conversation(root: string, doc: string, cookie?: string) {
  const r = await fetch(`${root}/api/agent/conversation?doc=${doc}`, cookie ? { headers: { Cookie: cookie } } : {});
  return ((await r.json()) as { log: { busy: boolean; items: { kind: string; status?: string; text?: string }[] } }).log;
}

/**
 * The comment box, as the window around the page draws it over the page (client/common/comment-box.ts): its label, its
 * text, whether it has the focus, and where it is on the screen; null while none shows. `lines`: its height, its line's
 * height, and how far from the line's middle the box's middle and the send button's middle are (px).
 */
export const theBox = (ed: Editor) =>
  ed.eval<{
    label: string;
    value: string;
    focused: boolean;
    rect: { left: number; top: number; width: number; height: number };
    lines: { box: number; line: number; boxMid: number; goMid: number };
  } | null>(`(() => {
    const R = document.querySelector("erga-comment-box")?.shadowRoot, box = R?.getElementById("box");
    if (!box || box.hidden) return null;
    const area = box.querySelector("textarea"), go = box.querySelector(".go");
    const s = getComputedStyle(area), lh = parseFloat(s.lineHeight);
    const b = box.getBoundingClientRect(), a = area.getBoundingClientRect(), g = go.getBoundingClientRect();
    const line = a.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop) + lh / 2;
    return { label: area.placeholder, value: area.value, focused: R.activeElement == area,
      rect: { left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) },
      lines: { box: Math.round(b.height), line: Math.round(lh), boxMid: Math.round(b.top + b.height / 2 - line), goMid: Math.round(g.top + g.height / 2 - line) } };
  })()`);

/** Waits until the box with this label has the focus, as a person sees its caret before they type. */
export async function boxFocused(ed: Editor, label: string) {
  await expect
    .poll(async () => {
      const b = await theBox(ed);
      return b?.focused ? b.label : null;
    })
    .toBe(label);
}

/** A click on the open card (its first line): the box with this label, in it, takes the focus. */
export async function clickBox(ed: Editor, label: string) {
  await expect.poll(async () => (await theBox(ed))?.label ?? null).toBe(label);
  await ed.clickIn("erga-comments", ".card.th:not(.dim) .who .nm");
  await boxFocused(ed, label);
}

/** The open card's place for the box, on the screen (px in the tab, after the zoom). */
export async function slotOnScreen(ed: Editor) {
  const r = await ed.comments<{ left: number; top: number; width: number; height: number; z: number }>(`(() => {
    const r = C.querySelector(".slot").getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, z: window.ergaFrame.zoom };
  })()`);
  const f = await ed.frameAt();
  return {
    left: Math.round(f.x + r!.left * r!.z),
    top: Math.round(f.y + r!.top * r!.z),
    width: Math.round(r!.width * r!.z),
    height: Math.round(r!.height * r!.z),
  };
}

/** Selects characters [from, to) of an element's first text node with the mouse, as a reader does (no editor's keys). */
export async function selectText(ed: Editor, selector: string, from: number, to: number) {
  const at = await ed.frame<{ x1: number; x2: number; y: number }>(`(() => {
    const t = document.querySelector(${JSON.stringify(selector)}).firstChild, r = document.createRange();
    r.setStart(t, ${from}); r.setEnd(t, ${to});
    const b = r.getBoundingClientRect(); return { x1: b.left, x2: b.right, y: b.top + b.height / 2 };
  })()`);
  const f = await ed.frameAt();
  const mouse = ed.page.mouse;
  await mouse.move(f.x + at.x1, f.y + at.y);
  await mouse.down();
  await mouse.move(f.x + (at.x1 + at.x2) / 2, f.y + at.y, { steps: 4 });
  await mouse.move(f.x + at.x2, f.y + at.y, { steps: 4 });
  await mouse.up();
}

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Where things are on the screen (px in the tab, after the zoom): a thread's card (null when it shows no card), its
 * highlighted text, the page's text column (the page's <body>), and the part of the page's frame that shows (its place).
 */
export async function onScreen(ed: Editor, thread: string) {
  const inFrame = await ed.frame<{ z: number; card: Box | null; text: Box; column: Box }>(`(() => {
    const box = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    const C = document.querySelector("erga-comments").shadowRoot;
    const card = C.querySelector('.card.th[data-thread="${thread}"]');
    const ranges = [...(CSS.highlights.get("erga-comment-on") ?? []), ...(CSS.highlights.get("erga-comment") ?? [])];
    const rects = ranges.flatMap((r) => [...r.getClientRects()]);
    const text = { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)),
      top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
    return { z: window.ergaFrame.zoom, card: card ? box(card.getBoundingClientRect()) : null, text, column: box(document.body.getBoundingClientRect()) };
  })()`);
  const shell = await ed.eval<{ x: number; y: number; left: number; right: number }>(`(() => {
    const f = document.getElementById("frame"), r = f.getBoundingClientRect();
    return { x: r.left, y: r.top, left: f.offsetLeft, right: f.offsetLeft + f.offsetWidth };
  })()`);
  const z = inFrame.z;
  const screen = (b: Omit<Box, "width" | "height">): Box => {
    const s = { left: shell.x + b.left * z, right: shell.x + b.right * z, top: shell.y + b.top * z, bottom: shell.y + b.bottom * z };
    return { ...s, width: Math.round(s.right - s.left), height: Math.round(s.bottom - s.top) };
  };
  return {
    card: inFrame.card && screen(inFrame.card),
    text: screen(inFrame.text),
    column: screen(inFrame.column),
    place: { left: shell.left, right: shell.right },
  };
}
