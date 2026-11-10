// e2e/helpers/cores.ts: how many tests at once, from fake cgroup files.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cgroupCores, testJobs, timeFactor } from "../e2e/helpers/cores";

const GB = 2 ** 30;
function cgroup(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "erga-cgroup-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text + "\n");
  }
  return root;
}

test("cgroup v2: a quota of 4 cores on a 64-core host gives 4 cores, 2 jobs", () => {
  const root = cgroup({ "cpu.max": "400000 100000" });
  expect(cgroupCores(root)).toEqual({ cores: 4, from: "cgroup v2 cpu.max" });
  const p = testJobs({ env: {}, root, reported: 64, memory: 64 * GB });
  expect(p).toMatchObject({ jobs: 2, cores: 4 });
  expect(p.why).toContain("the OS reports 64");
});

test("cgroup v2 with no limit, and no cgroup at all: the reported cores", () => {
  expect(cgroupCores(cgroup({ "cpu.max": "max 100000" }))).toBeNull();
  expect(testJobs({ env: {}, root: "/nonexistent", reported: 10, memory: 64 * GB })).toMatchObject({ jobs: 5, cores: 10 });
});

test("cgroup v1: a fractional quota rounds up; -1 is no limit", () => {
  expect(cgroupCores(cgroup({ "cpu/cpu.cfs_quota_us": "250000", "cpu/cpu.cfs_period_us": "100000" }))).toEqual({ cores: 3, from: "cgroup v1 cfs quota" });
  expect(cgroupCores(cgroup({ "cpu/cpu.cfs_quota_us": "-1", "cpu/cpu.cfs_period_us": "100000" }))).toBeNull();
});

test("a quota above the reported cores doesn't raise them", () => {
  expect(testJobs({ env: {}, root: cgroup({ "cpu.max": "1600000 100000" }), reported: 4, memory: 64 * GB })).toMatchObject({ jobs: 2, cores: 4 });
});

test("TEST_JOBS is exact; TEST_CORES_PER_JOB tunes; never under one", () => {
  const root = "/nonexistent";
  expect(testJobs({ env: { TEST_JOBS: "7" }, root, reported: 4, memory: 64 * GB }).jobs).toBe(7);
  expect(testJobs({ env: { TEST_CORES_PER_JOB: "3" }, root, reported: 4, memory: 64 * GB }).jobs).toBe(1);
  expect(testJobs({ env: { TEST_CORES_PER_JOB: "1" }, root, reported: 4, memory: 64 * GB }).jobs).toBe(4);
  expect(testJobs({ env: {}, root, reported: 1, memory: 64 * GB }).jobs).toBe(1);
});

test("memory caps it: the cgroup's limit, or the machine's", () => {
  const p = testJobs({ env: {}, root: cgroup({ "memory.max": String(6 * GB) }), reported: 16, memory: 64 * GB });
  expect(p.jobs).toBe(3);
  expect(p.why).toContain("memory");
  expect(testJobs({ env: { TEST_MEM_PER_JOB_MB: "4096" }, root: "/nonexistent", reported: 16, memory: 12 * GB }).jobs).toBe(3);
});

test("the time limits' factor: 1 on a quiet machine, the load or the busy cores for each core on a busy one, 3 at most", () => {
  const got = [timeFactor(0, 16), timeFactor(12, 16), timeFactor(24, 16), timeFactor(40, 16), timeFactor(90, 16), timeFactor(5, 0)];
  expect(got).toEqual([1, 1, 1.5, 2.5, 3, 3]);
  // The load's minute is late: 12 cores busy right now count, also with a low load.
  expect([timeFactor(2, 16, 0), timeFactor(2, 16, 12), timeFactor(30, 16, 4)]).toEqual([1, 1.8, 1.9]);
});
