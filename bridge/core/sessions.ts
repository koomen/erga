// An agent's own terminal sessions, as its plugin's hooks report them: the
// record of each session on disk (~/.erga/<agent>-sessions.json: metadata
// only, never secrets), and the events that one hook call gives the browser
// panel. Each driver turns its agent's hook payload into a HookPayload.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ergaHome } from "./auth.ts";
import { extractToolPath, type DriverEvent } from "./driver.ts";

export interface RecordedSession {
  conversationId: string;
  cwd: string;
  transcriptPath?: string;
  /** The agent's process that runs the session, where its hooks tell it. */
  pid?: number;
  updatedAt: number;
}

/** One call of an agent's plugin hook, in the bridge's shape. */
export interface HookPayload {
  /** SessionStart, PreInvocation (a turn starts), PreToolUse, PermissionRequest, PostToolUse, PostInvocation or Stop. */
  hookEventName?: string;
  conversationId?: string;
  cwd?: string;
  transcriptPath?: string;
  modelName?: string;
  stepIdx?: number;
  invocationNum?: number;
  fullyIdle?: boolean;
  continuationActive?: boolean;
  error?: string;
  toolCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
  /** PreInvocation: what the user typed in the terminal. */
  prompt?: string;
  /** Stop: the agent's last message of the turn. */
  reply?: string;
  /** The agent's process, where the hook is its child. */
  pid?: number;
  /** PermissionRequest: the hook asks again for the answer to a request that it made before. */
  again?: boolean;
}

function sessionsFile(agent: string): string {
  return join(ergaHome(), `${agent}-sessions.json`);
}

function readSessions(agent: string): Record<string, RecordedSession> {
  const p = sessionsFile(agent);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, RecordedSession>;
    return parsed && typeof parsed == "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Records an agent's active session from a plugin hook. */
export function recordSession(
  agent: string,
  info: { conversationId?: string; cwd?: string; transcriptPath?: string; pid?: number }
): RecordedSession | null {
  if (!info.conversationId || !info.cwd) return null;
  const all = readSessions(agent);
  const prev = all[info.conversationId];
  const entry: RecordedSession = {
    conversationId: info.conversationId,
    cwd: info.cwd,
    ...(info.transcriptPath || prev?.transcriptPath ? { transcriptPath: info.transcriptPath ?? prev?.transcriptPath } : {}),
    ...(info.pid || prev?.pid ? { pid: info.pid ?? prev?.pid } : {}),
    updatedAt: Date.now(),
  };
  // The file keeps the sessions in the order of their last record: two records of one millisecond stay in order.
  delete all[info.conversationId];
  all[info.conversationId] = entry;
  const cutoff = Date.now() - 7 * 86_400_000;
  for (const [k, v] of Object.entries(all)) if (v.updatedAt < cutoff) delete all[k];
  const p = sessionsFile(agent);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  renameSync(tmp, p);
  return entry;
}

/** Finds an agent's most recent session matching `conversationId`, the agent's process (`pid`), or exact `cwd` (never falls back across repos). */
export function findSession(agent: string, opts: { conversationId?: string; cwd?: string; pid?: number }): RecordedSession | null {
  const all = readSessions(agent);
  if (opts.conversationId) return all[opts.conversationId] ?? null;
  const list = Object.values(all)
    .reverse()
    .sort((a, b) => b.updatedAt - a.updatedAt);
  // The agent's process names its session exactly (the last one whose hook it ran): no guess.
  if (opts.pid) return list.find((s) => s.pid == opts.pid) ?? null;
  if (opts.cwd) return list.find((s) => s.cwd == opts.cwd) ?? null;
  return null;
}

/** Translates one plugin hook call into real-time DriverEvents for the Erga browser panel. */
export function hookEvents(payload: HookPayload): DriverEvent[] {
  const ev = payload.hookEventName;
  if (ev == "PreInvocation") return payload.prompt?.trim() ? [{ t: "user", text: payload.prompt.trim() }] : [];
  if (ev == "PreToolUse" || ev == "PostToolUse") {
    const tc = payload.toolCall;
    const name = tc?.name || "tool";
    const id = tc?.id || `hook-${payload.stepIdx ?? 0}-${name}`;
    const path = extractToolPath(name, tc?.args);
    if (ev == "PreToolUse") return [{ t: "tool", id, name, path, status: "running" }];
    const err = typeof payload.error == "string" && payload.error.trim() ? payload.error.trim().slice(0, 200) : undefined;
    return [{ t: "tool", id, name, path, status: err ? "error" : "done", ...(err ? { detail: err } : {}) }];
  }
  if (ev == "Stop") {
    const out: DriverEvent[] = [];
    if (payload.reply?.trim()) out.push({ t: "text", delta: payload.reply.trim() });
    if (typeof payload.error == "string" && payload.error.trim()) out.push({ t: "error", text: payload.error.trim() });
    if (payload.fullyIdle !== false && !payload.continuationActive) {
      out.push({ t: "busy", busy: false }, { t: "turn_done" });
    }
    return out;
  }
  return [];
}
