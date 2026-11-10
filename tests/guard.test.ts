// The guard of agents' shell commands (dev/guard.ts): each known mistake is refused with what to do instead, the
// right forms run, and the hook itself (.claude/settings.json runs it with node) answers as Claude Code reads it.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { verdict } from "../dev/guard";

const ROOT = resolve(import.meta.dir, "..");

test("the known mistakes are refused, each with what to do", () => {
  const refused: [string, string][] = [
    ["git push", "bun erga push"],
    ["git add -A && git commit -m x && git push origin HEAD:task", "bun erga push"],
    ["cd /x; git -C /x push --force origin task", "bun erga push"],
    ["gh pr create --fill", "no pull requests"],
    ["pkill -f dev/start.ts", "by its PID"],
    ["sleep 1; killall node", "by its PID"],
    ["rm -rf $DIR/build", "${VAR:?}"],
    ['rm -rf "${DIR}/build"', "${VAR:?}"],
    ["ln -s ../../node_modules node_modules", "bun install --frozen-lockfile"],
    ["bash <<EOF\ngit push origin task\nEOF", "bun erga push"],
    ["cat > a.md <<EOF\ntext\nEOF\ngit push", "bun erga push"],
  ];
  for (const [command, say] of refused) {
    const v = verdict(command);
    expect([command, v?.ask ?? false, v?.why.includes(say)]).toEqual([command, false, true]);
  }
});

test("the right forms run", () => {
  for (const command of [
    "bun erga push",
    "git push origin --delete old-task",
    'git commit -m "bun erga push replaces git push"',
    "kill $(lsof -ti tcp:4712 -sTCP:LISTEN)",
    'rm -rf "${DIR:?}/build" /tmp/literal',
    "rm -f $(git ls-files -o)",
    "ln -s a.txt b.txt",
    "bun run test",
    "grep -rn 'pkill' AGENTS.md",
    "cat > notes.md <<'EOF'\nnever a plain `git push`\ngit push origin main\nEOF\nwc -w notes.md",
  ])
    expect([command, verdict(command)]).toEqual([command, null]);
});

test("the tests that call the real model ask the person first", () => {
  expect(verdict("ERGA_LIVE_AGENT=1 bun run test:e2e e2e/bench/agent-live.e2e.ts")?.ask).toBe(true);
});

test("the hook: node runs the guard, which stops the command with exit 2, or asks in JSON", () => {
  const hook = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8")).hooks.PreToolUse[0];
  expect(hook.matcher).toBe("Bash");
  expect(hook.hooks[0].command).toBe('node "$CLAUDE_PROJECT_DIR/dev/guard.ts"');
  const run = (command: string) => {
    const r = Bun.spawnSync(["sh", "-c", hook.hooks[0].command], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
      stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Bash", tool_input: { command } })),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const no = run("git push origin HEAD");
  expect([no.code, no.err.includes("bun erga push")]).toEqual([2, true]);
  expect(run("git status")).toEqual({ code: 0, out: "", err: "" });
  expect(JSON.parse(run("ERGA_LIVE_AGENT=1 bun test").out).hookSpecificOutput.permissionDecision).toBe("ask");
});
