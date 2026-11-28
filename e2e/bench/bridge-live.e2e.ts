// Live verification of the chat-native ACP bridge against a real local
// standalone agent (`agy acp`, `claude-agent-acp`, `codex-acp`, `pi-acp`).
// Skipped in normal `bun run test` unless ERGA_LIVE_BRIDGE=<preset> is set:
//
//   ERGA_LIVE_BRIDGE=antigravity bun run test:e2e e2e/bench/bridge-live.e2e.ts

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { answered, say } from "../agent/panel";
import { openEditor, W } from "../helpers/editor";
import { ROOT } from "../helpers/env";
import { expect, servers, test, until } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";

const PRESET = process.env.ERGA_LIVE_BRIDGE?.trim() || "";
const own = () => servers.of("bridge-live");
if (PRESET) await own();

const LIVE = {
  timeout: 120_000,
  skip: PRESET ? false : "a live check: ERGA_LIVE_BRIDGE=antigravity runs it with a real standalone ACP agent",
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

test("live standalone ACP bridge connects to Erga native chat pane and syncs Yjs edits", LIVE, async ({ tab }) => {
  const server = await own();
  await tab.page.setViewportSize({ width: 1280, height: 800 });
  const ed = await openEditor(tab, server, "page");
  await ed.openAgent();
  await ed.frame(`${W}.__marker = 1`);

  const docId = await ed.eval<string>(`document.querySelector('meta[name="erga-doc"]').content`);
  const { token, error } = await newToken(server.root, { label: "Erga Bridge" });
  expect(error, "agent token for live bridge").toBe("");

  const scratch = mkdtempSync("/tmp/erga-acp-live-");
  const ergaHome = join(scratch, "eh");
  mkdirSync(ergaHome, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env, ERGA_HOME: ergaHome, ERGA_TOKEN: token };
  const logs: string[] = [];
  const child = spawn(
    "bun",
    [join(ROOT, "bridge/core/cli.ts"), "connect", `${server.root}/d/${docId}`, "--agent", PRESET, "--auto-approve", "--foreground"],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout?.on("data", (c) => logs.push(String(c)));
  child.stderr?.on("data", (c) => logs.push(String(c)));

  try {
    await until(
      () =>
        ed.eval<boolean>(
          `document.querySelector(".agent-head")?.classList.contains("is-local") && !!document.querySelector('#agent-model-select optgroup[label="Connected agents"] option')`
        ),
      30_000,
      "chat-native ACP bridge connected in browser panel",
      () => logs.join("").slice(-800)
    );
    await say(tab.page, "Reply with the exact word BRIDGE_LIVE_OK and change the h1 heading in index.html to Live ACP Bridge.");
    await answered(tab.page, "BRIDGE_LIVE_OK", 60_000);
    await expect.poll(() => ed.textOf("h1"), { timeout: 15_000 }).toBe("Live ACP Bridge");
    if (process.env.ERGA_BRIDGE_SHOT) await tab.page.screenshot({ path: process.env.ERGA_BRIDGE_SHOT });
    expect(await ed.frame<boolean>(`${W}.__marker == 1`)).toBe(true);
  } finally {
    await stopChild(child);
    rmSync(scratch, { recursive: true, force: true });
  }
});
