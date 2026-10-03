// Starts the local host (open.ts) for a test: on a port of its own, with a
// scratch data directory, so test documents never land in ~/.erga. Given a
// file or folder, it opens that as a document and `base` is the document's
// address (the host prints it); without one, `base` is the app's root.

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = new URL("../", import.meta.url).pathname;

export interface Host {
  /** The document's address (http://127.0.0.1:<port>/<owner>/<id>), or the app's root without one. */
  base: string;
  port: number;
  /** The host's data directory. */
  data: string;
  /** What it has printed lately. */
  output(): string;
  /** Stops it (SIGTERM lets the rooms write what's unsaved; SIGKILL doesn't). */
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  /** Starts it again, on the same port and data. */
  start(): Promise<void>;
  /** Stops it and removes its data directory. */
  dispose(): Promise<void>;
}

export async function startHost(target: string | null, opts: { port?: number; env?: Record<string, string>; data?: string } = {}): Promise<Host> {
  const port = opts.port ?? 20000 + Math.floor(Math.random() * 20000);
  const data = opts.data ?? mkdtempSync(join(tmpdir(), "erga-data-"));
  const env = { ...process.env as Record<string, string>, ERGA_DATA_DIR: data, ...opts.env };
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let output = "";
  const host: Host = {
    base: `http://127.0.0.1:${port}`,
    port, data,
    output: () => output,
    async start() {
      const p = proc = Bun.spawn(["bun", join(ROOT, "open.ts"), ...(target ? [target] : []), "--port", String(port), "--no-open"], { env, stdout: "pipe", stderr: "pipe" });
      for (const s of [p.stdout, p.stderr] as ReadableStream<Uint8Array>[]) (async () => { for await (const c of s) output = (output + new TextDecoder().decode(c)).slice(-20000); })();
      // Usually ~200ms; the margin is for a machine busy running everything else at once.
      for (let i = 0; i < 600; i++) {
        if (p.exitCode != null) break;
        const at = target ? new RegExp(`http://127\\.0\\.0\\.1:${port}/[a-z0-9-]+/[a-z0-9-]+`).exec(output)?.[0] : `http://127.0.0.1:${port}`;
        try { if (at && (await fetch(target ? `${at}/api/doc` : at)).ok) { host.base = at; return; } } catch { /* not up yet */ }
        await Bun.sleep(25);
      }
      throw new Error(`host didn't start:\n${output}`);
    },
    async stop(signal = "SIGTERM") {
      const p = proc;
      if (!p) return;
      p.kill(signal);
      await p.exited;
      proc = null;
    },
    async dispose() {
      await host.stop();
      if (!opts.data) rmSync(data, { recursive: true, force: true });
    },
  };
  await host.start();
  return host;
}
