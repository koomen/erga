// Keeps the machine's own settings out of a test process and everything it starts. tests/run-file.ts (test.sh's
// runner) starts each test file in this environment; a plain `bun tests/x.ts` gets it through tests/host.ts and
// tests/cdp.ts, which import this first: it starts the file again, in it. (Bun gives a child process the
// environment the process started with, whatever process.env says since, unless the spawn passes `env`.)
//
// - git: no system or global config. On a Mac the system config (Xcode's) has the osxkeychain credential helper,
//   which saved an admin token from one test's clone and replayed it in another's "anonymous" push. A global
//   config can carry hooks, signing, LFS filters or a default branch of its own. Tests get a config of their own
//   instead (an identity, main as the default branch), never a prompt for a password, and no GIT_DIR or work tree
//   inherited from a git hook that ran the tests.
// - Credentials the shell or a factory VM has (Cloudflare, GitHub, Claude Code, the factory's own): a test that
//   needs one sets it for the server it starts (tests/host.ts processEnv). ANTHROPIC_API_KEY stays, for
//   tests/agent.ts; tests/host.ts keeps it from the dev servers.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { exitCode, exitedWithin, gone } from "./stop";
import { tmpdir } from "os";
import { join } from "path";

const GITCONFIG = `[user]\n\tname = Erga test\n\temail = test@erga.invalid\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n`;

/** The variables a test process never takes from outside. */
export const DROP = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR",
  "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND",
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_API_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "REPO_TOKEN",
  "FACTORY_RUN", "FACTORY_JOB_RUN", "FACTORY_AGENT_SECRET", "FACTORY_WORK", "FACTORY_HOOK_PREFIX", "FACTORY_TEST_HOOKS",
];

/** `env` made hermetic, in place: what's dropped is gone, git is set up as above. */
export function hermetic(env: Record<string, string | undefined>): Record<string, string | undefined> {
  for (const k of DROP) delete env[k];
  // GIT_CONFIG_COUNT and its KEY_n / VALUE_n pairs (a factory VM passes its push token this way).
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete env[k];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = gitconfig();
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** The tests' global git config: one file for every test process, written once, renamed into place. */
function gitconfig(): string {
  const dir = join(tmpdir(), "erga-test-git");
  const file = join(dir, "gitconfig");
  try { if (readFileSync(file, "utf8") == GITCONFIG) return file; } catch { /* not there yet */ }
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, GITCONFIG);
  renameSync(tmp, file);
  return file;
}

// Under `bun test` (NODE_ENV=test) the unit tests' runner, test.sh, has set it up already; nothing to start again.
// tests/run-file.ts sets it up for the command it runs, and needs nothing of it itself.
if (process.env.ERGA_HERMETIC != "1" && process.env.NODE_ENV != "test" && Bun.main != join(import.meta.dir, "run-file.ts")) {
  const env = hermetic({ ...process.env });
  env.ERGA_HERMETIC = "1";
  env.ERGA_EXIT_FILE = join(tmpdir(), `erga-exit-${process.pid}`);
  const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], { env: env as Record<string, string>, stdio: ["inherit", "inherit", "inherit"] });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  process.on("exit", () => { if (!gone(child.pid)) child.kill("SIGTERM"); });
  while (!(await exitedWithin(child, 3_600_000))) { /* still running */ }
  const code = exitCode(child, env.ERGA_EXIT_FILE);
  rmSync(env.ERGA_EXIT_FILE, { force: true });
  process.exit(code);
}
hermetic(process.env);
