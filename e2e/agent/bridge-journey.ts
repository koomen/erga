// Local ACP bridge checks inside e2e/agent/turn.e2e.ts: no-key panel off, bridge connect, permission cards,
// Yjs disk sync, blocked auto-expand, per-session thread isolation, disconnect notice without auto-switch, and reconnect.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErgaBridgeClient } from "../../bridge/core/bridge-client";
import { YjsDiskSync } from "../../bridge/core/yjs-sync";
import type { ToBridge } from "../../shared/bridge-protocol";
import { openEditor } from "../helpers/editor";
import { expect, settle, until, type Server, type Tab } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";
import { answered, answers, paneOpen, say } from "./panel";

export async function runLocalBridgeChecks(tab: Tab, off: Server): Promise<void> {
  const ed = await openEditor(tab, off, "page");
  await ed.openAgent();
  const state = () =>
    ed.eval<{ hint: string; hidden: boolean; disabled: string | null; title: string }>(
      `(() => { const h = document.getElementById("agent-hint"), b = document.getElementById("agent-send"); return { hint: h.innerText, hidden: h.hidden, disabled: b.getAttribute("aria-disabled"), title: b.title }; })()`
    );
  const offHint = "To enable the agent, add an LLM provider key. Or connect your own agent.";
  await expect.poll(async () => (await state()).hidden).toBe(false);
  let st = await state();
  expect(st.hint).toBe(offHint);
  expect(st.disabled).toBe("true");
  expect(st.title).toMatch(/agent is off.*ANTHROPIC_API_KEY/);
  await ed.type("hello");
  await ed.press("Enter");
  await ed.settle();
  st = await state();
  expect(st.hidden).toBe(false);
  expect(st.hint).toBe(offHint);
  expect(await ed.eval<string>(`document.getElementById("agent-input").value`)).toBe("hello");

  const docId = await ed.eval<string>(`document.querySelector('meta[name="erga-doc"]').content`);
  const { token, error } = await newToken(off.root, { label: "Erga Bridge" });
  expect(error, "agent token for local bridge").toBe("");
  const syncDir = mkdtempSync(join(tmpdir(), "erga-bridge-e2e-"));
  const sync = new YjsDiskSync({ origin: off.root, docId, dir: syncDir, token: async () => token });
  const received: ToBridge[] = [];
  const ask = { t: "tool" as const, id: "bridge-call-1", name: "edit_file", path: "index.html" };
  const bridge = new ErgaBridgeClient({
    origin: off.root,
    id: "e2e-antigravity",
    agent: "antigravity",
    label: "Antigravity (repo)",
    version: "dev",
    token: async () => token,
    onMessage(msg) {
      received.push(msg);
      if (msg.type == "prompt") {
        bridge.sendEvent(msg.doc, {
          ...ask,
          status: "asking",
          detail: "Edit index.html",
          choices: [
            { id: "deny", label: "Deny", kind: "deny" },
            { id: "allow_once", label: "Allow once", kind: "allow" },
            { id: "__erga_allow_session__", label: "Allow all (session)", kind: "always" },
          ],
        });
      } else if (msg.type == "answer" && msg.id == ask.id) {
        bridge.sendEvent(msg.doc, { ...ask, status: msg.approve ? "done" : "error" });
        if (msg.approve) {
          const f = join(syncDir, "index.html");
          writeFileSync(f, readFileSync(f, "utf8").replace("<h1>Launch notes</h1>", "<h1>Edited by local bridge</h1>"));
          void sync.flush().then(() => {
            bridge.sendEvent(msg.doc, { t: "text", delta: "Updated from local Antigravity." });
            bridge.sendEvent(msg.doc, { t: "busy", busy: false });
            bridge.turnDone(msg.doc);
          });
        }
      }
    },
  });
  try {
    await sync.start();
    await bridge.start();
    bridge.bind(docId, { label: "Antigravity (repo)", sessionId: "e2e-s1" });

    await until(
      () =>
        ed.eval<boolean>(
          `document.querySelector('#agent-model-select optgroup[label="Connected agents"] option')?.textContent == "Antigravity (repo)" && document.getElementById("agent-hint").hidden && document.querySelector(".agent-head")?.classList.contains("is-local")`
        ),
      5_000,
      "chat-native bridge enables panel"
    );
    await tab.page.fill("#agent-input", "");
    await say(tab.page, "Update the heading");
    const card = tab.page.locator("#agent-log .msg-tool.asking");
    const allow = card.getByRole("button", { name: "Allow all (session)" });
    await until(() => allow.isVisible(), 5_000, "permission choices");
    expect(await card.locator(".ask-acts button").allTextContents()).toEqual(["Deny", "Allow once", "Allow all (session)"]);
    await allow.click();
    await answered(tab.page, "Updated from local Antigravity.", 5_000);
    await expect.poll(() => ed.textOf("h1")).toBe("Edited by local bridge");
    expect(received.map((m) => m.type)).toEqual(["prompt", "answer"]);
    expect(received[1]).toMatchObject({ type: "answer", id: "bridge-call-1", approve: true, choice: "__erga_allow_session__" });

    await tab.page.click("#agent-close");
    await expect.poll(() => paneOpen(tab.page)).toBe(false);
    const ask2 = { t: "tool" as const, id: "bridge-call-2", name: "run_command", path: "check" };
    bridge.sendEvent(docId, { ...ask2, status: "asking", detail: "Run checks" });
    await expect.poll(() => paneOpen(tab.page)).toBe(true);
    expect(await ed.eval<string | null>(`localStorage.getItem("erga:agent:v1:" + ${JSON.stringify(docId)})`)).toBe("closed");

    await tab.page.click("#agent-close");
    await expect.poll(() => paneOpen(tab.page)).toBe(false);
    bridge.sendEvent(docId, { t: "busy", busy: false });
    await settle(tab.page);
    expect(await paneOpen(tab.page)).toBe(false);
    bridge.sendEvent(docId, { ...ask2, status: "done" });

    await tab.page.click("#agent-fab");
    bridge.bind(docId, { label: "Antigravity (repo)", sessionId: "e2e-s2" });
    await until(
      () =>
        ed.eval<boolean>(
          `document.getElementById("agent").dataset.thread == "local:e2e-antigravity:e2e-s2" && !document.getElementById("agent-log").children.length`
        ),
      5_000,
      "2nd local thread"
    );
    bridge.sendEvent(docId, { t: "text", delta: "Fresh thread." });
    await answered(tab.page, "Fresh thread.", 5_000);
    expect(await answers(tab.page)).toEqual(["Fresh thread."]);

    // Disconnect: must stay on the disconnected local agent (never auto-switch), keep its transcript,
    // show #agent-banner.disconnected directly above #agent-form, and disable Send.
    bridge.stop();
    await until(
      () =>
        ed.eval<boolean>(
          `(() => {
            const b = document.getElementById("agent-banner"), f = document.getElementById("agent-form");
            const sel = document.getElementById("agent-model-select");
            const opt = sel?.selectedOptions?.[0]?.textContent ?? "";
            return !b.hidden && b.classList.contains("disconnected") && b.getBoundingClientRect().bottom <= f.getBoundingClientRect().top + 1
              && opt == "Antigravity (repo) (disconnected)"
              && document.querySelector(".agent-head")?.classList.contains("is-disconnected")
              && document.getElementById("agent-fab")?.classList.contains("disconnected")
              && document.getElementById("agent-hint").hidden
              && document.getElementById("agent-send").getAttribute("aria-disabled") == "true";
          })()`
        ),
      5_000,
      "disconnect notice directly above input without auto-switch"
    );
    expect(await answers(tab.page)).toEqual(["Fresh thread."]);
    expect(await ed.eval<string>(`document.getElementById("agent-banner").innerText`)).toContain("Disconnected from Antigravity (repo)");
    expect(await ed.eval<string>(`document.getElementById("agent-input").placeholder`)).toBe("Antigravity (repo) is disconnected");

    // Reconnect: same bridge resumes seamlessly, shows green reconnected notice, and keeps the same thread.
    const bridge2 = new ErgaBridgeClient({
      origin: off.root,
      id: "e2e-antigravity",
      agent: "antigravity",
      label: "Antigravity (repo)",
      version: "dev",
      initialReconnect: true,
      token: async () => token,
      onMessage() {},
    });
    try {
      await bridge2.start();
      bridge2.bind(docId, { label: "Antigravity (repo)", sessionId: "e2e-s2" });
      await until(
        () =>
          ed.eval<boolean>(
            `(() => {
              const b = document.getElementById("agent-banner");
              return !b.hidden && b.classList.contains("reconnected")
                && !document.querySelector(".agent-head")?.classList.contains("is-disconnected")
                && !document.getElementById("agent-fab")?.classList.contains("disconnected");
            })()`
          ),
        5_000,
        "reconnect notice and cleared disconnect chrome"
      );
      expect(await answers(tab.page)).toEqual(["Fresh thread."]);
    } finally {
      bridge2.stop();
    }
  } finally {
    bridge.stop();
    await sync.stop();
    rmSync(syncDir, { recursive: true, force: true });
  }
}
