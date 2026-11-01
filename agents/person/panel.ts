// Each admin's agent panel, as they left it: open or closed, its side and its
// width (agent_prefs, in the admin agents' object). Their conversation is kept
// step by step: agents/checkpoint.ts.

/** An admin's agent panel, as they left it: open or closed (on a wide window), which side, how wide. */
export interface PanelPrefs { open?: boolean; side?: "left" | "right"; width?: number }

/** Prefs from anything (a request's body, a stored row): only what is valid. */
export function panelPrefs(raw: unknown): PanelPrefs {
  const r = (raw && typeof raw == "object" ? raw : {}) as Record<string, unknown>;
  const p: PanelPrefs = {};
  if (typeof r.open == "boolean") p.open = r.open;
  if (r.side == "left" || r.side == "right") p.side = r.side as "left" | "right";
  if (typeof r.width == "number" && Number.isFinite(r.width)) p.width = Math.max(100, Math.min(4000, Math.round(r.width)));
  return p;
}
