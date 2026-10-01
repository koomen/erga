// The embedded agent: a pi coding-agent session (https://github.com/badlogic/pi-mono)
// running in the editor's host, with file tools rooted at the document's folder.
// Its edits land on disk like anyone else's, and the host's watcher carries them
// into the open page as they happen. This module is the Promise edge: pi's SDK is
// async, and open.ts wraps what it exposes in Effect.
//
// Configuration comes from wip/editor/.env (see .env.example; SCRATCHWORK_AGENT_ENV_FILE
// points elsewhere), falling back to the environment:
//   ANTHROPIC_API_KEY          required
//   SCRATCHWORK_AGENT_MODEL    default claude-opus-5-5
//   SCRATCHWORK_AGENT_SPEED    "fast" (default) or "standard"
//   SCRATCHWORK_AGENT_EFFORT   low | medium (default) | high | xhigh | max

import type { Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { emptyLog, reduce, type Log, type LogEvent } from "./src/page/agent-log";

export interface AgentConfig {
  apiKey: string;
  model: string;
  speed: "fast" | "standard";
  effort: string;
}

/** Reads the agent's settings from the given env file, falling back to the process env. */
export async function loadConfig(envPath: string): Promise<AgentConfig | { missing: string }> {
  const file = Bun.file(envPath);
  const env: Record<string, string> = {};
  if (await file.exists()) {
    for (const line of (await file.text()).split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trimStart().startsWith("#")) continue;
      env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  const get = (k: string) => env[k] || process.env[k] || "";
  const apiKey = get("ANTHROPIC_API_KEY");
  if (!apiKey) return { missing: `ANTHROPIC_API_KEY is not set (copy wip/editor/.env.example to wip/editor/.env)` };
  return {
    apiKey,
    model: get("SCRATCHWORK_AGENT_MODEL") || "claude-opus-5-5",
    speed: get("SCRATCHWORK_AGENT_SPEED") == "standard" ? "standard" : "fast",
    effort: get("SCRATCHWORK_AGENT_EFFORT") || "medium",
  };
}

/**
 * pi's built-in catalogue predates Claude Opus 5.5, so the model is described
 * here. Fast mode is the `fast-mode-2026-02-01` beta plus `speed: "fast"` in the
 * request body (added in `patchPayload`); prices are per million tokens.
 */
function describeModel(cfg: AgentConfig): Model<"anthropic-messages"> {
  const fast = cfg.speed == "fast";
  const mult = fast ? 2 : 1;
  return {
    id: cfg.model,
    name: `${cfg.model}${fast ? " (fast)" : ""}`,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 4 * mult, output: 20 * mult, cacheRead: 0.2 * mult, cacheWrite: 5 * mult },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    headers: fast ? { "anthropic-beta": "fast-mode-2026-02-01" } : undefined,
  };
}

/**
 * pi only knows adaptive thinking for the 4.6/4.7 models and would send a
 * budget (or `disabled`), both of which Opus 5.5 rejects. Rewrite the request:
 * adaptive thinking with summaries (so the panel can show them), explicit
 * effort, and fast mode.
 */
function patchPayload(cfg: AgentConfig) {
  return (payload: Record<string, unknown>) => ({
    ...payload,
    max_tokens: 64_000,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { ...(payload.output_config as object | undefined), effort: cfg.effort },
    ...(cfg.speed == "fast" ? { speed: "fast" } : {}),
  });
}

const guidance = (docName: string, kind: "html" | "md") => `
You are embedded in Scratchwork's page editor. The user is looking at ${docName}
(${kind == "md" ? "Markdown" : "HTML"}) rendered as a live page, and editing its text in place. Your
working directory is the folder that holds it; every file in it is part of the page
(styles, scripts, images, other pages), and you may read and change any of them.

- Every edit you make to a file shows up in the user's page as soon as it is written,
  so prefer small, targeted edits (the edit tool) over rewriting whole files.
- The user may be typing at the same time. Always read a file right before editing it
  (with read, not grep: search output cuts long lines and drops indentation, so text
  copied from it won't match), and keep edits scoped to what was asked.
- Messages may begin with an <editor> block saying where the user's caret or selection
  is. "This", "here" and "the selection" refer to it.
- Keep replies short: say what you changed, not how. The user can see the result.
`.trim();

export interface Agent {
  readonly model: string;
  /** The transcript so far (for a shell that just loaded). */
  log(): Log;
  /** Sends a message; while a turn is running it steers the current one. */
  prompt(text: string, context: string | null): void;
  abort(): Promise<void>;
  reset(): Promise<void>;
  subscribe(listener: (ev: LogEvent) => void): () => void;
}

export async function startAgent(opts: { cfg: AgentConfig; cwd: string; docName: string; kind: "html" | "md" }): Promise<Agent> {
  const { cfg, cwd } = opts;
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("anthropic", cfg.apiKey);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory();
  const patch = patchPayload(cfg);
  const model = describeModel(cfg);

  const newSession = async (): Promise<AgentSession> => {
    // Nothing from ~/.pi or the repository leaks in: no extensions, skills,
    // prompt templates or AGENTS.md files; just the editor's own guidance.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      appendSystemPrompt: [guidance(opts.docName, opts.kind)],
      extensionFactories: [(pi) => { pi.on("before_provider_request", (ev) => patch(ev.payload as Record<string, unknown>)); }],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model,
      thinkingLevel: "medium",
      tools: ["read", "edit", "write", "ls", "find", "grep"],
      authStorage,
      modelRegistry,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    return session;
  };

  const log = emptyLog();
  const listeners = new Set<(ev: LogEvent) => void>();
  // tool_execution_end carries no args; keep each call's path from its start event.
  const paths = new Map<string, string | null>();
  const emit = (ev: LogEvent) => {
    if (ev.t == "tool") {
      if (ev.status == "running") paths.set(ev.id, ev.path);
      else ev = { ...ev, path: paths.get(ev.id) ?? null };
    }
    reduce(log, ev);
    for (const l of listeners) l(ev);
  };

  const translate = (e: AgentSessionEvent) => {
    switch (e.type) {
      case "message_update": {
        const m = e.assistantMessageEvent;
        if (m.type == "text_delta") emit({ t: "text", delta: m.delta });
        else if (m.type == "thinking_delta") emit({ t: "thinking", delta: m.delta });
        break;
      }
      case "message_end": {
        const msg = e.message as { role?: string; stopReason?: string; errorMessage?: string };
        if (msg.role == "assistant" && msg.stopReason == "error") emit({ t: "error", text: msg.errorMessage || "The request failed." });
        break;
      }
      case "tool_execution_start":
        emit({ t: "tool", id: e.toolCallId, name: e.toolName, path: toolPath(e.args), status: "running" });
        break;
      case "tool_execution_end":
        emit({
          t: "tool", id: e.toolCallId, name: e.toolName, path: null,
          status: e.isError ? "error" : "done",
          detail: e.isError ? resultText(e.result).slice(0, 400) : undefined,
        });
        break;
      case "agent_start": emit({ t: "busy", busy: true }); break;
      case "agent_end": emit({ t: "busy", busy: false }); break;
    }
  };

  let session = await newSession();
  let unsubscribe = session.subscribe(translate);

  const run = (text: string) => {
    const p = session.isStreaming ? session.steer(text) : session.prompt(text);
    p.catch((err: unknown) => {
      emit({ t: "error", text: err instanceof Error ? err.message : String(err) });
      emit({ t: "busy", busy: false });
    });
  };

  return {
    model: model.name,
    log: () => log,
    prompt(text, context) {
      emit({ t: "user", text });
      run(context ? `<editor>\n${context}\n</editor>\n\n${text}` : text);
    },
    abort: () => session.abort(),
    async reset() {
      await session.abort();
      unsubscribe();
      session.dispose();
      paths.clear();
      session = await newSession();
      unsubscribe = session.subscribe(translate);
      emit({ t: "reset" });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function toolPath(args: unknown): string | null {
  const a = args as { path?: unknown } | null;
  return typeof a?.path == "string" ? a.path : null;
}

function resultText(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] } | null;
  return (r?.content ?? []).map((c) => c.text ?? "").join("\n").trim();
}
