// The arguments that each command of `bun erga` takes. A command applies each argument, or it refuses the command
// line before it does anything, and says why: it never runs on with an argument that it ignores. --help only prints
// the manual: on 2026-11-21, --help ran a command that moved a branch, because that command read no flag at all.

/**
 * For each command ("": the ops page): its flags, its options (each takes one value), the options that can repeat
 * (`many`), and how many plain arguments it takes at most (`words`; none: 0). `setup` reads its own, by the same rule
 * (deploy/own/cli.ts, readOptions).
 */
export const TAKES: Record<string, { flags?: string[]; options?: string[]; many?: string[]; words?: number }> = {
  "": { flags: ["--auto-deploy", "--no-open"], options: ["--port"] },
  skill: {},
  start: { words: 1 },
  proof: { options: ["--look", "--no-picture"], many: ["--look"], words: 1 },
  clean: { flags: ["--yes"] },
  push: {},
  status: { flags: ["--json"] },
  merge: { options: ["-m"], many: ["-m"], words: Infinity },
  try: { words: 1 },
  test: { words: 1 },
  release: { flags: ["--dry-run"], words: 1 },
  deploy: {
    flags: ["--no-tests", "--write-spec", "--dry-run"],
    options: ["--domain", "--remove-domain"],
    many: ["--domain", "--remove-domain"],
    words: 2,
  },
  rollback: { flags: ["--yes"], words: 1 },
  register: {
    flags: ["--no-upstream"],
    options: ["--repo", "--branch", "--host", "--profile", "--region", "--upstream", "--upstream-repo"],
    words: 1,
  },
  track: {
    flags: ["--no-upstream"],
    options: ["--repo", "--branch", "--upstream", "--upstream-repo", "--auto-deploy"],
    words: 1,
  },
  verify: { flags: ["--keep", "--yes"], options: ["--browsers", "--origin"], words: Infinity },
  feedback: { flags: ["--no-open"], words: 1 },
  help: {},
};

/** What a command line asks, before its command runs. */
export interface Asked {
  /** --help or -h: the manual, and nothing else. */
  help: boolean;
  /** The flags that the command does not take. */
  unknown: string[];
  /** Each other argument that the command can't apply, with why: an option with no value, an option two times, a plain argument too many. */
  problems: string[];
  /** The plain arguments, in their order: no flag, no option, no option's value. */
  words: string[];
}

/**
 * Reads a command line against the table. An option's value is never a flag, whatever it starts with; but an option
 * at the end, or one whose next word is another flag or option of the command, has no value. A command that is not in
 * the table reads its own.
 */
export function flagsOf(cmd: string, rest: string[]): Asked {
  const takes = TAKES[cmd];
  const asked: Asked = { help: false, unknown: [], problems: [], words: [] };
  if (!takes) return asked;
  const names = [...(takes.flags ?? []), ...(takes.options ?? []), "--help", "-h"];
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (takes.options?.includes(x)) {
      const value = rest[i + 1];
      if (value == undefined || value == "" || names.includes(value)) asked.problems.push(`${x} needs a value`);
      else i++;
      if (seen.has(x) && !takes.many?.includes(x)) asked.problems.push(`${x} is there 2 times`);
      seen.add(x);
    } else if (x == "--help" || x == "-h") asked.help = true;
    else if (x.startsWith("-") && !takes.flags?.includes(x)) asked.unknown.push(x);
    else if (!x.startsWith("-")) asked.words.push(x);
  }
  const most = takes.words ?? 0;
  if (asked.words.length > most)
    asked.problems.push(
      most
        ? `it takes ${most} plain argument${most > 1 ? "s" : ""} at most, not ${asked.words.slice(most).join(" ")} too`
        : `it takes no plain argument, so not ${asked.words.join(" ")}`
    );
  return asked;
}

/** Why the command line does not run, as its one line, or null. */
export function refusalOf(cmd: string, asked: Asked): string | null {
  const name = `bun erga${cmd ? ` ${cmd}` : ""}`;
  if (asked.unknown.length) return `${name} takes no ${asked.unknown.join(", ")}. Nothing ran.`;
  if (asked.problems.length) return `${name}: ${asked.problems.join("; ")}. Nothing ran.`;
  return null;
}
