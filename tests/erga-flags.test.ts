// `bun erga <command>` ignores no argument (deploy/cli/flags.ts): a command applies each one, or it refuses the
// command line before it does anything, and says why. --help only prints the manual. On 2026-11-21, --help ran a
// command that moved a branch; on 2026-11-22, setup ran on with options that it left out silently.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flagsOf, refusalOf, TAKES } from "../deploy/cli/flags";
import { mergeProblem } from "../deploy/cli/flow";
import { readOptions, wordsProblem } from "../deploy/own/cli";
import { missing } from "../deploy/own/flow";
import { commandOf } from "../dev/verify/suite";

const ROOT = new URL("..", import.meta.url).pathname;
const MAIN = join(ROOT, "deploy/cli/main.ts");
/** What the command line asks, without its plain arguments. */
const asked = (cmd: string, rest: string[]) => {
  const { words: _, problems: __, ...a } = flagsOf(cmd, rest);
  return a;
};
const refusal = (cmd: string, ...rest: string[]) => refusalOf(cmd, flagsOf(cmd, rest));

test("--help asks for the manual, and a flag that the command does not take is named", () => {
  expect(asked("push", ["--help"])).toEqual({ help: true, unknown: [] });
  expect(asked("push", ["-h"])).toEqual({ help: true, unknown: [] });
  expect(asked("push", ["--yes"])).toEqual({ help: false, unknown: ["--yes"] });
  expect(asked("push", [])).toEqual({ help: false, unknown: [] });
  expect(asked("deploy", ["staging.example.com", "--no-tests", "--domain", "a.example.com", "--dry-run"])).toEqual({
    help: false,
    unknown: [],
  });
  expect(asked("deploy", ["staging.example.com", "--no-test", "--yes"])).toEqual({ help: false, unknown: ["--no-test", "--yes"] });
  expect(asked("", ["--auto-deploy", "--port", "4900", "--open"])).toEqual({ help: false, unknown: ["--open"] });
});

test("an option's value is never a flag, whatever it starts with, and is no plain argument", () => {
  expect(flagsOf("merge", ["a-branch", "-m", "--help is what the text says"])).toEqual({
    help: false,
    unknown: [],
    problems: [],
    words: ["a-branch"],
  });
  expect(flagsOf("proof", ["A sentence.", "--look", "/ada/page --width 390", "--look", "/ada/other"])).toEqual({
    help: false,
    unknown: [],
    problems: [],
    words: ["A sentence."],
  });
  expect(flagsOf("deploy", ["abc123", "staging.example.com", "--domain", "a.example.com", "--domain", "b.example.com"]).words).toEqual([
    "abc123",
    "staging.example.com",
  ]);
});

test("each command of bun erga is in the table, but setup, which reads its own options by the same rule", () => {
  const commands = [...readFileSync(MAIN, "utf8").matchAll(/^    case "([a-z-]*)":/gm)].map((m) => m[1]).filter((c) => !c.startsWith("-"));
  expect(commands.length).toBeGreaterThan(15);
  expect(commands.filter((c) => !(c in TAKES))).toEqual(["setup"]);
  // And the table names no command that is not there.
  expect(Object.keys(TAKES).filter((c) => !commands.includes(c))).toEqual([]);
});

test("no command ignores an argument: a flag it does not take, an option with no value or given two times, and a plain argument too many all stop it", () => {
  for (const [cmd, takes] of Object.entries(TAKES)) {
    const name = `bun erga${cmd ? ` ${cmd}` : ""}`;
    // A flag that no command takes.
    expect(refusal(cmd, "--not-a-flag")).toBe(`${name} takes no --not-a-flag. Nothing ran.`);
    // One plain argument more than it takes.
    const most = takes.words ?? 0;
    const words = Array.from({ length: Math.min(most, 3) + 1 }, (_, i) => `word${i}`);
    if (most == Infinity) expect(refusal(cmd, ...words)).toBeNull();
    else {
      expect(refusal(cmd, ...words.slice(0, most))).toBeNull();
      expect(refusal(cmd, ...words)).toBe(
        most
          ? `${name}: it takes ${most} plain argument${most > 1 ? "s" : ""} at most, not word${most} too. Nothing ran.`
          : `${name}: it takes no plain argument, so not word0. Nothing ran.`
      );
    }
    for (const option of takes.options ?? []) {
      // With no value: at the end, before another flag of the command, and with an empty one.
      expect(refusal(cmd, option)).toBe(`${name}: ${option} needs a value. Nothing ran.`);
      expect(refusal(cmd, option, "")).toContain(`${option} needs a value`);
      expect(refusal(cmd, option, "--help")).toContain(`${option} needs a value`);
      for (const flag of takes.flags ?? []) expect(refusal(cmd, option, flag)).toBe(`${name}: ${option} needs a value. Nothing ran.`);
      // Two times: only an option that can repeat.
      expect(refusal(cmd, option, "one", option, "two")).toBe(
        takes.many?.includes(option) ? null : `${name}: ${option} is there 2 times. Nothing ran.`
      );
    }
  }
  // Each option that can repeat is one whose every value the command applies.
  expect(Object.values(TAKES).flatMap((t) => t.many ?? [])).toEqual(["--look", "-m", "--domain", "--remove-domain"]);
  // merge: a branch has one text.
  expect(mergeProblem(["a", "-m", "one", "b", "-m", "two"])).toBeNull();
  expect(mergeProblem(["-m", "one", "a", "b", "-m", "two"])).toBeNull();
  expect(mergeProblem(["a", "-m", "one", "-m", "two"])).toBe("-m is there 2 times for one branch: a branch has one text.");
  expect(mergeProblem(["-m", "one", "a", "-m", "two"])).toBe("-m is there 2 times for one branch: a branch has one text.");
  expect(mergeProblem(["-m", "one", "-m", "two", "a"])).toBe("-m is there 2 times for the first branch: a branch has one text.");
});

test("setup ignores no argument: an unknown option, one with no value, one two times, and one that does nothing with the other answers stop it", () => {
  const options = (...args: string[]) => readOptions("erga.example.com", args);
  expect(options("--colour", "red").problems).toEqual(["--colour isn't an option of bun erga setup."]);
  expect(options("-x").problems).toEqual(["-x isn't an option of bun erga setup."]);
  // (A word that every object has, as "constructor", is no option and no option's name.)
  expect(options("constructor", "--pages", "constructor").rest).toEqual(["constructor"]);
  expect(options("--host").problems).toEqual(["--host needs a value."]);
  // The next word is an option of its own: it is read, not eaten as the value.
  const next = options("--pages", "--deploys", "local", "--dry-run");
  expect([next.problems, next.answers.deploys]).toEqual([["--pages needs a value."], "local"]);
  expect(options("--host", "aws", "--dry-run", "--host", "cloudflare").problems).toEqual(["--host is there 2 times: give it one time."]);
  expect(options("--dry-run", "--dry-run").problems).toEqual(["--dry-run is there 2 times: give it one time."]);
  // --keep repeats: each one is an account.
  const keeps = options("--keep", "Ada=Ada@Example.com", "--keep", "bo=bo@example.com");
  expect([keeps.problems, keeps.answers.keep]).toEqual([
    [],
    [
      { login: "ada", email: "ada@example.com" },
      { login: "bo", email: "bo@example.com" },
    ],
  ]);
  expect(options("--keep", "ada").problems[0]).toStartWith('--keep: "ada" isn\'t <username>=<address>');
  // The answers that the command line gave, by key: an instance with an admin changes only by these.
  expect(options("--host", "cloudflare", "--pages", "example-pages.com", "--deploys", "local").answers.given).toEqual([
    "where",
    "pages",
    "deploys",
  ]);
  // The words: remove takes --yes only, and --yes is the removal's only.
  const words = (...args: string[]) => wordsProblem(args, options(...args).rest);
  expect(words("remove", "--yes")).toBeNull();
  expect(words("remove")).toBeNull();
  expect(words("remove", "--yes", "--dry-run")).toBe("bun erga setup <host> remove takes --yes only, not --dry-run. Nothing ran.");
  expect(words("remove", "--yes", "--host", "aws")).toBe("bun erga setup <host> remove takes --yes only, not --host aws. Nothing ran.");
  expect(words("delete", "--yes")).toBe("No setup command delete. Nothing ran.");
  expect(words("--host", "cloudflare", "--yes")).toBe(
    "--yes goes with remove only (bun erga setup <host> remove --yes): leave it out. Nothing ran."
  );
  expect(words("--host", "cloudflare", "--deploys", "local", "--dry-run")).toBeNull();
  // An option that does nothing with the other answers: the command says so, before it looks at anything.
  const need = (...args: string[]) => missing(options(...args).answers);
  expect(need("--host", "cloudflare", "--deploys", "local", "--team", "acme", "--aud", "f".repeat(64))).toEqual([
    "--team, --aud go with --sign-in sso only: leave them out.",
  ]);
  expect(need("--host", "cloudflare", "--deploys", "local", "--profile", "work", "--egress", "nat-gateway")).toEqual([
    "--profile, --egress go with --host aws only: leave them out.",
  ]);
  expect(need("--host", "aws", "--pages", "example-pages.com", "--deploys", "local", "--account", "Ada")).toEqual([
    "--account goes with --host cloudflare only: leave it out.",
  ]);
  expect(need("--host", "aws", "--pages", "example-pages.com", "--deploys", "local", "--keep", "ada=ada@example.com")).toEqual([
    "--keep goes with --host cloudflare only: leave it out.",
  ]);
  expect(need("--host", "cloudflare", "--deploys", "local", "--auto-deploy", "commits")[0]).toStartWith(
    "--auto-deploy goes with --deploys cloud only"
  );
});

test("verify ignores no argument: the check takes none, and update and remove ask nothing", () => {
  const o = { prereqs: [], left: [], kept: {}, browsers: ["chromium"] };
  const cmd = (words: string, keep = false, ...options: string[]) => commandOf(words.split(" ").filter(Boolean), keep, { ...o, options });
  expect(cmd("")).toEqual({ at: "check" });
  expect(cmd("check")).toEqual({ at: "check" });
  expect(cmd("check 1")).toMatchObject({ at: "fail", why: "The check deploys nothing and asks nothing: it takes no 1. Nothing ran." });
  expect(cmd("", true, "--yes")).toMatchObject({
    at: "fail",
    why: "The check deploys nothing and asks nothing: it takes no --keep, --yes. Nothing ran.",
  });
  expect(cmd("check", false, "--browsers")).toMatchObject({ at: "fail" });
  expect(cmd("update all", false, "--yes")).toMatchObject({
    at: "fail",
    why: "--yes goes with a run: update asks nothing. Leave it out. Nothing ran.",
  });
  expect(cmd("remove all", false, "--origin")).toMatchObject({
    at: "fail",
    why: "--origin goes with a run or an update: remove checks nothing. Leave it out. Nothing ran.",
  });
});

test("the command line: --help after a command prints the manual, and an argument that the command can't apply stops it", () => {
  // The check runs before every command's own code, the same for each. (Each of these does nothing but read, or
  // stops before it starts: a refusal that failed here would not change anything.)
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd: ROOT, env: { ...process.env, ERGA_DEPLOY_MOCK: "1" }, timeout: 20_000 });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const stopped = (out: string) => ({ code: 1, out: `FAIL  ${out}\nNEXT  bun erga --help\n` });
  const manual = run("status", "--help");
  expect(manual.code).toBe(0);
  expect(manual.out).toStartWith("Erga's command line: `bun erga <command>`.");
  expect(manual.out).not.toContain("Instances (");
  expect(run("status", "--jsno")).toEqual(stopped("bun erga status takes no --jsno. Nothing ran."));
  expect(run("--auto-deploy", "--nope")).toEqual(stopped("bun erga takes no --nope. Nothing ran."));
  expect(run("status", "erga.example.com")).toEqual(
    stopped("bun erga status: it takes no plain argument, so not erga.example.com. Nothing ran.")
  );
  expect(run("skill", "--json")).toEqual(stopped("bun erga skill takes no --json. Nothing ran."));
  expect(run("track", "erga.example.com", "--branch")).toEqual(stopped("bun erga track: --branch needs a value. Nothing ran."));
  expect(run("--port", "http")).toEqual(stopped("bun erga: --port http is no port: a number from 1 to 65535. Nothing ran."));
  expect(run("register", "erga.example.com", "--region", "us-east-1")).toEqual(
    stopped("bun erga register: --profile and --region go with --host aws only: leave them out. Nothing ran.")
  );
  expect(run("deploy", "erga.example.com", "--remove-domain", "a.example.com", "--dry-run", "--no-tests")).toEqual(
    stopped("bun erga deploy: --dry-run only says what --remove-domain does: leave out --no-tests. Nothing ran.")
  );
  expect(run("merge", "a-branch", "-m", "one", "-m", "two")).toEqual(
    stopped("bun erga merge: -m is there 2 times for one branch: a branch has one text. Nothing ran.")
  );
  // setup reads its own, and stops in the same way.
  const setup = (...args: string[]) => run("setup", "erga.example.com", ...args).out.split("\n")[0];
  expect(setup("--host", "cloudflare", "--host", "aws")).toBe("FAIL  --host is there 2 times: give it one time.");
  expect(setup("--host", "cloudflare", "--deploys", "local", "--yes")).toBe(
    "FAIL  --yes goes with remove only (bun erga setup <host> remove --yes): leave it out. Nothing ran."
  );
  expect(setup("--host", "cloudflare", "--deploys", "local", "--team", "acme")).toBe(
    "FAIL  The command needs: --team goes with --sign-in sso only: leave it out."
  );
}, 120_000);
