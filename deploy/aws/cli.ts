// The AWS CLI, as this machine has it logged in: `aws` with a profile and a region, its JSON answer parsed. Every AWS
// call of `bun erga` goes through here (deploy/aws/). The person's own login (aws sso login, keys, a role): nothing
// of AWS's is in the code.

import { $ } from "bun";

export type Aws = <T = any>(...args: string[]) => Promise<T>;

export interface Where {
  /** The AWS CLI's profile: the account. Empty: the CLI's default (AWS_PROFILE, or default). */
  profile?: string;
  region: string;
}

/** How one call of the CLI ended. */
export interface Ended {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * A test's AWS (tests/helpers/aws-setup.ts): `answer` stands in for the AWS CLI, and no wait takes time. Only a call
 * of this turns it on: nothing in the environment does, so no command runs with it.
 */
let pretend: ((args: string[]) => Ended) | null = null;
export function pretendAws(answer: (args: string[]) => Ended) {
  pretend = answer;
}

/** A wait between two looks at something that AWS makes. */
export const pause = (ms: number): Promise<void> => (pretend ? Promise.resolve() : Bun.sleep(ms));

/** One call of the AWS CLI that needs no login (aws configure), at once: its end, with no error output. */
export function awsNow(...args: string[]): Ended {
  if (pretend) return pretend(args);
  const r = Bun.spawnSync(["aws", ...args], { stdout: "pipe", stderr: "ignore" });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: "" };
}

/** The AWS CLI for `where`. A failed call throws with the CLI's own words. */
export function awsCli(where: Where): Aws {
  const scope = [...(where.profile ? ["--profile", where.profile] : []), "--region", where.region, "--output", "json"];
  return async <T>(...args: string[]) => {
    const r = pretend ? pretend([...args, ...scope]) : await $`aws ${args} ${scope}`.quiet().nothrow();
    if (r.exitCode != 0) throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${r.stderr.toString().trim().split("\n").at(-1)}`);
    const out = r.stdout.toString().trim();
    if (!out) return null as T;
    try {
      return JSON.parse(out) as T;
    } catch {
      return out as T;
    }
  };
}

/** The account the profile reaches, or why not (not logged in, no such profile, no AWS CLI). */
export async function whoAmI(where: Where): Promise<{ account: string; arn: string } | { why: string }> {
  try {
    const me = await awsCli(where)<{ Account: string; Arn: string }>("sts", "get-caller-identity");
    return { account: me.Account, arn: me.Arn };
  } catch (e) {
    const m = (e as Error).message;
    if (/command not found|ENOENT/.test(m))
      return { why: "The AWS CLI isn't installed: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" };
    return { why: `Not logged in to AWS${where.profile ? ` with the profile ${where.profile}` : ""}: ${m}` };
  }
}
