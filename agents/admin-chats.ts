// What the AdminAgent object keeps of each admin's agent conversation, so it
// survives a reload, a move between admin pages, a new deploy and a sign-in days later: the transcript the
// panel shows and the model's own messages (pi's), so the agent remembers too. And
// each admin's panel: open or closed, its side and its width (agent_prefs).
//
// A reply that was still streaming when the object went away keeps what arrived: a tool that was running
// shows as stopped, and a tool call with no result is dropped from the model's messages, which the model's
// API would refuse.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { emptyLog, type Log, type LogItem } from "../client/agent-log";

/** The most a stored transcript, or the model's messages, takes (a SQLite value in a Durable Object is at most 2 MB). */
export const CHAT_BUDGET = 900_000;
export const STOPPED = "Stopped: the server restarted before this finished.";
/** Where a reply was cut off: what arrived stays above it. */
export const CUT = "The server restarted before the agent finished. What arrived is kept; send your message again to go on.";
const SHOWN = "(The admin saw a screenshot here; it is not kept.)";

const size = (v: unknown) => JSON.stringify(v).length;

/** The transcript to store: as it is, or without its screenshots, then without its oldest items, to fit `budget`. */
export function storedLog(log: Log, budget = CHAT_BUDGET): string {
  let items: LogItem[] = log.items;
  const out = () => JSON.stringify({ items, busy: log.busy, undoable: log.undoable });
  if (size(items) > budget) items = items.map((i) => (i.kind == "tool" && i.image ? { ...i, image: undefined } : i));
  if (size(items) > budget) {
    let total = items.reduce((n, i) => n + size(i) + 1, 0), from = 0;
    while (from < items.length - 1 && total > budget) total -= size(items[from++]) + 1;
    items = items.slice(from);
  }
  return out();
}

/** A stored transcript, ready to show: never busy (nothing runs now); a tool that was running, stopped; a cut-off reply, marked. */
export function restoredLog(raw: string | null | undefined): Log {
  let v: { items?: unknown; busy?: unknown; undoable?: unknown } | null = null;
  try { v = JSON.parse(raw ?? "null"); } catch { /* a broken row: start again */ }
  if (!v || !Array.isArray(v.items)) return emptyLog();
  const items = (v.items as LogItem[]).filter((i) => i && typeof i == "object" && typeof i.kind == "string")
    .map((i): LogItem => (i.kind == "tool" && i.status == "running" ? { ...i, status: "error", detail: STOPPED } : i));
  if (v.busy === true) items.push({ kind: "error", text: CUT });
  return { items, busy: false, undoable: typeof v.undoable == "number" ? v.undoable : 0 };
}

/** The model's messages to store: screenshots replaced with a line of text, the oldest turns dropped to fit `budget`. */
export function storedMessages(messages: AgentMessage[], budget = CHAT_BUDGET): string {
  let msgs = messages.map((m) => {
    const c = (m as { content?: unknown }).content;
    if (!Array.isArray(c) || !c.some((p) => p?.type == "image")) return m;
    return { ...m, content: c.map((p) => (p?.type == "image" ? { type: "text", text: SHOWN } : p)) } as AgentMessage;
  });
  // Whole turns go, from a user's message to the next, so a tool call never loses its result.
  while (size(msgs) > budget) {
    const next = msgs.findIndex((m, i) => i > 0 && (m as { role?: string }).role == "user");
    if (next < 0) { msgs = []; break; }
    msgs = msgs.slice(next);
  }
  return JSON.stringify(msgs);
}

/** Stored messages, ready for the model: they end before an assistant's tool call that has no result. */
export function restoredMessages(raw: string | null | undefined): AgentMessage[] {
  let v: unknown = null;
  try { v = JSON.parse(raw ?? "null"); } catch { /* a broken row: start again */ }
  if (!Array.isArray(v)) return [];
  const msgs = v.filter((m) => m && typeof m == "object" && typeof m.role == "string") as AgentMessage[];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as { role: string; content?: { type: string; id?: string }[] };
    if (m.role != "assistant" || !Array.isArray(m.content)) continue;
    const calls = m.content.filter((c) => c?.type == "toolCall").map((c) => c.id);
    if (!calls.length) continue;
    const results = new Set<string>();
    for (let j = i + 1; j < msgs.length && (msgs[j] as { role: string }).role == "toolResult"; j++) results.add((msgs[j] as { toolCallId: string }).toolCallId);
    if (calls.some((id) => !results.has(id!))) return msgs.slice(0, i);
  }
  return msgs;
}

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
