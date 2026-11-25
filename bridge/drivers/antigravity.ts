// Antigravity adapter: thin configuration over the generic ACP driver (`agy acp`),
// plus lightweight session discovery (from hooks.json) and a `transcript.jsonl`
// mirror so turns and locally-answered questions/permissions in an already-running
// interactive `agy` terminal session also appear in Erga's browser pane.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { ergaHome } from "../core/auth.ts";
import type { AgentDriver, DriverEvent } from "../core/driver.ts";
import { createAcpDriver, extractToolPath } from "./acp.ts";

export interface RecordedSession {
  conversationId: string;
  cwd: string;
  transcriptPath?: string;
  updatedAt: number;
}

function sessionsFile(): string {
  return join(ergaHome(), "antigravity-sessions.json");
}

function readSessions(): Record<string, RecordedSession> {
  const p = sessionsFile();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, RecordedSession>;
    return parsed && typeof parsed == "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Records an active Antigravity conversation from a plugin hook (SessionStart/PreToolUse/PostToolUse/Stop). */
export function recordAntigravitySession(info: { conversationId?: string; cwd?: string; transcriptPath?: string }): RecordedSession | null {
  if (!info.conversationId || !info.cwd) return null;
  const all = readSessions();
  const entry: RecordedSession = {
    conversationId: info.conversationId,
    cwd: info.cwd,
    ...(info.transcriptPath ? { transcriptPath: info.transcriptPath } : {}),
    updatedAt: Date.now(),
  };
  all[info.conversationId] = entry;
  // Prune entries older than 7 days to keep the file tiny.
  const cutoff = Date.now() - 7 * 86_400_000;
  for (const [k, v] of Object.entries(all)) if (v.updatedAt < cutoff) delete all[k];
  const p = sessionsFile();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  renameSync(tmp, p);
  return entry;
}

/** Finds the most recent Antigravity session matching `conversationId` or `cwd`. */
export function findAntigravitySession(opts: { conversationId?: string; cwd?: string }): RecordedSession | null {
  const all = readSessions();
  if (opts.conversationId && all[opts.conversationId]) return all[opts.conversationId];
  const list = Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt);
  if (opts.cwd) {
    const exact = list.find((s) => s.cwd == opts.cwd);
    if (exact) return exact;
  }
  // Fall back to a very recently active session (within the last 2 minutes).
  const newest = list[0];
  return newest && Date.now() - newest.updatedAt < 120_000 ? newest : null;
}

/** Creates the Antigravity AgentDriver (backed by `agy acp`). */
export function createAntigravityDriver(log?: (line: string) => void): AgentDriver {
  const bin = process.env.AGY_BIN || "agy";
  return createAcpDriver(
    {
      id: "antigravity",
      label: "Antigravity",
      command: bin,
      args: ["acp"],
      addDirFlag: "--add-dir",
    },
    log
  );
}

// ---------------------------------------------------------------- transcript.jsonl mirror

interface TranscriptStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  content?: string;
  thinking?: string;
  tool_calls?: { name?: string; args?: Record<string, unknown> }[];
}

/** Extracts the plain user request text from Antigravity's <USER_REQUEST> wrapper. */
export function unwrapUserRequest(raw: string): string {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(raw);
  return (m ? m[1] : raw).trim();
}

/** Parses one Antigravity transcript.jsonl step into zero or more DriverEvents. */
export function parseTranscriptStep(step: TranscriptStep): DriverEvent[] {
  const events: DriverEvent[] = [];
  if (step.type == "USER_INPUT" && step.source == "USER_EXPLICIT" && typeof step.content == "string") {
    const text = unwrapUserRequest(step.content);
    if (text) events.push({ t: "user", text });
    return events;
  }
  if (step.type == "PLANNER_RESPONSE") {
    if (typeof step.thinking == "string" && step.thinking.trim()) {
      events.push({ t: "thinking", delta: step.thinking });
    }
    if (Array.isArray(step.tool_calls)) {
      step.tool_calls.forEach((tc, idx) => {
        const name = tc.name || "tool";
        const id = `local-${step.step_index ?? 0}-${idx}`;
        const path = extractToolPath(name, tc.args);
        events.push({ t: "tool", id, name, path, status: step.status == "DONE" ? "done" : "running" });
      });
    }
    if (typeof step.content == "string" && step.content.trim()) {
      events.push({ t: "text", delta: step.content });
    }
  }
  return events;
}

/**
 * Watches an existing Antigravity conversation's `transcript.jsonl` file and
 * emits DriverEvents for turns or answers completed locally in the terminal.
 * Call `setSuppressed(true)` while an ACP turn initiated by Erga is running so
 * ACP-streamed events are not emitted twice.
 */
export class AntigravityTranscriptMirror {
  private watcher: FSWatcher | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private seenStep = -1;
  private suppressed = false;
  private closed = false;

  constructor(
    readonly transcriptPath: string,
    private readonly onEvents: (events: DriverEvent[]) => void
  ) {}

  /** Starts tailing from the current end of the transcript (or replays recent steps if `replay` is true). */
  start(replay = false): void {
    if (!replay) this.skipExisting();
    else this.scan();
    try {
      this.watcher = watch(dirname(this.transcriptPath), (_ev, name) => {
        if (!name || this.transcriptPath.endsWith(String(name))) this.scan();
      });
    } catch {
      /* fallback poller covers it */
    }
    this.poller = setInterval(() => this.scan(), 1_000);
  }

  setSuppressed(on: boolean): void {
    if (!on && this.suppressed) {
      // Catch up seenStep past what our own ACP turn just wrote so we never duplicate it.
      this.skipExisting();
    }
    this.suppressed = on;
  }

  /** Forces an immediate scan (e.g. triggered by a PostToolUse / Stop hook). */
  poke(): void {
    this.scan();
  }

  stop(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  private skipExisting(): void {
    const steps = this.readSteps();
    for (const s of steps) if (typeof s.step_index == "number" && s.step_index > this.seenStep) this.seenStep = s.step_index;
  }

  private readSteps(): TranscriptStep[] {
    if (!existsSync(this.transcriptPath)) return [];
    try {
      if (statSync(this.transcriptPath).size == 0) return [];
      const text = readFileSync(this.transcriptPath, "utf8");
      const out: TranscriptStep[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as TranscriptStep);
        } catch {
          /* partial line being written */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private scan(): void {
    if (this.closed || this.suppressed) return;
    const steps = this.readSteps();
    const batch: DriverEvent[] = [];
    for (const s of steps) {
      const idx = typeof s.step_index == "number" ? s.step_index : -1;
      if (idx <= this.seenStep) continue;
      if (s.status != "DONE") continue;
      this.seenStep = idx;
      batch.push(...parseTranscriptStep(s));
    }
    if (batch.length) this.onEvents(batch);
  }
}
