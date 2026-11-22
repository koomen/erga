// The flags that each command of `bun erga` takes. A command refuses any other before it does anything, and --help only
// prints the manual: on 2026-11-21, --help ran a command that moved a branch, because that command read no flag at all.

/** For each command ("": the ops page): its flags, and its options, which take one value each. `setup` reads its own (deploy/own/cli.ts). */
export const TAKES: Record<string, { flags?: string[]; options?: string[] }> = {
  "": { flags: ["--auto-deploy", "--no-open"], options: ["--port"] },
  skill: {},
  start: {},
  proof: { options: ["--look", "--no-picture"] },
  clean: { flags: ["--yes"] },
  push: {},
  status: { flags: ["--json"] },
  merge: { options: ["-m"] },
  try: {},
  test: {},
  release: { flags: ["--dry-run"] },
  deploy: { flags: ["--no-tests", "--write-spec", "--dry-run"], options: ["--domain", "--remove-domain"] },
  rollback: { flags: ["--yes"] },
  register: {
    flags: ["--no-upstream"],
    options: ["--repo", "--branch", "--host", "--profile", "--region", "--upstream", "--upstream-repo"],
  },
  track: { flags: ["--no-upstream"], options: ["--repo", "--branch", "--upstream", "--upstream-repo", "--auto-deploy"] },
  verify: { flags: ["--keep", "--yes"], options: ["--browsers", "--origin"] },
  feedback: { flags: ["--no-open"] },
  help: {},
};

/**
 * What a command line asks before its command runs: the manual (--help, -h), and the flags that the command does not
 * take. An option's value is never a flag, whatever it starts with. A command that is not in the table reads its own.
 */
export function flagsOf(cmd: string, rest: string[]): { help: boolean; unknown: string[] } {
  const takes = TAKES[cmd];
  const asked = { help: false, unknown: [] as string[] };
  if (!takes) return asked;
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (takes.options?.includes(x)) i++;
    else if (x == "--help" || x == "-h") asked.help = true;
    else if (x.startsWith("-") && !takes.flags?.includes(x)) asked.unknown.push(x);
  }
  return asked;
}
