// Building one checkout of Erga into a release, on the machine that deploys it (buildHere:
// `bun erga deploy`). A Worker can't run `bun install` or Vite, so this is the one part of a deploy
// that runs outside the Cloudflare API.
//
//   1. bun install --frozen-lockfile    (or the checkout's own node_modules, linked)
//   2. bun run build                     (the client's files, into .build/)
//   3. bun run release                   (cf build: the Worker and its config, into .build/release/)
//   4. pack .build/release/ as one bundle (bundle.ts reads it)

import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ROOT } from "../root";
import { unpackRelease } from "./bundle";
import { loadRelease, type Release } from "./release-format";


/** Builds `commit` of this clone in a scratch worktree: the release. Under the mock, the checkout's own .build/release/, stamped. */
export async function buildHere(commit: string, log: Log, mock = false): Promise<Release> {
  if (mock) {
    const dir = join(ROOT, ".build/release");
    if (!existsSync(join(dir, "release.json"))) throw new Error("no .build/release/: run bun run build and bun run release first");
    const r = await loadRelease(async (p) => (existsSync(join(dir, p)) ? new Uint8Array(readFileSync(join(dir, p))) : null));
    log(`build: (mock) .build/release/ as ${commit.slice(0, 12)}`);
    return { ...r!, version: commit.slice(0, 12) };
  }
  const dir = mkdtempSync(join(tmpdir(), "erga-build-"));
  rmSync(dir, { recursive: true, force: true });
  const add = Bun.spawnSync(["git", "worktree", "add", "--detach", dir, commit], { cwd: ROOT });
  if (add.exitCode != 0) throw new Error(`git worktree add failed: ${add.stderr.toString()}`);
  try {
    // This checkout's packages, linked (a commit whose lockfile differs needs `bun install` here first).
    const bytes = await buildIn({ dir, commit, log: (l) => log(`build: ${l}`), nodeModules: existsSync(join(ROOT, "node_modules")) ? join(ROOT, "node_modules") : undefined });
    return unpackRelease(bytes, commit.slice(0, 12));
  } finally {
    Bun.spawnSync(["git", "worktree", "remove", "--force", dir], { cwd: ROOT });
  }
}

export type Log = (line: string) => void;
/** Runs a command in `cwd`, each line it prints to `log`; throws if it fails. */
export type Runner = (cmd: string[], o: { cwd: string; env?: Record<string, string>; log: Log; secret?: string; signal?: AbortSignal }) => Promise<void>;

/** Steps 1 to 4 in a checkout of `commit` at `dir`: the release bundle's bytes. */
export async function buildIn(o: { dir: string; commit: string; log: Log; run?: Runner; nodeModules?: string }): Promise<Uint8Array> {
  const run = o.run ?? spawnRunner;
  if (o.nodeModules) { symlinkSync(o.nodeModules, join(o.dir, "node_modules"), "dir"); o.log(`node_modules: ${o.nodeModules}`); }
  else await run(["bun", "install", "--frozen-lockfile"], { cwd: o.dir, log: o.log });
  // The commit's own package.json says how it builds (bun run build, then bun run release).
  await run(["bun", "run", "build"], { cwd: o.dir, log: o.log });
  await run(["bun", "run", "release"], { cwd: o.dir, log: o.log, env: { WORKERS_CI_COMMIT_SHA: o.commit } });
  const bundle = packRelease(join(o.dir, ".build/release"));
  o.log(`built ${o.commit.slice(0, 12)}: ${bundle.byteLength} bytes`);
  return bundle;
}

/**
 * The release in `dir` (release.json and every folder beside it: bundle/,
 * assets/, migrations/, and whatever a newer commit adds) as a
 * bundle's bytes: {index, files: {path: base64}}.
 */
export function packRelease(dir: string): Uint8Array {
  const index = JSON.parse(readFileSync(join(dir, "release.json"), "utf8"));
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files[relative(dir, full).split("\\").join("/")] = Buffer.from(readFileSync(full)).toString("base64");
    }
  };
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) walk(join(dir, e.name));
  return new TextEncoder().encode(JSON.stringify({ index, files }));
}

/** Bun.spawn, with every line it prints logged (a secret in it, as it is or as HTTP Basic auth's base64, replaced by ***). */
export const spawnRunner: Runner = async (cmd, o) => {
  const proc = Bun.spawn(cmd, { cwd: o.cwd, env: { ...process.env, CI: "1", NO_COLOR: "1", CF_QUIET: "1", ...o.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const kill = () => proc.kill();
  o.signal?.addEventListener("abort", kill, { once: true });
  const tail: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) emit(line);
    }
    if (buf) emit(buf);
  };
  const hide = (s: string) => o.secret ? [o.secret, btoa(`x:${o.secret}`)].reduce((s, x) => s.split(x).join("***"), s) : s;
  const emit = (line: string) => {
    const clean = hide(line);
    if (!clean.trim()) return;
    tail.push(clean);
    if (tail.length > 20) tail.shift();
    o.log(clean);
  };
  await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
  const code = await proc.exited;
  o.signal?.removeEventListener("abort", kill);
  o.signal?.throwIfAborted();
  if (code != 0) throw new Error(`${hide(cmd.join(" "))} failed (exit ${code})${tail.length ? `:\n${tail.slice(-8).join("\n")}` : ""}`);
};
