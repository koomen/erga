// Building one commit of Erga into a release, the same way on any machine:
// in the builder's container (deploy/builder/server.ts) and on a developer's
// machine (deploy/run.ts). A Worker can't run `bun install` or Vite, so this
// is the one part of a deploy that runs outside the Worker.
//
//   1. fetch the commit from the source repo (a Git remote and a read token: deploy/source.ts)
//   2. bun install --frozen-lockfile
//   3. ./site.sh                        (the editor's files, into .site/)
//   4. bun deploy/release.ts            (cf build: the Worker and its config, into .site/release/)
//   5. pack .site/release/ as one bundle (deploy/bundle.ts reads it)
//
// Self-contained (no imports from the rest of the repo), so the container
// image needs only this file and server.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";

export interface Source { cloneUrl: string; token?: string }
export type Log = (line: string) => void;
/** Runs a command in `cwd`, each line it prints to `log`; throws if it fails. */
export type Runner = (cmd: string[], o: { cwd: string; env?: Record<string, string>; log: Log; secret?: string; signal?: AbortSignal }) => Promise<void>;

/** Builds `commit` from `source` in `dir` (emptied first): the release bundle's bytes. */
export async function buildCommit(o: { source: Source; commit: string; branch?: string; dir: string; log: Log; run?: Runner; signal?: AbortSignal }): Promise<Uint8Array> {
  const signal = o.signal;
  const base = o.run ?? spawnRunner;
  // Cancelled (signal): the command running is killed, and no other starts.
  const run: Runner = (cmd, x) => { signal?.throwIfAborted(); return base(cmd, { ...x, signal }); };
  if (!/^[0-9a-f]{7,40}$/.test(o.commit)) throw new Error(`Not a commit: ${o.commit}`);
  rmSync(o.dir, { recursive: true, force: true });
  mkdirSync(o.dir, { recursive: true });
  const auth = o.source.token ? ["-c", `http.extraHeader=Authorization: Basic ${btoa(`x:${o.source.token}`)}`] : [];
  const env = { GIT_TERMINAL_PROMPT: "0" };
  o.log(`fetching ${o.commit.slice(0, 12)} from ${o.source.cloneUrl}`);
  await run(["git", "init", "-q"], { cwd: o.dir, env, log: o.log });
  // The branch, then the commit on it (servers don't all let a commit be fetched by its id).
  await run(["git", ...auth, "fetch", "-q", "--no-tags", o.source.cloneUrl, o.branch ? `+refs/heads/${o.branch}:refs/remotes/origin/${o.branch}` : o.commit], { cwd: o.dir, env, log: o.log, secret: o.source.token });
  await run(["git", "-c", "advice.detachedHead=false", "checkout", "-q", o.commit], { cwd: o.dir, env, log: o.log });
  return buildIn({ dir: o.dir, commit: o.commit, log: o.log, run });
}

/** Steps 2 to 5 in a checkout of `commit` at `dir`: the release bundle's bytes. */
export async function buildIn(o: { dir: string; commit: string; log: Log; run?: Runner; nodeModules?: string }): Promise<Uint8Array> {
  const run = o.run ?? spawnRunner;
  // On a developer's machine, its checkout's packages (deploy/run.ts); in the container, installed from the lockfile.
  if (o.nodeModules) { symlinkSync(o.nodeModules, join(o.dir, "node_modules"), "dir"); o.log(`node_modules: ${o.nodeModules}`); }
  else await run(["bun", "install", "--frozen-lockfile"], { cwd: o.dir, log: o.log });
  // Erga's own servers serve its source (the Artifacts binding, cloudflare.config.ts): the namespace the commit's
  // own deploy/targets.json names, so a branch deploy keeps the Git endpoint the factory and pushes go through.
  const artifacts = artifactsNamespace(o.dir);
  const ns: Record<string, string> = artifacts ? { ERGA_ARTIFACTS_NAMESPACE: artifacts } : {};
  if (artifacts) o.log(`source: the Artifacts namespace ${artifacts} (deploy/targets.json)`);
  // WORKERS_CI empty: a commit from before task #3 ran migrate.ts in site.sh when it was set (on Workers Builds).
  await run(["./site.sh"], { cwd: o.dir, log: o.log, env: { WORKERS_CI: "", ...ns } });
  await run(["bun", "deploy/release.ts"], { cwd: o.dir, log: o.log, env: { WORKERS_CI_COMMIT_SHA: o.commit, ...ns } });
  const bundle = packRelease(join(o.dir, ".site/release"));
  o.log(`built ${o.commit.slice(0, 12)}: ${bundle.byteLength} bytes`);
  return bundle;
}

/** The Artifacts namespace a checkout's deploy/targets.json names (source.namespace), or null. */
export function artifactsNamespace(dir: string): string | null {
  try {
    const ns = JSON.parse(readFileSync(join(dir, "deploy/targets.json"), "utf8"))?.source?.namespace;
    return typeof ns == "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(ns) ? ns : null;
  } catch { return null; }
}

/** The release in `dir` (release.json and what it names) as a bundle's bytes: {index, files: {path: base64}}. */
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
  for (const sub of ["bundle", "assets", "migrations"]) walk(join(dir, sub));
  return new TextEncoder().encode(JSON.stringify({ index, files }));
}

/** Bun.spawn, with every line it prints logged (a secret in it replaced by ***). */
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
  const emit = (line: string) => {
    const clean = o.secret ? line.split(o.secret).join("***") : line;
    if (!clean.trim()) return;
    tail.push(clean);
    if (tail.length > 20) tail.shift();
    o.log(clean);
  };
  await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
  const code = await proc.exited;
  o.signal?.removeEventListener("abort", kill);
  o.signal?.throwIfAborted();
  if (code != 0) throw new Error(`${cmd.join(" ")} failed (exit ${code})${tail.length ? `:\n${tail.slice(-8).join("\n")}` : ""}`);
};
