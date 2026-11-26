// Antigravity adapter:
//   (1) Native live-session bridge: injects browser prompts directly into an
//       already-running interactive `agy` CLI session via `agy agentapi send-message`
//       (using that session's ANTIGRAVITY_LS_ADDRESS + ANTIGRAVITY_CSRF_TOKEN),
//       translates Antigravity plugin hooks (PreToolUse/PostToolUse/PostInvocation/Stop)
//       into real-time DriverEvents, and tails `transcript.jsonl` for thinking/text.
//   (2) Standalone ACP fallback (`agy acp`) for headless `erga-agent connect` runs
//       with no interactive terminal session.

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { extractToolPath, type AgentDriver, type DriverEvent } from "../core/driver.ts";
import type { HookPayload } from "../core/sessions.ts";
import { createAcpDriver } from "./acp.ts";

/** In-memory connection handle to a live running Antigravity CLI process (never written to disk). */
export interface LiveAntigravitySession {
  readonly conversationId: string;
  readonly lsAddress: string;
  readonly csrfToken: string;
  readonly cwd: string;
  readonly transcriptPath?: string | null;
}

/** Interface for talking to a live Antigravity process (injectable in unit tests). */
export interface LiveAntigravityMessenger {
  send(session: LiveAntigravitySession, text: string, opts?: { title?: string }): Promise<void>;
  check(session: LiveAntigravitySession): Promise<"running" | "idle" | "gone">;
}

/** Default transcript path for an Antigravity conversation when hooks have not reported one yet. */
export function defaultTranscriptPath(conversationId: string, appDataDir?: string): string | null {
  const base = appDataDir || process.env.ANTIGRAVITY_APP_DATA_DIR;
  if (!base || !conversationId) return null;
  const full = join(base, "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl");
  if (existsSync(full)) return full;
  const compact = join(base, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
  return existsSync(compact) ? compact : full;
}

/** Creates the standalone Antigravity ACP AgentDriver (`agy acp`), used when no live terminal session is attached. */
export function createAntigravityDriver(log?: (line: string) => void): AgentDriver {
  const bin = process.env.AGY_BIN || "agy";
  return {
    ...createAcpDriver(
      {
        id: "antigravity",
        label: "Antigravity",
        command: bin,
        args: ["acp"],
        addDirFlag: "--add-dir",
        autoApproveFlag: "--dangerously-skip-permissions",
      },
      log
    ),
    sessionEnv: "ANTIGRAVITY_CONVERSATION_ID",
    openHint: OPEN_HINT,
    // Antigravity's hook payload is the bridge's own shape. A PreToolUse hook must answer: it never blocks the tool.
    hook: (raw) => ({
      payload: raw as HookPayload,
      reply: (answer) => answer ?? (raw.hookEventName == "PreToolUse" ? { decision: "allow" } : {}),
    }),
  };
}

const OPEN_HINT = `- When the user asks to edit an Erga document URL (or create a new Erga doc), prefer running \`erga-agent open <url>\` via run_command so the live Yjs room mounts AND Erga's browser panel connects directly to THIS running session without spawning a second agent.
- If you call erga_open via MCP and it returns liveAttached: false, run \`erga-agent attach\` via run_command so browser prompts route straight into this running session.`;

// ---------------------------------------------------------------- live session injection (`agy agentapi`)

/** Sends a prompt directly into a running Antigravity CLI session using its own local language server. */
export async function sendLiveAntigravityMessage(
  session: LiveAntigravitySession,
  text: string,
  opts: { title?: string; bin?: string } = {}
): Promise<void> {
  const bin = opts.bin || process.env.AGY_BIN || "agy";
  const title = opts.title || "Erga browser panel";
  const proc = Bun.spawn([bin, "agentapi", "send-message", "--title", title, session.conversationId, text], {
    cwd: session.cwd,
    env: {
      ...process.env,
      ANTIGRAVITY_LS_ADDRESS: session.lsAddress,
      ANTIGRAVITY_CSRF_TOKEN: session.csrfToken,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code != 0) {
    const detail = (stderr || stdout).trim().slice(0, 240);
    throw new Error(detail || `agy agentapi send-message exited with ${code}`);
  }
  try {
    const parsed = JSON.parse(stdout || "{}") as { error?: string };
    if (parsed.error) throw new Error(parsed.error);
  } catch (e) {
    if (e instanceof Error && e.message && !e.message.includes("JSON")) throw e;
  }
}

/** Checks whether a live Antigravity CLI session is still running, idle, or gone via ConversationService. */
export async function checkLiveAntigravityState(session: LiveAntigravitySession): Promise<"running" | "idle" | "gone"> {
  try {
    const res = await fetch(`http://${session.lsAddress}/product.v1.ConversationService/GetConversation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-antigravity-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({ conversationId: session.conversationId }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return "gone";
    const data = (await res.json()) as { state?: { runState?: string } };
    const st = data.state?.runState;
    if (st == "RUN_STATE_RUNNING") return "running";
    if (st == "RUN_STATE_IDLE" || st == "RUN_STATE_CANCELLING") return "idle";
    return "idle";
  } catch {
    return "gone";
  }
}

export const defaultLiveAntigravityMessenger: LiveAntigravityMessenger = {
  send: (session, text, opts) => sendLiveAntigravityMessage(session, text, opts),
  check: (session) => checkLiveAntigravityState(session),
};

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
export function parseTranscriptStep(step: TranscriptStep, opts: { skipToolCalls?: boolean } = {}): DriverEvent[] {
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
    if (!opts.skipToolCalls && Array.isArray(step.tool_calls)) {
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
 * emits DriverEvents for turns completed in the running Antigravity process.
 * Call `setSuppressed(true)` while a standalone ACP turn is running so
 * ACP-streamed events are not emitted twice.
 */
export class AntigravityTranscriptMirror {
  private watcher: FSWatcher | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private seenStep = -1;
  private lastSize = -1;
  private suppressed = false;
  private skipToolCalls = false;
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
    this.poller = setInterval(() => this.scan(), 500);
  }

  /** Skips completed `tool_calls` from transcript steps once live PreToolUse/PostToolUse hooks are streaming them. */
  setSkipToolCalls(on: boolean): void {
    this.skipToolCalls = on;
  }

  setSuppressed(on: boolean): void {
    if (!on && this.suppressed) {
      this.skipExisting();
    }
    this.suppressed = on;
  }

  /** Forces an immediate scan (e.g. triggered by a PostToolUse / PostInvocation / Stop hook). */
  poke(): void {
    this.lastSize = -1;
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
    const steps = this.readSteps(true);
    for (const s of steps) if (typeof s.step_index == "number" && s.step_index > this.seenStep) this.seenStep = s.step_index;
  }

  private readSteps(force = false): TranscriptStep[] {
    if (!existsSync(this.transcriptPath)) return [];
    try {
      const size = statSync(this.transcriptPath).size;
      if (size == 0) return [];
      if (!force && size == this.lastSize) return [];
      this.lastSize = size;
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
    if (!steps.length) return;
    const batch: DriverEvent[] = [];
    for (const s of steps) {
      const idx = typeof s.step_index == "number" ? s.step_index : -1;
      if (idx <= this.seenStep) continue;
      if (s.status != "DONE") continue;
      this.seenStep = idx;
      const parsed = parseTranscriptStep(s, { skipToolCalls: this.skipToolCalls });
      for (const ev of parsed) {
        const prev = batch.at(-1);
        if (ev.t == "text" && prev?.t == "text") {
          batch.push({ t: "text", delta: `\n\n${ev.delta}` });
        } else {
          batch.push(ev);
        }
      }
    }
    if (batch.length) this.onEvents(batch);
  }
}
