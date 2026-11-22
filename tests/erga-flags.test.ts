// `bun erga <command>` refuses a flag that the command does not take, and --help only prints the manual
// (deploy/cli/flags.ts). On 2026-11-21, --help ran a command that moved a branch.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flagsOf, TAKES } from "../deploy/cli/flags";

const ROOT = new URL("..", import.meta.url).pathname;
const MAIN = join(ROOT, "deploy/cli/main.ts");

test("--help asks for the manual, and a flag that the command does not take is named", () => {
  expect(flagsOf("push", ["--help"])).toEqual({ help: true, unknown: [] });
  expect(flagsOf("push", ["-h"])).toEqual({ help: true, unknown: [] });
  expect(flagsOf("push", ["--yes"])).toEqual({ help: false, unknown: ["--yes"] });
  expect(flagsOf("push", [])).toEqual({ help: false, unknown: [] });
  expect(flagsOf("deploy", ["staging.example.com", "--no-tests", "--domain", "a.example.com", "--dry-run"])).toEqual({
    help: false,
    unknown: [],
  });
  expect(flagsOf("deploy", ["staging.example.com", "--no-test", "--yes"])).toEqual({ help: false, unknown: ["--no-test", "--yes"] });
  expect(flagsOf("", ["--auto-deploy", "--port", "4900", "--open"])).toEqual({ help: false, unknown: ["--open"] });
});

test("an option's value is never a flag, whatever it starts with", () => {
  expect(flagsOf("merge", ["a-branch", "-m", "--help is what the text says"])).toEqual({ help: false, unknown: [] });
  expect(flagsOf("proof", ["A sentence.", "--look", "/ada/page --width 390"])).toEqual({ help: false, unknown: [] });
});

test("each command of bun erga is in the table, but setup, which reads its own flags", () => {
  const commands = [...readFileSync(MAIN, "utf8").matchAll(/^    case "([a-z-]*)":/gm)].map((m) => m[1]).filter((c) => !c.startsWith("-"));
  expect(commands.length).toBeGreaterThan(15);
  expect(commands.filter((c) => !(c in TAKES))).toEqual(["setup"]);
});

test("the command line: --help after a command prints the manual, and an unknown flag stops the command", () => {
  // status only reads: the check runs before every command's own code, the same for each.
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd: ROOT, env: { ...process.env, ERGA_DEPLOY_MOCK: "1" } });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const manual = run("status", "--help");
  expect(manual.code).toBe(0);
  expect(manual.out).toStartWith("Erga's command line: `bun erga <command>`.");
  expect(manual.out).not.toContain("Instances (");
  expect(run("status", "--jsno")).toEqual({
    code: 1,
    out: "FAIL  bun erga status takes no --jsno. Nothing ran.\nNEXT  bun erga --help\n",
  });
  expect(run("--auto-deploy", "--nope")).toEqual({ code: 1, out: "FAIL  bun erga takes no --nope. Nothing ran.\nNEXT  bun erga --help\n" });
});
