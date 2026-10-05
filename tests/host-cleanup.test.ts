// killLeftovers (tests/host.ts): kills what runs from a test's folder, with or without lsof (a factory VM's image may lack it).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { killLeftovers } from "./host.ts";

const PATH = process.env.PATH;
const dirs: string[] = [];
afterEach(() => { process.env.PATH = PATH; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scratch() { const d = mkdtempSync(join(tmpdir(), "erga-cleanup-")); dirs.push(d); return d; }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid: number) { for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(20); return !alive(pid); }

/** A PATH with pgrep on it and no lsof. */
function pathWithoutLsof() {
  const bin = scratch();
  symlinkSync(Bun.which("pgrep")!, join(bin, "pgrep"));
  process.env.PATH = bin;
  expect(Bun.which("lsof", { PATH: bin })).toBeNull();
}

test("without lsof: no error, and a process with the folder in its command line goes", async () => {
  const dir = scratch();
  const p = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)", dir]);
  pathWithoutLsof();
  expect(() => killLeftovers(dir)).not.toThrow();
  process.env.PATH = PATH;
  expect(await gone(p.pid)).toBe(true);
});

test("a process whose working directory is in the folder goes (Linux: /proc, without lsof; elsewhere: lsof)", async () => {
  const dir = scratch();
  const p = Bun.spawn(["sleep", "30"], { cwd: dir });
  if (process.platform == "linux") pathWithoutLsof();
  else if (!Bun.which("lsof")) { p.kill(); return; } // nothing to find it with
  killLeftovers(dir);
  process.env.PATH = PATH;
  const ok = await gone(p.pid);
  if (!ok) p.kill();
  expect(ok).toBe(true);
});
