// Declarative presets for standalone ACP agents. Adding any ACP agent is a
// 5-line entry here (or pass `--acp "<cmd>"` at the CLI with zero code changes).

import type { AcpDriverConfig } from "./acp.ts";

export interface AgentPreset {
  readonly id: string;
  readonly label: string;
  /** Primary CLI binary on PATH (e.g. "agy", "claude-agent-acp"). */
  readonly bin: string;
  /** Arguments passed to `bin` to speak ACP over stdio. */
  readonly args: readonly string[];
  /** Optional fallback CLI binary that signals the agent is installed even when the npm ACP adapter runs via bunx. */
  readonly detectBin?: string;
  /** Optional npm package run via `bunx <pkg>` when `bin` is not directly on PATH. */
  readonly bunxPackage?: string;
  readonly addDirFlag?: string;
  readonly autoApproveFlag?: string;
  readonly sessionMeta?: AcpDriverConfig["sessionMeta"];
}

export const AGENT_PRESETS: readonly AgentPreset[] = [
  {
    id: "antigravity",
    label: "Antigravity",
    bin: "agy",
    args: ["acp"],
    addDirFlag: "--add-dir",
    autoApproveFlag: "--dangerously-skip-permissions",
    sessionMeta: (opts) => (opts.systemPrompt ? { antigravity: { systemPrompt: opts.systemPrompt } } : undefined),
  },
  {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude-agent-acp",
    args: [],
    detectBin: "claude",
    bunxPackage: "@agentclientprotocol/claude-agent-acp",
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex-acp",
    args: [],
    detectBin: "codex",
    bunxPackage: "@agentclientprotocol/codex-acp",
  },
  {
    id: "pi",
    label: "Pi",
    bin: "pi-acp",
    args: [],
    detectBin: "pi",
    bunxPackage: "pi-acp",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    args: ["--acp"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    args: ["acp"],
  },
];

const ALIASES: Record<string, string> = {
  agy: "antigravity",
  claude: "claude-code",
  "claude-agent": "claude-code",
};

/** Splits a `--acp "<cmd>"` string respecting single and double quotes. */
export function parseCommandString(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch == quote) quote = null;
      else if (ch == "\\" && quote == '"' && i + 1 < raw.length) cur += raw[++i];
      else cur += ch;
    } else if (ch == '"' || ch == "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface DetectedAgent {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly command: string;
  readonly args: readonly string[];
  readonly via: "direct" | "bunx" | "missing";
}

/** Detects installed standalone ACP agents on this machine (purely via PATH lookup). */
export function detectAgents(which: (bin: string) => string | null = (b) => Bun.which(b)): DetectedAgent[] {
  const bunx = which("bunx");
  return AGENT_PRESETS.map((p) => {
    const direct = which(p.bin);
    if (direct) {
      return { id: p.id, label: p.label, available: true, command: direct, args: [...p.args], via: "direct" };
    }
    if (p.bunxPackage && bunx && (!p.detectBin || which(p.detectBin))) {
      return { id: p.id, label: p.label, available: true, command: bunx, args: [p.bunxPackage, ...p.args], via: "bunx" };
    }
    return {
      id: p.id,
      label: p.label,
      available: false,
      command: p.bunxPackage ? "bunx" : p.bin,
      args: p.bunxPackage ? [p.bunxPackage, ...p.args] : [...p.args],
      via: "missing",
    };
  });
}

/** Resolves either a custom `--acp "<cmd>"` or a named/auto-detected preset into an AcpDriverConfig. */
export function resolveAgentPreset(
  opts: { agent?: string; acp?: string; label?: string },
  which: (bin: string) => string | null = (b) => Bun.which(b)
): AcpDriverConfig {
  if (opts.acp) {
    const parts = parseCommandString(opts.acp);
    if (!parts.length) throw new Error("Empty --acp command.");
    const [command, ...args] = parts;
    const base = command.split(/[\\/]/).pop() || "acp";
    return {
      id: base.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase(),
      label: opts.label || base,
      command,
      args,
    };
  }

  const detected = detectAgents(which);
  if (opts.agent) {
    const wanted = ALIASES[opts.agent.toLowerCase()] ?? opts.agent.toLowerCase();
    const preset = AGENT_PRESETS.find((p) => p.id == wanted);
    if (!preset) {
      const names = AGENT_PRESETS.map((p) => p.id).join(", ");
      throw new Error(`Unknown agent "${opts.agent}". Available presets: ${names}, or pass --acp "<command>".`);
    }
    const d = detected.find((x) => x.id == preset.id)!;
    const bunx = which("bunx");
    const command = d.available ? d.command : preset.bunxPackage && bunx ? bunx : preset.bin;
    const args = d.available ? d.args : preset.bunxPackage && bunx ? [preset.bunxPackage, ...preset.args] : [...preset.args];
    return {
      id: preset.id,
      label: opts.label || preset.label,
      command,
      args,
      addDirFlag: preset.addDirFlag,
      autoApproveFlag: preset.autoApproveFlag,
      sessionMeta: preset.sessionMeta,
    };
  }

  const first = detected.find((d) => d.available);
  if (!first) {
    throw new Error(
      `No standalone ACP agent detected on PATH (${AGENT_PRESETS.map((p) => p.id).join(", ")}). Pass --agent <name> or --acp "<command>".`
    );
  }
  const preset = AGENT_PRESETS.find((p) => p.id == first.id)!;
  return {
    id: preset.id,
    label: opts.label || preset.label,
    command: first.command,
    args: first.args,
    addDirFlag: preset.addDirFlag,
    autoApproveFlag: preset.autoApproveFlag,
    sessionMeta: preset.sessionMeta,
  };
}
