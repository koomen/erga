// The guard of an agent's shell commands. Claude Code runs it before each command (.claude/settings.json, the
// PreToolUse hook of Bash): it reads the hook's JSON on stdin, and refuses a known mistake with what to do instead
// (exit 2: the agent reads the text), or has Claude Code ask the person. Each rule was a warning in AGENTS.md once; a
// new known mistake is a new rule here, with its case in tests/guard.test.ts. Node runs it, with no import: a hook's
// shell does not always have Bun on its PATH.

/** What to do with a command: refuse it, or ask the person first. */
export interface Verdict {
  ask?: true;
  why: string;
}

/** A command's parts, each as one simple command: without the variables set before it, and words like `exec`. */
function parts(command: string): string[] {
  // A here-document's lines are a file's text, not commands, unless a shell reads them.
  const text = command.replace(
    /^([^\n]*)<<-?\s*(['"]?)(\w+)\2([^\n]*)\n[\s\S]*?\n\s*\3$/gm,
    (all, before: string, _q, _tag, after: string) => (/(^|[\s|;&])(ba|z)?sh\b/.test(before) ? all : `${before}${after}`)
  );
  return text
    .split(/&&|\|\||[;|\n]|\$\(|`/)
    .map((p) => p.trim().replace(/^(\(|\{ |then |do |else |if |! )+/, ""))
    .map((p) => p.replace(/^((\w+=("[^"]*"|'[^']*'|\S*)|exec|time|command|sudo)\s+)+/, ""))
    .filter(Boolean);
}

/** The verdict on a shell command, or null: it may run. */
export function verdict(command: string): Verdict | null {
  for (const p of parts(command)) {
    if (/^git\s+(-C\s+\S+\s+)?push\b/.test(p) && !/\s(--delete|-d)\s/.test(p))
      return {
        why: "Push with `bun erga push`: it formats, builds, tests, and pushes only when the tests pass. (To remove a branch on GitHub: git push origin --delete <branch>.)",
      };
    if (/^gh\s+pr\s+create\b/.test(p))
      return { why: "Erga has no pull requests. Push the branch (bun erga push); Pete asks for the merge." };
    if (/^(pkill|killall)\b/.test(p))
      return {
        why: "A name or a pattern also matches the processes of the other work folders. Stop only your own process, by its PID: kill $(lsof -ti tcp:<your port> -sTCP:LISTEN). Without -sTCP:LISTEN, lsof also gives the browsers that have the page open.",
      };
    if (/^rm\s/.test(p) && /\$(?!\{\w+:\?)(?!\()/.test(p))
      return { why: 'rm takes a literal path or "${VAR:?}": with a bare $VAR, an empty variable removes the wrong folder.' };
    if (/^ln\s+-\w*s/.test(p) && /node_modules/.test(p))
      return {
        why: "Never link node_modules: git add -A commits the link, and each deploy then fails. Run bun install --frozen-lockfile in the folder (bun erga start does it).",
      };
  }
  if (/\bERGA_LIVE_AGENT=1\b/.test(command))
    return { ask: true, why: "ERGA_LIVE_AGENT=1 runs the tests that call the real model. They cost money." };
  return null;
}

if (import.meta.main) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  let command = "";
  try {
    command = String(JSON.parse(text).tool_input?.command ?? "");
  } catch {
    // Not the hook's JSON: nothing to judge.
  }
  const v = verdict(command);
  if (v?.ask)
    console.log(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: v.why } })
    );
  else if (v) {
    console.error(`erga: ${v.why} If this text is not a command to run (a file's content), write the file with the Write tool.`);
    process.exit(2);
  }
}
