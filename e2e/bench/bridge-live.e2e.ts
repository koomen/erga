// A live check of the local Antigravity bridge (bridge/core/cli.ts) against the real `agy` CLI:
// it mounts a document's Yjs room into a temp folder, connects /api/agent/bridge on a bare server
// with no API keys, enables the browser panel under "Connected agents", sends a prompt from the
// browser, lets real `agy acp` edit index.html on disk, verifies the edit lands in the open editor
// without a reload, checks the streamed reply, and verifies the panel returns to off on disconnect.
//
// It calls the real Antigravity agent, so it skips itself unless asked for: `bun run test` never
// runs it.
//
//   ERGA_LIVE_BRIDGE=1 bun run test:e2e e2e/bench/bridge-live.e2e.ts
//
// (Set AGY_BIN=/path/to/agy if `agy` is not on PATH.)
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openEditor, W, type Editor } from "../helpers/editor";
import { ROOT } from "../helpers/env";
import { expect, servers, test, until } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";
import { say } from "../agent/panel";

const ENABLED = process.env.ERGA_LIVE_BRIDGE == "1";
const own = () => servers.of("bridge-live");
if (ENABLED) await own();

/** A live `agy acp` turn can take up to two minutes. */
const LIVE = { timeout: 240_000, skip: ENABLED ? false : "a live check: ERGA_LIVE_BRIDGE=1 runs it with local agy" };
const TURN_MS = 180_000;

const working = (ed: Editor) =>
  ed.eval<boolean>(
    `document.getElementById("agent-fab").classList.contains("busy") || !!document.querySelector("#agent-log .msg-user.pending")`
  );

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
    }, 5_000);
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

test(
  "local Antigravity bridge mounts the Yjs room, enables the panel with no API keys, edits index.html live, and disconnects cleanly",
  LIVE,
  async ({ tab }) => {
    const server = await own();
    await tab.page.setViewportSize({ width: 1280, height: 800 });
    const ed = await openEditor(tab, server, "page");
    await ed.openAgent();
    await ed.frame(`${W}.__marker = 1`);

    const docId = await ed.eval<string>(`document.querySelector('meta[name="erga-doc"]').content`);
    const { token, error } = await newToken(server.root, { label: "Antigravity" });
    expect(error, "agent token for live bridge").toBe("");

    const scratch = mkdtempSync(join(tmpdir(), "erga-live-"));
    const ergaHome = join(scratch, "erga");
    const workDir = join(scratch, "work");
    mkdirSync(ergaHome, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    const logs: string[] = [];
    const child = spawn(
      "bun",
      [join(ROOT, "bridge/core/cli.ts"), "connect", `${server.root}/d/${docId}`, "--agent", "antigravity", "--foreground"],
      {
        cwd: workDir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.ERGA_CHROME_HOME || homedir(),
          ERGA_HOME: ergaHome,
          ERGA_TOKEN: token,
          ...(process.env.AGY_BIN ? { AGY_BIN: process.env.AGY_BIN } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    child.stdout?.on("data", (c) => logs.push(String(c)));
    child.stderr?.on("data", (c) => logs.push(String(c)));

    const dump = () => logs.join("").slice(-1200);
    try {
      await until(
        () =>
          ed.eval<boolean>(
            `!!document.querySelector('#agent-model-select optgroup[label="Connected agents"] option') && document.getElementById("agent-hint").hidden`
          ),
        20_000,
        "live Antigravity bridge connects and enables the panel",
        dump
      );

      await say(
        tab.page,
        'Edit index.html in the mounted Erga directory to change the <h1> text from "Launch notes" to "Live bridge notes", then reply "Done.".'
      );

      await until(() => working(ed), 15_000, "panel enters busy state", dump);
      await until(
        async () => {
          const approve = tab.page.locator("#agent-log .msg-tool.asking").getByRole("button", { name: "Approve" });
          if (await approve.isVisible().catch(() => false)) await approve.click();
          const hasReply = await ed.eval<boolean>(`!!document.querySelector("#agent-log .msg-assistant")?.textContent?.trim()`);
          return hasReply && !(await working(ed));
        },
        TURN_MS,
        "live Antigravity turn finishes with a reply",
        dump
      );

      await expect.poll(() => ed.textOf("h1"), { timeout: 15_000 }).toBe("Live bridge notes");
      expect(ed.disk(), "edit reached server disk").toContain("<h1>Live bridge notes</h1>");
      expect(await ed.frame<boolean>(`${W}.__marker == 1`), "edit arrived without a page reload").toBe(true);
      expect(
        await ed.eval<boolean>(`!!document.querySelector("#agent-log .msg-assistant")?.textContent?.trim()`),
        "streamed assistant reply shown in panel"
      ).toBe(true);
    } finally {
      await stopChild(child);
      rmSync(scratch, { recursive: true, force: true });
    }

    await expect
      .poll(() => ed.eval<string>(`document.getElementById("agent-hint").innerText`), { timeout: 10_000 })
      .toBe("To enable the agent, add an LLM provider key. Or connect your own agent.");
  }
);
