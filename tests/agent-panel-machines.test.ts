// The agent panel's explicit states, with no browser: each message sent (client/agent/sends.ts), the one "can send
// now" gate (client/agent/send-gate.ts), and the panel kept from page to page (client/common/agent-panel.ts).

import { expect, test } from "bun:test";
import { sendStep, type SendEvent, type SendState } from "../client/agent/sends";
import { canSend, type SendFacts } from "../client/agent/send-gate";
import { panelOpen, panelStep, savePanel, type Drawn } from "../client/common/agent-panel";

const run = (events: SendEvent[], from: SendState = "pending") =>
  events.reduce<{ state: SendState; effects: string[] }>(
    (acc, ev) => {
      const r = sendStep(acc.state, ev);
      return { state: r.state, effects: r.effect ? [...acc.effects, r.effect.t] : acc.effects };
    },
    { state: from, effects: [] }
  );

test("a message: its echo takes the dimmed one away; a failure says Not sent, and Try again sends it again", () => {
  expect(run([{ t: "echo" }])).toEqual({ state: "echoed", effects: ["remove"] });
  expect(run([{ t: "fail", reason: "x" }, { t: "retry" }, { t: "echo" }])).toEqual({
    state: "echoed",
    effects: ["show-failed", "resend", "remove"],
  });
});

test("an echo after the time ran out ends the failed message: Try again can't send it a second time", () => {
  const r = run([{ t: "fail", reason: "the server didn't answer in time" }, { t: "echo" }, { t: "retry" }]);
  expect(r).toEqual({ state: "echoed", effects: ["show-failed", "remove"] });
});

test("a new conversation drops a failed message; one on its way stays", () => {
  expect(run([{ t: "fail", reason: "x" }, { t: "reset" }])).toEqual({ state: "dropped", effects: ["show-failed", "remove"] });
  expect(run([{ t: "reset" }])).toEqual({ state: "pending", effects: [] });
  expect(run([{ t: "echo" }, { t: "echo" }, { t: "fail", reason: "x" }])).toEqual({ state: "echoed", effects: ["remove"] });
});

const facts = (f: Partial<SendFacts>): SendFacts => ({ off: null, reading: 0, text: "hi", files: 0, ...f });

test("no message goes while a file is still being read; the editor's own buttons send no files", () => {
  expect(canSend("box", facts({ reading: 1 }))).toBe("Reading the attached files…");
  expect(canSend("editor", facts({ reading: 1 }))).toBeNull();
});

test("the gate says why: the agent off first; nothing to send", () => {
  expect(canSend("editor", facts({ off: "The agent is off: no key." }))).toBe("The agent is off: no key.");
  expect(canSend("box", facts({ off: "The agent is off: no key.", reading: 1 }))).toBe("The agent is off: no key.");
  expect(canSend("box", facts({ text: "  " }))).toBe("Type a message to send it.");
  expect(canSend("box", facts({ text: "", files: 1 }))).toBeNull();
});

const drawn: Drawn = { person: "ada", doc: null, log: "<div>hi</div>", model: "script", top: 0, bottom: true };

test("a page that goes before it loaded the conversation leaves the tab's copy as it is; once loaded, it keeps its own", () => {
  expect(panelStep("as-left", { t: "leave", drawn: { ...drawn, log: "" } })).toEqual({ state: "as-left", save: null });
  const loaded = panelStep("as-left", { t: "loaded" });
  expect(loaded).toEqual({ state: "loaded", save: null });
  expect(panelStep(loaded.state, { t: "leave", drawn })).toEqual({ state: "loaded", save: drawn });
});

test("open or closed is kept for each document, and one time for every page outside a document, which a new document takes", () => {
  const kept = new Map<string, string>(),
    g = globalThis as { localStorage?: unknown },
    was = g.localStorage;
  g.localStorage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  try {
    const shown = () => [panelOpen("a"), panelOpen("b"), panelOpen(null)];
    expect(shown(), "open unless closed").toEqual([true, true, true]);
    savePanel({ open: false }, "b");
    expect(shown(), "closed on b only").toEqual([true, false, true]);
    savePanel({ open: false });
    expect(shown(), "closed outside a document: a, never opened or closed, follows").toEqual([false, false, false]);
    savePanel({ open: true }, "a");
    expect(shown(), "opened on a only").toEqual([true, false, false]);
    savePanel({ open: true });
    expect(shown(), "opened outside a document: b stays closed").toEqual([true, false, true]);
    savePanel({ open: false });
    expect(shown(), "and a stays open").toEqual([true, false, false]);
    g.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(shown(), "with no storage, open").toEqual([true, true, true]);
  } finally {
    g.localStorage = was;
  }
});
