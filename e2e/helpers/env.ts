// The tests' environment, made hermetic once in the runner (e2e.config.ts
// calls hermetic() before anything else) and inherited by its workers: a HOME
// of their own with a .gitconfig that asks for nothing and stores nothing, no
// system git config, no prompts, and none of this shell's secrets. Every child
// process a test starts (a dev server, git) gets cleanEnv(), not process.env.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = new URL("../..", import.meta.url).pathname;

/** Names of variables never handed on: anything that looks like a credential. */
const SECRET = /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH|COOKIE|SESSION/i;

/** What git and the tools read from the environment, fixed for every test. */
const GIT = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GCM_INTERACTIVE: "never",
};

/** Runs once per test run (workers see ERGA_TEST_HOME and skip it): the temporary HOME, and process.env scrubbed. True the first time. */
export function hermetic(): boolean {
  if (process.env.ERGA_TEST_HOME) return false;
  const real = homedir();
  // Where this machine's downloads live, read before HOME moves: Playwright's browsers, Bun's package cache.
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= process.platform == "darwin" ? join(real, "Library/Caches/ms-playwright") : join(process.env.XDG_CACHE_HOME || join(real, ".cache"), "ms-playwright");
  process.env.BUN_INSTALL_CACHE_DIR ??= join(real, ".bun/install/cache");
  process.env.ERGA_CHROME_HOME ??= real;
  const home = mkdtempSync(join(tmpdir(), "erga-test-home-"));
  mkdirSync(join(home, ".config"));
  writeFileSync(join(home, ".gitconfig"), [
    "[user]", "\tname = Erga test", "\temail = test@erga.invalid",
    "[init]", "\tdefaultBranch = main",
    "[credential]", "\thelper =",
    "[commit]", "\tgpgsign = false",
    "[tag]", "\tgpgsign = false",
    "",
  ].join("\n"));
  // The one secret kept, asked for by name: the live agent check's key, for its own server only.
  if (process.env.ERGA_LIVE_AGENT == "1" && process.env.ANTHROPIC_API_KEY?.trim()) process.env.ERGA_LIVE_AGENT_KEY = process.env.ANTHROPIC_API_KEY.trim();
  for (const k of Object.keys(process.env)) if (SECRET.test(k) && !k.startsWith("PLAYWRIGHT_")) delete process.env[k];
  Object.assign(process.env, GIT, { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ERGA_TEST_HOME: home });
  process.env.ERGA_TEST_RUN ??= `run-${process.pid}-${Date.now()}`;
  return true;
}

/** What a child process may see of this one's environment, plus `extra`. */
/** (ERGA_ROOM_IDLE_MS: set, the dev servers close idle documents that soon, so the tests open and close them often.) */
/** (PLAYWRIGHT_BROWSERS_PATH: a dev server's own browser, for view_page, is the tests' Chromium: dev/browser.ts.) */
const PASS = [
  "PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "E2E_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "XDG_CONFIG_HOME",
  "BUN_INSTALL_CACHE_DIR",
  "ERGA_CHROME_HOME",
  "ERGA_TEST_RUN",
  "CI",
  "ERGA_ROOM_IDLE_MS",
];

export function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = { ...GIT };
  for (const k of PASS) if (process.env[k] != null) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(extra)) if (v != null) env[k] = v;
  return env;
}
