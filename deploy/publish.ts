#!/usr/bin/env bun
// Puts a commit from this machine into Erga's source (the Artifacts repo,
// task #39), and tells the servers, so erga.dev and staging.erga.dev deploy
// it themselves. The task queue runs this after each merge (and when
// origin/main moves): main on GitHub and main in Erga's source stay the same.
//
//   bun deploy/publish.ts fetch            Erga's staging and main into refs/remotes/erga/ (prints the refs to merge)
//   bun deploy/publish.ts push [<rev>]     <rev> (default origin/main) to staging, then main, and tell the servers
//
// The branch model holds (README, Erga's own source): staging first, then
// main, each only forward (a plain push, never forced: Artifacts refuses a
// move that isn't a fast-forward). If Erga's staging has commits <rev>
// doesn't, nothing moves and it says so: merge erga/staging first (the task
// queue merges it into each task's branch). If Erga is ahead of <rev> already
// (a merge on /source, a factory task), there's nothing to do.
//
// The credential is this machine's (deploy/credential.ts: the cf CLI's login,
// or CLOUDFLARE_API_TOKEN), for a 15-minute write token for the one repo,
// never printed. Telling the servers takes the servers' shared
// DEPLOY_HOOK_SECRET: ERGA_DEPLOY_HOOK_SECRET, else the file
// ~/.config/erga/deploy-hook-secret (deploy/setup.ts --hook-secret makes a
// new one, sets it on both Workers and writes that file). Each server then
// deploys its own branch's head as its repository has it (deploy/branches.ts).
//
// Exit codes: 0 done (or nothing to do), 1 failed, 2 refused (staging has
// commits <rev> doesn't), 3 pushed but a server wasn't told.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Cloudflare } from "./cloudflare";
import { machineCredential } from "./credential";
import { SOURCE, TARGETS, type TargetName } from "./targets";

const ROOT = new URL("..", import.meta.url).pathname;
const ACCOUNT = "c24e663b6f522eb02c60b6ce88ec4493";

/** Where this machine keeps the servers' DEPLOY_HOOK_SECRET (mode 600). */
export const hookSecretFile = () => process.env.ERGA_DEPLOY_HOOK_SECRET_FILE ?? join(homedir(), ".config/erga/deploy-hook-secret");

export function readHookSecret(): string {
  const env = process.env.ERGA_DEPLOY_HOOK_SECRET?.trim();
  if (env) return env;
  try { return readFileSync(hookSecretFile(), "utf8").trim(); } catch { return ""; }
}

export function saveHookSecret(secret: string) {
  const file = hookSecretFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, secret + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** A Git remote and how to sign in to it: a URL, and maybe an Authorization header (never printed). */
export interface Remote { url: string; authorization?: string }

/** Erga's source repo, with a 15-minute write token made with this machine's credential. */
export async function ergaRemote(): Promise<Remote> {
  const cred = machineCredential();
  if (!cred) throw new Error("No Cloudflare credential on this machine: log in with `bunx cf auth login`, or set CLOUDFLARE_API_TOKEN.");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || ACCOUNT;
  const cf = new Cloudflare(cred.token);
  const base = `/accounts/${accountId}/artifacts/namespaces/${encodeURIComponent(SOURCE.namespace)}`;
  const repo = await cf.call<{ remote?: string }>("GET", `${base}/repos/${encodeURIComponent(SOURCE.repo)}`, `find Erga's source repo (${SOURCE.namespace}/${SOURCE.repo})`);
  if (!repo?.remote) throw new Error("Artifacts didn't say where Erga's source repo is.");
  const t = await cf.call<{ token?: string; plaintext?: string }>("POST", `${base}/tokens`, "make a write token for Erga's source repo", { repo: SOURCE.repo, scope: "write", ttl: 900 });
  const token = t?.token ?? t?.plaintext;
  if (!token) throw new Error("Artifacts didn't give a write token for Erga's source repo.");
  return { url: repo.remote, authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` };
}

export interface Deps {
  /** The checkout to push from. */
  cwd: string;
  remote: () => Promise<Remote>;
  /** Tells a server its branch moved: whether it took it, and what it said. */
  tell: (target: TargetName, body: { branch: string; commit: string; trigger: string }) => Promise<{ ok: boolean; said: string }>;
  log: (line: string) => void;
}

/** Runs git in the checkout, signed in to the remote through the environment (so the token is in no command line). */
function git(d: Deps, remote: Remote | null, ...args: string[]) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, GIT_TERMINAL_PROMPT: "0" };
  if (remote?.authorization) Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${remote.authorization}` });
  const p = Bun.spawnSync(["git", ...args], { cwd: d.cwd, env, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode == 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

const isAncestor = (d: Deps, a: string, b: string) => git(d, null, "merge-base", "--is-ancestor", a, b).ok;

/** Erga's staging and main into refs/remotes/erga/: the refs there (for the task queue to merge). */
export async function fetchErga(d: Deps): Promise<string[]> {
  const remote = await d.remote();
  const r = git(d, remote, "fetch", "-q", "--no-tags", remote.url, "+refs/heads/staging:refs/remotes/erga/staging", "+refs/heads/main:refs/remotes/erga/main");
  if (!r.ok) throw new Error(`Couldn't fetch Erga's source: ${r.err}`);
  return ["erga/staging"];
}

export type PushResult = { state: "pushed" | "up-to-date" | "behind" | "diverged" | "untold"; commit: string; said: string[] };

/** <rev> to Erga's staging, then main, each only forward; then tells each server whose branch moved. */
export async function pushToErga(d: Deps, rev: string, trigger = "push from the task queue"): Promise<PushResult> {
  const commit = git(d, null, "rev-parse", "--verify", `${rev}^{commit}`).out;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Not a commit here: ${rev}`);
  const remote = await d.remote();
  const r = git(d, remote, "fetch", "-q", "--no-tags", remote.url, "+refs/heads/staging:refs/remotes/erga/staging", "+refs/heads/main:refs/remotes/erga/main");
  if (!r.ok) throw new Error(`Couldn't fetch Erga's source: ${r.err}`);
  const staging = git(d, null, "rev-parse", "-q", "--verify", "refs/remotes/erga/staging").out;
  const main = git(d, null, "rev-parse", "-q", "--verify", "refs/remotes/erga/main").out;
  const short = commit.slice(0, 12);
  const said: string[] = [];
  const moves: { branch: "staging" | "main"; from: string }[] = [];
  if (staging != commit) {
    if (staging && isAncestor(d, commit, staging)) said.push(`Erga's staging has ${short} already (it's ahead).`);
    else if (staging && !isAncestor(d, staging, commit)) return { state: "diverged", commit, said: [`Erga's staging has commits ${rev} doesn't (at ${staging.slice(0, 12)}): merge erga/staging into it first. Nothing moved.`] };
    else moves.push({ branch: "staging", from: staging });
  }
  if (main != commit) {
    if (main && isAncestor(d, commit, main)) said.push(`Erga's main has ${short} already (it's ahead).`);
    else if (main && !isAncestor(d, main, commit)) return { state: "diverged", commit, said: [`Erga's main has commits ${rev} doesn't (at ${main.slice(0, 12)}). Nothing moved.`] };
    else moves.push({ branch: "main", from: main });
  }
  if (!moves.length) {
    const ahead = said.length > 0;
    return { state: ahead ? "behind" : "up-to-date", commit, said: ahead ? said : [`Erga's staging and main are at ${short} already.`] };
  }
  // Staging first: main may only be one of staging's commits.
  for (const m of moves) {
    const p = git(d, remote, "push", "-q", remote.url, `${commit}:refs/heads/${m.branch}`);
    if (!p.ok) throw new Error(`Erga's source refused ${short} on ${m.branch}: ${p.err}`);
    d.log(`Erga's ${m.branch}: ${m.from ? m.from.slice(0, 12) : "(none)"} -> ${short}.`);
  }
  let untold = false;
  for (const m of moves) {
    const target = m.branch == "main" ? "production" : "staging";
    const t = await d.tell(target, { branch: m.branch, commit, trigger }).catch((e) => ({ ok: false, said: (e as Error).message }));
    if (!t.ok) untold = true;
    said.push(t.ok ? `${TARGETS[target].host} deploys ${short}.` : `${TARGETS[target].host} wasn't told: ${t.said}`);
  }
  return { state: untold ? "untold" : "pushed", commit, said };
}

/** POST /api/deploys/<target>/hook on that target's server, with the shared secret. */
export function hookTeller(secret = readHookSecret(), net: typeof fetch = fetch): Deps["tell"] {
  return async (target, body) => {
    if (secret.length < 16) return { ok: false, said: `no DEPLOY_HOOK_SECRET on this machine (ERGA_DEPLOY_HOOK_SECRET, or ${hookSecretFile()}: bun deploy/setup.ts --hook-secret makes one)` };
    const r = await net(`https://${TARGETS[target].host}/api/deploys/${target}/hook`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const answer = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return { ok: r.ok && answer.ok !== false, said: answer.error ?? `it answered ${r.status}` };
  };
}

if (import.meta.main) {
  const [cmd, rev = "origin/main"] = process.argv.slice(2);
  const deps: Deps = { cwd: process.cwd(), remote: ergaRemote, tell: hookTeller(), log: (l) => console.log(l) };
  if (!git(deps, null, "rev-parse", "--git-dir").ok) deps.cwd = ROOT;
  try {
    if (cmd == "fetch") { for (const ref of await fetchErga(deps)) console.log(ref); process.exit(0); }
    if (cmd == "push") {
      const r = await pushToErga(deps, rev);
      for (const l of r.said) console.log(l);
      process.exit(r.state == "diverged" ? 2 : r.state == "untold" ? 3 : 0);
    }
    console.error("usage: bun deploy/publish.ts fetch | push [<rev>]");
    process.exit(64);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
