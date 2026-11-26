// What every driver of an agent subprocess shares (the ACP driver and the
// Claude Code driver): the process speaks JSON lines on stdin and stdout, its
// stderr goes to the log, and its events go to the driver's listeners.

import type { Subprocess } from "bun";
import type { DriverEvent, LocalAttachment } from "../core/driver.ts";

export type AgentProcess = Subprocess<"pipe", "pipe", "pipe">;

/** Starts an agent's subprocess with piped stdin, stdout and stderr. */
export function spawnAgent(command: readonly string[], cwd: string, env?: Record<string, string | undefined>): AgentProcess {
  return Bun.spawn([...command], { cwd, ...(env ? { env } : {}), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

/** A text attachment as the text an agent reads. */
export function attachmentNote(att: LocalAttachment): string {
  return att.path ? `Attached file ${att.name} (saved at ${att.path}):\n${att.data}` : `Attached file ${att.name}:\n${att.data}`;
}

/** The listeners of one agent conversation's events. */
export class DriverEvents {
  private listeners = new Set<(ev: DriverEvent) => void>();

  onEvent(listener: (ev: DriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(ev: DriverEvent): void {
    for (const fn of [...this.listeners]) fn(ev);
  }
}

/** Writes one JSON line to a process's stdin. */
export function writeLine(proc: AgentProcess, msg: object): void {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

/** Reads a process's stdout as JSON lines until it ends, and sends its stderr to the log under `name`. */
export function readLines(
  proc: AgentProcess,
  name: string,
  onMessage: (msg: Record<string, unknown>) => void,
  onEnd: () => void,
  log?: (line: string) => void
): void {
  // Drain stderr for diagnostics without ever touching stdout.
  void (async () => {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = dec.decode(value).trim();
      if (text) log?.(`[${name} stderr] ${text.slice(0, 400)}`);
    }
  })().catch(() => {});

  void (async () => {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        onMessage(msg);
      }
    }
    onEnd();
  })().catch(() => {});
}

/** Ends a process: closes its stdin and kills it. */
export function endProcess(proc: AgentProcess): void {
  try {
    proc.stdin.end();
  } catch {
    /* ignore */
  }
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
}
