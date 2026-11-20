// The agent conversation as the editor shows it, shared by the host (which
// keeps the transcript, so a reload picks it back up) and the shell (which
// renders it). The agent loop (agents/run.ts) folds its run into these small events,
// sends each one to its user's tabs over their event WebSocket, and both
// apply them with `reduce`. Tool calls an external agent makes through the
// API (`via: "external"`) land in the same transcript. A transcript is private to one person and one document: their
// tabs all show it, collaborators never see it.

import type { FileRef } from "./attach";

/** A tool call's state; "asking": it waits for the person's Approve (`detail` says what it would do, `call` is the call). */
export type ToolStatus = "running" | "asking" | "done" | "error";

/** A tool call as the model made it: the tool's name, and its arguments (its `op` among them). */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

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
      call?: ToolCall;
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
      call?: ToolCall;
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

/**
 * Why a turn that just ended left no reply, in one short sentence (a comment's thread shows it: libs/text/ui/comments.ts):
 * it stopped on an error, it waits for the person's answer to a call, or it just ended.
 */
export function turnEnded(log: Log): string {
  const user = log.items.map((i) => i.kind).lastIndexOf("user");
  const turn = log.items.slice(user + 1);
  const error = turn.filter((i) => i.kind == "error").at(-1);
  if (error) return `It stopped: ${error.text.trim().replace(/\.$/, "")}.`;
  if (turn.some((i) => i.kind == "tool" && i.status == "asking")) return "It waits for your answer in your agent panel.";
  return "Its turn ended with no reply here.";
}

/**
 * A thinking block's one line in the panel: its last line with text, as the model wrote it. A block of white space
 * has none (Pi's OpenAI adapter ends each part of a summary with "\n\n").
 */
export const progress = (text: string): string => text.trimEnd().split("\n").at(-1)!.trim();

/**
 * Whether item `i` has a line in the panel. A tool call that the person must see or answer has one: a call that waits
 * for them, a picture that a tool returned, an error that nothing got past (a later call on the same file that worked
 * makes it history). Of the other calls, one line only: the turn's last call, while the turn runs. The next call takes
 * its place, and the turn's end removes it. Of the model's thinking, one line only too (progress): the last block,
 * while the turn runs, until the model says something or thinks again.
 */
export function shown(log: Log, i: number): boolean {
  const item = log.items[i];
  const after = log.items.slice(i + 1);
  if (item.kind == "thinking") return log.busy && !!progress(item.text) && after.every((x) => x.kind == "tool");
  if (item.kind != "tool" || item.status == "asking" || item.image) return true;
  if (item.status == "error")
    return !after.some((x) => x.kind == "tool" && x.status == "done" && x.path == item.path && (x.name == item.name || x.name == "write"));
  return log.busy && !after.some((x) => x.kind == "tool") && (item.status == "running" || !after.some((x) => x.kind == "user"));
}

/** An argument's text on the card may be this long, on this many lines: the rest shows on a click. */
const CUT = { chars: 160, lines: 4 };
/** Characters that draw nothing, or that change the order of the text around them: the card writes each as its code. */
const UNSEEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** What the card of a call that waits shows: all text, from the model, for the page to escape. */
export interface Asked {
  /** The tool's sentence for the call; null when it has none, or only the tool's own name. */
  says: string | null;
  /** The tool, and the operation of it that the call names. */
  head: string;
  /** Each other argument, in the call's order; `cut`: the start of a long text, which shows before a click. */
  args: { key: string; text: string; cut: string | null }[];
}

/**
 * The card of a call that waits for the person's Approve: the tool's sentence, and the call itself, whole. The
 * sentence is the server's words about the arguments; the arguments are what runs. A string shows as it is, any other
 * value as JSON.
 */
export function asked(item: { name: string; detail?: string; call?: ToolCall }): Asked {
  const { tool, args } = item.call ?? { tool: item.name, args: {} };
  const op = typeof args.op == "string" && args.op ? args.op : null;
  const seen = (s: string) => s.replace(UNSEEN, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const says = seen(item.detail?.trim() ?? "");
  const own = [tool, op, item.name].some((n) => n?.toLowerCase() == says.toLowerCase());
  return {
    says: says && !own ? says : null,
    head: seen(op ? `${tool} ${op}` : tool),
    args: Object.entries(args)
      .filter(([key]) => !(op && key == "op"))
      .map(([key, value]) => {
        const text = seen(typeof value == "string" && value ? value : (JSON.stringify(value) ?? "undefined"));
        const start = text.split("\n").slice(0, CUT.lines).join("\n").slice(0, CUT.chars);
        return { key: seen(key), text, cut: start.length < text.length ? start : null };
      }),
  };
}

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
        call: ev.call,
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
