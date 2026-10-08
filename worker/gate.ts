// The production gate's server side (deploy/gate.ts has the rules): where
// its shards run, and its routes (in worker/deploys.ts's table).
//
// The gate runs in staging's server (in the Pipeline object, beside the
// branch deploys) and in local development; production's server asks
// staging's for each answer, with DEPLOY_HOOK_SECRET, so the two dashboards
// show the same runs and production's merge checks staging's result. If
// staging's server doesn't answer, production refuses to move main, and says
// why.
//
// On Cloudflare a shard is a FactoryVm (factory/cloudflare.ts) named
// gate-<commit>-<attempt>-<n>: the factory's image, standard-4, its job
// `run.ts gate run ...` (factory/vm/gate.ts), cloning the commit from this
// server's own Git endpoint with a factory git token (REPO_TOKEN): staging
// is for admins only (worker/admins-only.ts), and lets a git read through
// with an fgt.… token. The token is a task's, for GATE_BRANCH, a branch no
// task has (ids start at 1): it reads staging and main, and pushes nothing
// that matters. Locally, and with
// ERGA_DEPLOY_MOCK=1, the fake runner (deploy/gate.ts, fakeRunner) stands in.

import { fakeRunner, type GateRunner, type ShardReport } from "../deploy/gate";
import { isTargetName, TARGETS } from "../deploy/targets";
import { SYSTEM } from "../attribution";
import type { Env } from "./env";

/** Whether this server runs the gate itself: staging's, and any that isn't production (local development). */
export function gateRunsHere(env: Env): boolean {
  if (env.ERGA_DEPLOY_MOCK == "1" || (env.ERGA_LINK_SECRET && env.DEV_LOGIN)) return true;
  return env.DEPLOY_TARGET?.trim() != "production";
}

/** Where the shards run on this server: the factory's VMs, the local fake, or why there's none. */
export function gateRunner(env: Env, subject: (commit: string) => Promise<string | null>): GateRunner | string {
  if (env.ERGA_DEPLOY_MOCK == "1" || (env.ERGA_LINK_SECRET && env.DEV_LOGIN)) {
    return fakeRunner({ delayMs: Number(env.ERGA_GATE_FAKE_MS) || 1500, subject });
  }
  if (!env.FACTORY_VM) return "it has no VMs (the FactoryVm binding: bun deploy/setup.ts --factory).";
  const self = env.DEPLOY_TARGET?.trim() ?? "";
  if (!isTargetName(self)) return "it isn't one of Erga's deploy targets (DEPLOY_TARGET).";
  // Imported when a shard starts: worker/factory.ts needs the Workers runtime, and the tests import this file.
  const token = async () => (await import("./factory")).gitToken(env, "task", GATE_BRANCH, SYSTEM, "the production gate");
  return vmRunner(env.FACTORY_VM, `https://${TARGETS[self].host}/git/erga.git`, token);
}

/** The branch the gate's git token names (factory/git-grant.ts: task/<id>-<slug>); no task has id 0. */
export const GATE_BRANCH = "task/0-gate";

/** The part of FactoryVm the gate uses. */
interface VmStub {
  boot(): Promise<void>;
  job(script: string, args: string[], env: Record<string, string>, wait: boolean): Promise<{ code: number; output: string } | null>;
  alive(): Promise<boolean>;
  stop(): Promise<void>;
}

/** Shards in the factory's VMs (one FactoryVm each), cloning from `repo` with the git token `token` makes. */
export function vmRunner(ns: { getByName(name: string): unknown }, repo: string, token: () => Promise<string>): GateRunner {
  const vm = (name: string) => ns.getByName(name) as VmStub;
  return {
    kind: "Cloudflare Containers (standard-4)",
    async start(spec) {
      const v = vm(spec.vm);
      await v.boot();
      await v.job("run.ts", ["gate", "run", spec.commit, String(spec.shard), String(spec.of), ...(spec.files ? ["--files", spec.files.join(",")] : [])], { REPO_URL: repo, REPO_TOKEN: await token(), FACTORY_WORK: "/work" }, false);
    },
    async poll(name) {
      const v = vm(name);
      if (!(await v.alive())) return "gone";
      const out = await v.job("run.ts", ["gate", "status"], { FACTORY_WORK: "/work" }, true);
      return parseStatus(out?.output ?? "");
    },
    stop: (name) => vm(name).stop(),
  };
}

/** The shard's `gate status` line (factory/vm/gate.ts). */
export function parseStatus(output: string): ShardReport {
  const line = output.split("\n").reverse().find((l) => l.startsWith("GATE-STATUS "));
  if (!line) throw new Error(`the VM said no status: ${output.slice(-300)}`);
  return JSON.parse(line.slice("GATE-STATUS ".length)) as ShardReport;
}
