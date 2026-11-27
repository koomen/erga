// The person's agent panel as the browser keeps it, in one place: open or closed, and the panel as this tab's last
// page drew it (this tab's, so the next page of the same thread shows the same conversation from its first paint).
// Open or closed is kept as the threads are (agents/person/sessions.ts): one value for each document (OPEN and its
// id, as the zoom's), and one for every page outside a document (erga:settings:v1). A document with none of its own
// takes the last document's (LAST: the one the person was on last, or opened or closed it on). In this browser's localStorage, for all its tabs: the page reads it before its first paint
// (client/inline/agent-toggle.ts; on a document's page, client/inline/viewer-layout-early.ts), with no request.
// client/agent/person-agent.ts keeps the drawn panel as a page goes; sign-out forgets it. The server keeps the
// conversation itself.

/**
 * The panel as a page drew it: the conversation's markup, the model, and the scroll place. Only `person`'s, and only
 * for a page of the same thread (`doc`: the document's id; null: a page outside a document).
 */
export interface Drawn {
  person: string;
  doc: string | null;
  log: string;
  model: string;
  choice?: string;
  top: number;
  bottom: boolean;
}

export interface Panel {
  open: boolean;
  drawn: Drawn | null;
}

const SETTINGS = "erga:settings:v1",
  LAST = "erga:agent:v1",
  OPEN = LAST + ":",
  DRAWN = "erga:agent-panel";

const json = (s: Storage, k: string): unknown => {
  try {
    return JSON.parse(s.getItem(k) || "null");
  } catch {
    return null;
  }
};
const settings = () => (json(localStorage, SETTINGS) ?? {}) as Record<string, unknown>;

/** The document a page shows (its id: server/pages/viewer.ts); null on a page outside a document. */
export const pageDoc = (): string | null => document.querySelector<HTMLMetaElement>('meta[name="erga-doc"]')?.content ?? null;

/**
 * Whether the panel is open on `doc`'s pages (null: the pages outside a document, which share one value): as the
 * person left it there; a document they never opened or closed it on, as the last document they were on; open
 * unless closed.
 */
export function panelOpen(doc: string | null): boolean {
  try {
    if (!doc) return settings().agent !== false;
    return (localStorage.getItem(OPEN + doc) ?? localStorage.getItem(LAST)) != "closed";
  } catch {
    return true;
  }
}

/** The person is on `doc`'s page: the next document with no value of its own takes this one's. */
export function panelVisit(doc: string): void {
  try {
    const own = localStorage.getItem(OPEN + doc);
    if (own) localStorage.setItem(LAST, own);
  } catch {
    /* no storage */
  }
}

/** The panel as kept for `doc`'s pages: open or closed; the tab's last drawing, if any. */
export function restorePanel(doc: string | null): Panel {
  try {
    return { open: panelOpen(doc), drawn: json(sessionStorage, DRAWN) as Drawn | null };
  } catch {
    return { open: true, drawn: null };
  }
}

/** Keeps what's given: `open`, for `doc`'s pages (panelOpen); `drawn: null` forgets the tab's drawing. */
export function savePanel(p: Partial<Panel>, doc: string | null = null): void {
  try {
    if (p.open != null && doc) for (const k of [OPEN + doc, LAST]) localStorage.setItem(k, p.open ? "open" : "closed");
    else if (p.open != null) localStorage.setItem(SETTINGS, JSON.stringify({ ...settings(), agent: p.open }));
    if (p.drawn === null) sessionStorage.removeItem(DRAWN);
    else if (p.drawn) sessionStorage.setItem(DRAWN, JSON.stringify(p.drawn));
  } catch {
    // Private mode, or full: no drawing is better than an old one.
    try {
      if (p.drawn) sessionStorage.removeItem(DRAWN);
    } catch {
      /* no storage */
    }
  }
}

/**
 * The conversation in this page's panel: as the tab's last page left it (drawn before the page paints), until the
 * agent's script loads it from the server.
 */
export type PanelPhase = "as-left" | "loaded";
export type PanelEvent = { t: "loaded" } | { t: "leave"; drawn: Drawn };

/** What the page keeps as it goes: the panel as drawn now once loaded; before that, the tab's copy stays as it is. */
export function panelStep(s: PanelPhase, ev: PanelEvent): { state: PanelPhase; save: Drawn | null } {
  if (ev.t == "loaded") return { state: "loaded", save: null };
  return { state: s, save: s == "loaded" ? ev.drawn : null };
}

/**
 * Whether the active agent currently waits for the person's answer (`asking` tool calls) and which call IDs this page
 * has already reacted to, so collapsing the panel never fights the user while a new blocked call still expands it.
 */
export type BlockedState = { readonly at: "idle" } | { readonly at: "blocked"; readonly seen: readonly string[] };
export type BlockedEvent = { readonly t: "sync"; readonly asking: readonly string[]; readonly open: boolean };

export const IDLE_BLOCKED: BlockedState = { at: "idle" };

/** Decides whether to auto-expand a collapsed panel when a connected or embedded agent is blocked on an approval card. */
export function blockedStep(s: BlockedState, ev: BlockedEvent): { state: BlockedState; expand: boolean } {
  if (!ev.asking.length) return { state: IDLE_BLOCKED, expand: false };
  const prev = s.at == "blocked" ? s.seen : [];
  const fresh = ev.asking.some((id) => !prev.includes(id));
  return { state: { at: "blocked", seen: [...ev.asking] }, expand: fresh && !ev.open };
}
