// What the Factory object keeps of each admin's agent conversation, and the
// factory's agent going on with it (factory/agent.ts, `restore`): the transcript and the model's
// messages, a reply cut off in the middle, screenshots, size limits and the panel's prefs.

import { expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { CUT, panelPrefs, restoredLog, restoredMessages, STOPPED, storedLog, storedMessages } from "../agents/admin-chats";
import { startAdminAgent } from "../agents/admin";
import type { Log } from "../shared/agent-log";

const script = { apiKey: Redacted.make(""), model: "script" as const, effort: "medium" as const };

/** Runs one message to the end of its turn. */
function turn(agent: ReturnType<typeof startAdminAgent>, text: string) {
  return new Promise<void>((resolve) => {
    const off = agent.subscribe((ev) => { if (ev.t == "busy" && !ev.busy) { off(); resolve(); } });
    agent.prompt(text, null);
  });
}

test("a conversation stored and restored goes on where it was: the transcript and what the model remembers", async () => {
  const a = startAdminAgent({ cfg: script, owner: "root", tools: [] });
  await turn(a, `@script [{"text":"Hello, root."}]`);
  const log = storedLog(a.log()), messages = storedMessages(a.messages());

  const b = startAdminAgent({ cfg: script, owner: "root", tools: [], restore: { log: restoredLog(log), messages: restoredMessages(messages) } });
  expect(b.log().items).toEqual([{ kind: "user", text: `@script [{"text":"Hello, root."}]` }, { kind: "assistant", text: "Hello, root." }]);
  expect(b.messages().map((m) => (m as { role: string }).role)).toEqual(["user", "assistant"]);
  await turn(b, `@script [{"text":"Again."}]`);
  expect(b.log().items.map((i) => i.kind)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(b.messages().length).toBe(4);
});

test("a reply cut off while it streamed keeps what arrived, and the history stays valid", () => {
  const log: Log = { busy: true, undoable: 0, items: [
    { kind: "user", text: "Read the board" },
    { kind: "assistant", text: "I'll look at" },
    { kind: "tool", id: "t1", name: "list_tasks", path: null, status: "running" },
  ] };
  const back = restoredLog(storedLog(log));
  expect(back.busy).toBe(false);
  expect(back.items[1]).toEqual({ kind: "assistant", text: "I'll look at" });
  expect(back.items[2]).toMatchObject({ kind: "tool", status: "error", detail: STOPPED });
  expect(back.items[3]).toEqual({ kind: "error", text: CUT });
  // Restored again (the object went away once more before anyone spoke): marked once.
  expect(restoredLog(storedLog(back)).items.length).toBe(4);

  const msgs = [
    { role: "user", content: "one", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "a", name: "list_tasks", arguments: {} }], timestamp: 2 },
    { role: "toolResult", toolCallId: "a", toolName: "list_tasks", content: [{ type: "text", text: "No tasks." }], isError: false, timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "None." }], timestamp: 4 },
    { role: "user", content: "two", timestamp: 5 },
    // The object went away here: a tool call with no result.
    { role: "assistant", content: [{ type: "toolCall", id: "b", name: "get_task", arguments: { id: 1 } }], timestamp: 6 },
  ] as unknown as AgentMessage[];
  expect(restoredMessages(storedMessages(msgs)).map((m) => (m as { timestamp: number }).timestamp)).toEqual([1, 2, 3, 4, 5]);
  expect(restoredMessages("not json")).toEqual([]);
  expect(restoredLog("{broken")).toEqual({ items: [], busy: false, undoable: 0 });
});

test("a big conversation fits: screenshots go first, then the oldest turns", () => {
  const image = "data:image/png;base64," + "A".repeat(5000);
  const log: Log = { busy: false, undoable: 0, items: [
    { kind: "user", text: "old ".repeat(500) },
    { kind: "tool", id: "s", name: "view_screenshot", path: "#1", status: "done", image },
    { kind: "user", text: "new" },
  ] };
  const kept = restoredLog(storedLog(log, 4000));
  expect(kept.items.length).toBe(3);
  expect(kept.items[1]).not.toHaveProperty("image");
  expect(restoredLog(storedLog(log, 60)).items).toEqual([{ kind: "user", text: "new" }]);
  expect(restoredLog(storedLog(log)).items[1]).toMatchObject({ image });

  const msgs = [
    { role: "user", content: "x".repeat(3000), timestamp: 1 },
    { role: "toolResult", toolCallId: "a", toolName: "v", content: [{ type: "image", data: "A".repeat(5000), mimeType: "image/png" }], isError: false, timestamp: 2 },
    { role: "user", content: "last", timestamp: 3 },
  ] as unknown as AgentMessage[];
  const all = JSON.parse(storedMessages(msgs));
  expect(JSON.stringify(all)).not.toContain("AAAA");
  expect(all[1].content[0].type).toBe("text");
  expect(JSON.parse(storedMessages(msgs, 1000)).map((m: { timestamp: number }) => m.timestamp)).toEqual([3]);
});

test("the panel's prefs keep only what's valid", () => {
  expect(panelPrefs({ open: false, side: "right", width: 512.4 })).toEqual({ open: false, side: "right", width: 512 });
  expect(panelPrefs({ open: "yes", side: "up", width: "wide" })).toEqual({});
  expect(panelPrefs(null)).toEqual({});
  expect(panelPrefs({ width: 1e9 }).width).toBe(4000);
});
