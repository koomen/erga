// Live verification of the herdr-core/rex bridge against an isolated local
// herdr-core session (never touches the user's default session). Skipped in
// normal `bun run test` unless ERGA_LIVE_BRIDGE=herdr-core is set.
//
//   ERGA_LIVE_BRIDGE=herdr-core bun run test:e2e e2e/bench/bridge-live.e2e.ts

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openEditor, W } from "../helpers/editor";
import { ROOT } from "../helpers/env";
import { expect, servers, test, until } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";

const ENABLED = process.env.ERGA_LIVE_BRIDGE == "herdr-core";
const own = () => servers.of("bridge-live");
if (ENABLED) await own();

const LIVE = {
  timeout: 90_000,
  skip: ENABLED ? false : "a live check: ERGA_LIVE_BRIDGE=herdr-core runs it with an isolated local hc server",
};

function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

test("live herdr-core bridge streams PTY in the browser panel and syncs Yjs edits", LIVE, async ({ tab }) => {
  const server = await own();
  await tab.page.setViewportSize({ width: 1280, height: 800 });
  const ed = await openEditor(tab, server, "page");
  await ed.openAgent();
  await ed.frame(`${W}.__marker = 1`);

  const docId = await ed.eval<string>(`document.querySelector('meta[name="erga-doc"]').content`);
  const { token, error } = await newToken(server.root, { label: "Erga Bridge" });
  expect(error, "agent token for live bridge").toBe("");

  // Short path under /tmp so macOS 103-byte Unix socket limit is never exceeded.
  const scratch = mkdtempSync("/tmp/erga-hc-live-");
  const stateHome = join(scratch, "st");
  const ergaHome = join(scratch, "eh");
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(ergaHome, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    HC_SESSION: "t",
    ERGA_HOME: ergaHome,
    ERGA_TOKEN: token,
  };
  delete env.HC_SOCKET;
  delete env.HC_TERMINAL_SOCKET;
  delete env.HC_TERMINAL_ID;
  delete env.HC_SCOPE;
  const started = spawnSync("hc", ["run", "--bg", "--name", "sh1", "--", "/bin/sh"], { env });
  expect(started.status).toBe(0);

  const logs: string[] = [];
  const child = spawn("bun", [join(ROOT, "bridge/core/cli.ts"), "open", `${server.root}/d/${docId}`, "--terminal", "sh1", "--foreground"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c) => logs.push(String(c)));
  child.stderr?.on("data", (c) => logs.push(String(c)));

  try {
    await until(
      () => ed.eval<boolean>(`!document.getElementById("agent-term-wrap")?.hidden && !!document.querySelector(".agent-term-host .xterm")`),
      15_000,
      "browser terminal pane mounted for live herdr-core session",
      () => logs.join("").slice(-800)
    );
    // Type a real command in Erga's browser terminal pane and verify it executes inside the real herdr-core PTY!
    const markerFile = join(scratch, "typed-ok.txt");
    await tab.page.locator(".agent-term-host .xterm").click();
    await tab.page.keyboard.type(`echo LIVE_HC_OK > ${markerFile}\n`);
    await until(
      () => existsSync(markerFile),
      10_000,
      "command typed in browser terminal ran inside real herdr-core PTY",
      () => logs.join("").slice(-800)
    );
    if (process.env.ERGA_BRIDGE_SHOT) await tab.page.screenshot({ path: process.env.ERGA_BRIDGE_SHOT });
    expect(await ed.frame<boolean>(`${W}.__marker == 1`)).toBe(true);
  } finally {
    await stopChild(child);
    spawnSync("hc", ["server", "stop"], { env });
    rmSync(scratch, { recursive: true, force: true });
  }
});
