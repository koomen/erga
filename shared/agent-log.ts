// The agent conversation as the editor shows it, shared by the host (which
// keeps the transcript, so a reload picks it back up) and the shell (which
// renders it). The agent loop (agents/run.ts) folds its run into these small events,
// sends each one to its user's tabs over their event WebSocket, and both
// apply them with `reduce`. Tool calls an external agent makes through the
// API (`via: "external"`) land in the same transcript. A transcript is private to one person and one document: their
// tabs all show it, collaborators never see it.

import type { FileRef } from "./attach";

/** A tool call's state; "asking": it waits for the person's Approve (`detail` says what it would do). */
export type ToolStatus = "running" | "asking" | "done" | "error";

export type LogItem =
  /** `files`: what was attached, as the log shows it; `id`: the sending tab's own id for it (client/agent/sends.ts). */
  | { kind: "user"; text: string; files?: FileRef[]; id?: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      path: string | null;
      status: ToolStatus;
      detail?: string;
      image?: string;
      via?: "external";
    }
  | { kind: "error"; text: string };

export type LogEvent =
  | { t: "user"; text: string; files?: FileRef[]; id?: string }
  | { t: "text"; delta: string }
  | { t: "thinking"; delta: string }
  | {
      t: "tool";
      id: string;
      name: string;
      path: string | null;
      status: ToolStatus;
      detail?: string;
      image?: string;
      via?: "external";
    }
  | { t: "error"; text: string }
  | { t: "busy"; busy: boolean }
  /** How many of the agent's changes "Undo the agent's change" can take back. */
  | { t: "undoable"; count: number; redo: number }
  | { t: "reset" };

export interface Log { items: LogItem[]; busy: boolean; undoable: number }

export const emptyLog = (): Log => ({ items: [], busy: false, undoable: 0 });

/** Applies one event in place; returns the index of the item it touched, or -1. */
export function reduce(log: Log, ev: LogEvent): number {
  const items = log.items;
  const last = items[items.length - 1];
  switch (ev.t) {
    case "user":
      items.push({ kind: "user", text: ev.text, ...(ev.files?.length ? { files: ev.files } : {}), ...(ev.id ? { id: ev.id } : {}) });
      return items.length - 1;
    case "text":
      if (last?.kind == "assistant") { last.text += ev.delta; return items.length - 1; }
      items.push({ kind: "assistant", text: ev.delta });
      return items.length - 1;
    case "thinking":
      if (last?.kind == "thinking") { last.text += ev.delta; return items.length - 1; }
      items.push({ kind: "thinking", text: ev.delta });
      return items.length - 1;
    case "tool": {
      const i = items.findIndex((x) => x.kind == "tool" && x.id == ev.id);
      const item: LogItem = {
        kind: "tool",
        id: ev.id,
        name: ev.name,
        path: ev.path,
        status: ev.status,
        detail: ev.detail,
        image: ev.image,
        via: ev.via,
      };
      if (i >= 0) {
        items[i] = item;
        return i;
      }
      items.push(item);
      return items.length - 1;
    }
    case "error": items.push({ kind: "error", text: ev.text }); return items.length - 1;
    case "busy": log.busy = ev.busy; return -1;
    case "undoable": log.undoable = ev.count; return -1;
    case "reset": items.length = 0; log.busy = false; return -1;
  }
}
