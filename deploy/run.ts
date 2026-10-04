#!/usr/bin/env bun
// A deploy of one of Erga's own targets from this machine: the same pipeline
// the servers run on themselves (deploy/cloudflare.ts, runPipeline), with a
// build made here instead of in the builder's container. For the first
// deploy of a target (deploy/setup.ts runs it, with the target's secrets),
// and as a way round a server that can't deploy itself.
//
//   bun deploy/run.ts staging [--commit <sha>] [--yes]
//   bun deploy/run.ts production --commit <sha>          (asks you to type "production")
//
// It needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the
// environment (a token for the account, as deploy/setup.ts describes), and
// SNAPSHOT_TOKEN for staging (production's, to copy its documents). It
// builds the commit (default: HEAD, which must be committed) in a scratch
// worktree, shows what it will do, and asks before doing it.
//
// ERGA_DEPLOY_MOCK=1: against the mock Cloudflare's copy of Erga's account
// (deploy/mock.ts), with .site/release/ for the build: nothing real is touched.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetOf } from "./branches";
import { buildIn } from "./builder/build";
import { unpackRelease } from "./bundle";
import { ALL_STEPS, Cloudflare, guardTarget, loadRelease, runPipeline, stepsFor, targetHost, type Fetch, type Release, type Target } from "./cloudflare";
import { FLEET_ACCOUNT, MOCK_SNAPSHOT_TOKEN, mockCloudflare } from "./mock";
import { isTargetName, TARGETS, type TargetName } from "./targets";

const ROOT = new URL("..", import.meta.url).pathname;
const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: ROOT }).stdout.toString().trim();

export interface MachineDeploy {
  name: TargetName;
  /** The commit to build (default HEAD). */
  commit?: string;
  /** Secrets to set with this upload (the first deploy's: deploy/setup.ts). */
  secrets?: Record<string, string>;
  /** Don't ask. */
  yes?: boolean;
  /** The Cloudflare API and the servers (the mock's, under ERGA_DEPLOY_MOCK). */
  net?: Fetch;
  token?: string;
  accountId?: string;
  snapshotToken?: string;
  log?: (line: string) => void;
}

/** Whether the person says yes (always, with `yes`). */
export function ask(question: string, yes = false): boolean {
  if (yes) { console.log(`${question} yes (--yes)`); return true; }
  const answer = prompt(`${question} [y/N]`);
  return /^y(es)?$/i.test(answer?.trim() ?? "");
}

/** Builds `commit` here, in a scratch worktree: the release. Under the mock, the checkout's own .site/release/, stamped. */
export async function buildHere(commit: string, log: (line: string) => void, mock = false): Promise<Release> {
  if (mock) {
    const dir = join(ROOT, ".site/release");
    if (!existsSync(join(dir, "release.json"))) throw new Error("no .site/release/: run ./site.sh and bun deploy/release.ts first");
    const r = await loadRelease(async (p) => (existsSync(join(dir, p)) ? new Uint8Array(readFileSync(join(dir, p))) : null));
    log(`build: (mock) .site/release/ as ${commit.slice(0, 12)}`);
    return { ...r!, version: commit.slice(0, 12) };
  }
  const dir = mkdtempSync(join(tmpdir(), "erga-build-"));
  rmSync(dir, { recursive: true, force: true });
  const add = Bun.spawnSync(["git", "worktree", "add", "--detach", dir, commit], { cwd: ROOT });
  if (add.exitCode != 0) throw new Error(`git worktree add failed: ${add.stderr.toString()}`);
  try {
    const bytes = await buildIn({ dir, commit, log: (l) => log(`build: ${l}`) });
    return unpackRelease(bytes, commit.slice(0, 12));
  } finally {
    Bun.spawnSync(["git", "worktree", "remove", "--force", dir], { cwd: ROOT });
  }
}

/** Deploys one target from here, after showing what it will do and asking. False if the person said no. */
export async function deployFromMachine(o: MachineDeploy): Promise<boolean> {
  const log = o.log ?? console.log;
  const mock = process.env.ERGA_DEPLOY_MOCK == "1";
  const accountId = o.accountId ?? (mock ? FLEET_ACCOUNT : process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "");
  const token = o.token ?? (mock ? "mock-machine-token" : process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "");
  const snapshotToken = o.snapshotToken ?? o.secrets?.SNAPSHOT_TOKEN ?? (mock ? MOCK_SNAPSHOT_TOKEN : process.env.SNAPSHOT_TOKEN?.trim() ?? "");
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error("Set CLOUDFLARE_ACCOUNT_ID (the account's id: 32 hex digits).");
  if (!token) throw new Error("Set CLOUDFLARE_API_TOKEN (a token for the account: see deploy/setup.ts).");
  const commit = o.commit ?? git("rev-parse", "HEAD");
  if (!o.commit && !mock && git("status", "--porcelain")) throw new Error("The checkout has changes that aren't committed: commit them, or name a commit (--commit).");
  const spec = TARGETS[o.name];
  const target: Target = { ...targetOf(spec, { CLOUDFLARE_ACCOUNT_ID: accountId, SNAPSHOT_TOKEN: snapshotToken }), secrets: o.secrets ?? {} };
  const wrong = guardTarget(target);
  if (wrong) throw new Error(wrong);
  if (target.snapshot && target.snapshot.token.length < 32) throw new Error("Staging copies production's documents: set SNAPSHOT_TOKEN (production's).");

  log(`Deploy ${commit.slice(0, 12)} to ${o.name}${mock ? " (the mock Cloudflare: nothing real)" : ""}:`);
  log(`  account ${accountId}, Worker ${spec.worker}, database ${spec.database}${spec.snapshotFrom ? " (deleted and made afresh from production's)" : ""}`);
  log(`  https://${targetHost(target)}, documents' pages on *.${spec.pages.domain}`);
  log(`  steps: build, ${stepsFor(target).map((s) => s.id).join(", ")}`);
  if (Object.keys(target.secrets).length) log(`  secrets set: ${Object.keys(target.secrets).join(", ")}`);
  if (o.name == "production") {
    if (!o.yes) {
      const typed = prompt('This deploys erga.dev. Type "production" to go on:');
      if (typed?.trim() != "production") { log("Not deployed."); return false; }
    }
  } else if (!ask("Go on?", o.yes)) { log("Not deployed."); return false; }

  const release = await buildHere(commit, log, mock);
  const net = o.net ?? (mock ? mockCloudflare({ fleet: true }).fetch : globalThis.fetch.bind(globalThis));
  await runPipeline(new Cloudflare(token, net), release, target, {
    site: net,
    report: (id, status, detail) => log(`${ALL_STEPS.find((s) => s.id == id)?.title}${status == "running" ? "…" : `: ${status}${detail ? `, ${detail}` : ""}`}`),
    ...(mock ? { sleep: async () => {}, waitMs: 2000 } : {}),
  });
  log(`Deployed ${commit.slice(0, 12)} to https://${targetHost(target)}.`);
  return true;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const name = args[0] ?? "";
  const at = args.indexOf("--commit");
  if (!isTargetName(name)) { console.error("usage: bun deploy/run.ts <staging|production> [--commit <sha>] [--yes]"); process.exit(2); }
  try {
    const done = await deployFromMachine({ name, commit: at >= 0 ? git("rev-parse", args[at + 1]) : undefined, yes: args.includes("--yes") && name != "production" });
    process.exit(done ? 0 : 1);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
