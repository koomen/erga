// Helpers for the comments' journey (comments.e2e.ts): the comments' cards as the page shows them, the document's
// comment table as a person reads it, a person's agent's conversation, and a selection made with the mouse.
import type { Editor } from "../helpers/editor";
import { runTool } from "../helpers/tools";

/** A name that no other test (nor a repeat of this one) uses: for logins and titles. */
export const unique = (name: string) => `${name}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

/** Signs in as someone by the dev sign-in (/auth/github?as=): their session cookie. */
export async function signIn(root: string, as: string): Promise<string> {
  const r = await fetch(`${root}/auth/github?as=${as}&next=/docs`, { redirect: "manual" });
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => /^erga_session(_\d+)?=/.test(c));
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

/** A person's agent's conversation (DEV_LOGIN's, or the person's whose session `cookie` is): its items, in order. */
export async function conversation(root: string, cookie?: string) {
  const r = await fetch(`${root}/api/agent/conversation`, cookie ? { headers: { Cookie: cookie } } : {});
  return ((await r.json()) as { log: { busy: boolean; items: { kind: string; status?: string; text?: string }[] } }).log;
}

/**
 * The new comment's box, as the page draws it: its height, its line's height, and how far from the line's middle the
 * box's middle and the send button's middle are (px). The text starts at the box's top, after its padding.
 */
export const draftBox = (ed: Editor) =>
  ed.comments<{ box: number; line: number; boxMid: number; goMid: number }>(`(() => {
    const box = C.querySelector(".card.draft .reply"), area = box.querySelector("textarea"), go = box.querySelector(".go");
    const s = getComputedStyle(area), lh = parseFloat(s.lineHeight);
    const b = box.getBoundingClientRect(), a = area.getBoundingClientRect(), g = go.getBoundingClientRect();
    const line = a.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop) + lh / 2;
    return { box: Math.round(b.height), line: Math.round(lh), boxMid: Math.round(b.top + b.height / 2 - line), goMid: Math.round(g.top + g.height / 2 - line) };
  })()`);

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
