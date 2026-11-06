// The person's agent panel as the browser keeps it, in one place: open or closed (this browser's, in erga:settings:v1,
// as the editor keeps its settings), and the panel as this tab's last page drew it (this tab's, so the next page shows
// the same conversation from its first paint). client/inline/agent-toggle.ts restores it before the page paints;
// client/agent/person-agent.ts keeps the drawn panel as a page goes; sign-out forgets it. The server keeps the
// conversation itself (agents/person/sessions.ts).

/** The panel as a page drew it: the conversation's markup, the model, and the scroll place. Only `person`'s. */
export interface Drawn {
  person: string;
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
  DRAWN = "erga:agent-panel";

const json = (s: Storage, k: string): unknown => {
  try {
    return JSON.parse(s.getItem(k) || "null");
  } catch {
    return null;
  }
};
const settings = () => (json(localStorage, SETTINGS) ?? {}) as Record<string, unknown>;

/** The panel as kept: open unless closed before; the tab's last drawing, if any. */
export function restorePanel(): Panel {
  try {
    return { open: settings().agent !== false, drawn: json(sessionStorage, DRAWN) as Drawn | null };
  } catch {
    return { open: true, drawn: null };
  }
}

/** Keeps what's given; `drawn: null` forgets the tab's drawing. */
export function savePanel(p: Partial<Panel>): void {
  try {
    if (p.open != null) localStorage.setItem(SETTINGS, JSON.stringify({ ...settings(), agent: p.open }));
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
