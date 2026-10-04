// The agent's key in local development (cloudflare.config.ts): a real one in
// .dev.vars, else ANTHROPIC_API_KEY from the environment that runs the dev
// server (bun start, a task's preview, live mode). A placeholder (empty, too
// short, not "sk-…") counts as none. The key reaches the Worker as a binding,
// never written anywhere, and nothing here prints it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Whether `key` looks like a real Anthropic key rather than a placeholder. */
export const isRealKey = (key: string | undefined): key is string => !!key && /^sk-\S{10,}$/.test(key.trim());

/** ANTHROPIC_API_KEY as .dev.vars (in `envDir`) has it, quotes and all stripped; undefined without one. */
export function devVarsKey(envDir: string): string | undefined {
  const file = join(envDir, ".dev.vars");
  if (!existsSync(file)) return undefined;
  const value = /^\s*ANTHROPIC_API_KEY\s*=\s*(.*)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim();
  return value?.replace(/^(["'])(.*)\1$/, "$2");
}

/** The key the local Worker gets: .dev.vars' if real, else the environment's if real, else "". */
export function localAgentKey(envDir: string, env: Record<string, string | undefined> = process.env): string {
  const fromFile = devVarsKey(envDir);
  if (isRealKey(fromFile)) return fromFile.trim();
  if (isRealKey(env.ANTHROPIC_API_KEY)) return env.ANTHROPIC_API_KEY.trim();
  return "";
}
