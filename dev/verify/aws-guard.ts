#!/usr/bin/env bun
// The verify suite's AWS CLI: each `aws` command of a step is asked of the suite's rule before it runs (safe.ts,
// awsProblem), a read too. A command that the rule refuses does not run: it fails, with the rule's reason.
//
//   guardAws    starts this process's command again with a folder first in PATH that has this file as `aws`: the
//               suite's own calls, and setup's own code (deploy/aws/cli.ts), find `aws` by PATH. Trap: a change
//               of PATH inside a process that runs does not change where Bun finds a command. So the command starts
//               again, and the second process checks that the suite's `aws` is the one it finds
//   this file   as `aws`: asks the rule, then runs the real CLI with the settings' profile and no keys of the
//               environment
//
// A machine, a key, a secret and a store have no name of the suite's: they count by their ID, which a stack with the
// suite's name has (as CloudFormation says it). The IDs are read when a command names one that is not known yet, and
// kept in the folder for the commands after it.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AwsScope, awsProblem, ours } from "./safe.ts";

/** What the folder's `aws` gets from the process that made it. */
interface Guard {
  /** The real AWS CLI. */
  real: string;
  profile: string;
  /** The two Route 53 test zones' names. */
  zones: string[];
  /** The folder: the IDs are kept in it. */
  dir: string;
}
const ENV = "ERGA_VERIFY_AWS";
/** The region of the stacks whose IDs count: the runs' (dedicated.ts, REGION). */
const REGION = "us-east-1";

/** What no rule lets through: the suite's `aws` refuses it, and the real CLI does not know it. */
const CANARY = "erga-verify-canary";

/** Whether each `aws` command of this process goes to the suite's `aws`: asked with a command, as a call finds it. */
export function guarded(): boolean {
  if (!process.env[ENV]) return false;
  const r = Bun.spawnSync(["aws", CANARY], { stdout: "ignore", stderr: "pipe" });
  return r.exitCode == 2 && r.stderr.toString().includes("The verify suite does not run aws");
}

/**
 * Makes each `aws` command of this process, and of the commands it starts, go to the suite's `aws` first. In a
 * process that has it already (a step of `bun erga verify`): nothing. Else this process's own command starts again
 * with the suite's `aws` first in PATH, and this process ends with that one's result. It throws when the suite's
 * `aws` is not the one that a command finds: then no AWS command runs.
 */
export async function guardAws(profile: string, zones: string[]): Promise<void> {
  if (guarded()) return;
  if (process.env[ENV]) throw new Error("The verify suite's aws is not in front of the AWS CLI in this process: no AWS command runs.");
  const real = Bun.which("aws");
  // (No AWS CLI: no command of it runs.)
  if (!real) return;
  const dir = mkdtempSync(join(tmpdir(), "erga-verify-aws-"));
  writeFileSync(join(dir, "aws"), `#!/bin/sh\nexec "${process.execPath}" "${import.meta.path}" "$@"\n`);
  chmodSync(join(dir, "aws"), 0o700);
  // (Ctrl-C goes to both processes: the second one decides what it does with it.)
  process.on("SIGINT", () => {});
  const again = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
    env: { ...process.env, [ENV]: JSON.stringify({ real, profile, zones, dir } satisfies Guard), PATH: `${dir}:${process.env.PATH}` },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await again.exited;
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

/** The real CLI, with the settings' profile: what it printed, or null when it failed. */
function real(g: Guard, args: string[]): string | null {
  const r = Bun.spawnSync([g.real, ...args, "--profile", g.profile, "--output", "json"], {
    stdout: "pipe",
    stderr: "ignore",
    env: envOf(g),
  });
  return r.exitCode == 0 ? r.stdout.toString() : null;
}
/** The environment of the real CLI: the settings' profile, and no keys (which would win over a profile). */
const envOf = (g: Guard) => {
  const env: Record<string, string | undefined> = { ...process.env, AWS_PROFILE: g.profile };
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) delete env[name];
  return env;
};

/** The IDs and outputs of the stacks with the suite's name, and the test zones' IDs, as the account says them now. */
function look(g: Guard): Pick<AwsScope, "ids" | "zones"> {
  const list = <T>(args: string[]): T[] => JSON.parse(real(g, [...args, "--region", REGION]) ?? "[]") ?? [];
  const live = ["CREATE_IN_PROGRESS", "CREATE_COMPLETE", "CREATE_FAILED", "ROLLBACK_IN_PROGRESS", "ROLLBACK_COMPLETE", "ROLLBACK_FAILED"];
  const stacks = list<string>([
    "cloudformation",
    "list-stacks",
    "--stack-status-filter",
    ...live,
    "UPDATE_IN_PROGRESS",
    "UPDATE_COMPLETE",
    "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
    "UPDATE_ROLLBACK_IN_PROGRESS",
    "UPDATE_ROLLBACK_COMPLETE",
    "UPDATE_ROLLBACK_FAILED",
    "DELETE_IN_PROGRESS",
    "DELETE_FAILED",
    "--query",
    "StackSummaries[].StackName",
  ]).filter(ours);
  const ids = stacks.flatMap((stack) => [
    ...list<string>([
      "cloudformation",
      "describe-stack-resources",
      "--stack-name",
      stack,
      "--query",
      "StackResources[].PhysicalResourceId",
    ]),
    ...list<string>(["cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs[].OutputValue"]),
  ]);
  const zones = list<{ Id: string; Name: string }>(["route53", "list-hosted-zones", "--query", "HostedZones[]"])
    .filter((z) => g.zones.includes(z.Name.replace(/\.$/, "")))
    .map((z) => z.Id.replace("/hostedzone/", ""));
  return { ids: ids.filter((id) => typeof id == "string" && id), zones };
}

if (import.meta.main) {
  const g = JSON.parse(process.env[ENV] ?? "null") as Guard | null;
  if (!g) {
    console.error("The verify suite's aws runs only inside a step of the suite.");
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const kept = join(g.dir, "ids.json");
  let known: Pick<AwsScope, "ids" | "zones"> = existsSync(kept) ? JSON.parse(readFileSync(kept, "utf8")) : { ids: [], zones: [] };
  let no = awsProblem(args, { profile: g.profile, ...known });
  if (no) {
    // (An ID that is not known yet: a stack made it since the last look.)
    known = look(g);
    writeFileSync(kept, JSON.stringify(known));
    no = awsProblem(args, { profile: g.profile, ...known });
  }
  if (no) {
    console.error(no);
    process.exit(2);
  }
  const run = Bun.spawnSync([g.real, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: envOf(g) });
  process.exit(run.exitCode ?? 1);
}
