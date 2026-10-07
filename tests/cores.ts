// How many test files (or scenarios, or browsers) to run at once: one answer for test.sh, tests/page.ts and
// tests/cdp.ts's pool, from the cores this machine really has for us.
//
// In a container, os.availableParallelism() and nproc can report the host's cores, not the container's share:
// the cgroup's CPU quota (v2 cpu.max, v1 cpu.cfs_quota_us / cpu.cfs_period_us) says what it may use. The smallest
// wins. Memory caps it too: each test file runs a dev server and a Chrome (about TEST_MEM_PER_JOB_MB, 1024 MB).
//
//   TEST_JOBS=n            exactly n at once (a factory task's VM sets 2: Claude Code and the preview share it)
//   TEST_CORES_PER_JOB=c   one at once for every c usable cores (default 2)
//   TEST_MEM_PER_JOB_MB=m  one at once for every m MB of memory (default 1024)
//
//   bun tests/cores.ts     prints "<jobs> <cores> <why>", for test.sh

import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";

const read = (path: string) => { try { return readFileSync(path, "utf8").trim(); } catch { return null; } };

/** The cores the cgroup's quota allows (rounded up, at least 1), or null with no quota. `root`: the cgroup folder. */
export function cgroupCores(root = "/sys/fs/cgroup"): { cores: number; from: string } | null {
  // v2: "max 100000" (no limit) or "<quota> <period>".
  const v2 = read(join(root, "cpu.max"))?.split(/\s+/);
  if (v2 && v2[0] != "max" && Number(v2[0]) > 0 && Number(v2[1]) > 0) return { cores: Math.max(1, Math.ceil(Number(v2[0]) / Number(v2[1]))), from: "cgroup v2 cpu.max" };
  // v1: a quota of -1 is no limit.
  for (const dir of [join(root, "cpu"), join(root, "cpu,cpuacct"), root]) {
    const quota = Number(read(join(dir, "cpu.cfs_quota_us"))), period = Number(read(join(dir, "cpu.cfs_period_us")));
    if (quota > 0 && period > 0) return { cores: Math.max(1, Math.ceil(quota / period)), from: "cgroup v1 cfs quota" };
  }
  return null;
}

/** The memory the cgroup allows, in bytes, or null with no limit. */
export function cgroupMemory(root = "/sys/fs/cgroup"): number | null {
  for (const file of ["memory.max", "memory/memory.limit_in_bytes", "memory.limit_in_bytes"]) {
    const v = Number(read(join(root, file)));
    // v1 says "no limit" with a huge number.
    if (v > 0 && v < 2 ** 60) return v;
  }
  return null;
}

export interface Plan { jobs: number; cores: number; why: string }

/** How many at once, and why. Everything it reads can be given, for tests. */
export function testJobs(opts: { env?: Record<string, string | undefined>; root?: string; reported?: number; memory?: number } = {}): Plan {
  const env = opts.env ?? process.env;
  const reported = opts.reported ?? availableParallelism();
  const quota = cgroupCores(opts.root);
  const cores = quota && quota.cores < reported ? quota.cores : reported;
  const coresWhy = quota && quota.cores < reported ? `${cores} cores (${quota.from}; the OS reports ${reported})` : `${cores} cores`;
  if (Number(env.TEST_JOBS) >= 1) return { jobs: Math.floor(Number(env.TEST_JOBS)), cores, why: `${coresWhy}; TEST_JOBS=${env.TEST_JOBS}` };
  const perJob = Number(env.TEST_CORES_PER_JOB) > 0 ? Number(env.TEST_CORES_PER_JOB) : 2;
  const byCores = Math.max(1, Math.floor(cores / perJob));
  const memory = Math.min(opts.memory ?? totalmem(), cgroupMemory(opts.root) ?? Infinity);
  const memPerJob = (Number(env.TEST_MEM_PER_JOB_MB) > 0 ? Number(env.TEST_MEM_PER_JOB_MB) : 1024) * 2 ** 20;
  const byMemory = Math.max(1, Math.floor(memory / memPerJob));
  const jobs = Math.min(byCores, byMemory);
  const why = `${coresWhy}, ${perJob} a job${env.TEST_CORES_PER_JOB ? " (TEST_CORES_PER_JOB)" : ""}` +
    (byMemory < byCores ? `; capped by ${Math.round(memory / 2 ** 30)} GB of memory, ${memPerJob / 2 ** 20} MB a job` : "");
  return { jobs, cores, why };
}

if (import.meta.main) {
  const p = testJobs();
  console.log(`${p.jobs} ${p.cores} ${p.why}`);
}
