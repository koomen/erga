// The agent panel's explicit states, with no browser: each message sent (client/agent/sends.ts), the one "can send
// now" gate (client/agent/send-gate.ts), and the panel kept from page to page (client/common/agent-panel.ts).

import { expect, test } from "bun:test";
import { sendStep, type SendEvent, type SendState } from "../client/agent/sends";
import { canSend, type SendFacts } from "../client/agent/send-gate";
import { panelStep, type Drawn } from "../client/common/agent-panel";

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

const facts = (f: Partial<SendFacts>): SendFacts => ({ off: null, voice: false, reading: 0, text: "hi", files: 0, ...f });

test("no message goes while a file is still being read, by Send or by voice; the editor's own buttons send no files", () => {
  expect(canSend("box", facts({ reading: 1 }))).toBe("Reading the attached files…");
  expect(canSend("voice", facts({ voice: true, reading: 1 }))).toBe("Reading the attached files…");
  expect(canSend("editor", facts({ reading: 1 }))).toBeNull();
  expect(canSend("voice", facts({ voice: true }))).toBeNull();
});

test("the gate says why: the agent off first; Send in voice mode; nothing to send", () => {
  expect(canSend("editor", facts({ off: "The agent is off: no key." }))).toBe("The agent is off: no key.");
  expect(canSend("voice", facts({ off: "The agent is off: no key.", reading: 1 }))).toBe("The agent is off: no key.");
  expect(canSend("box", facts({ voice: true }))).toMatch(/^Voice mode is on/);
  expect(canSend("box", facts({ text: "  " }))).toBe("Type a message to send it.");
  expect(canSend("box", facts({ text: "", files: 1 }))).toBeNull();
});

const drawn: Drawn = { person: "ada", log: "<div>hi</div>", model: "script", top: 0, bottom: true };

test("a page that goes before it loaded the conversation leaves the tab's copy as it is; once loaded, it keeps its own", () => {
  expect(panelStep("as-left", { t: "leave", drawn: { ...drawn, log: "" } })).toEqual({ state: "as-left", save: null });
  const loaded = panelStep("as-left", { t: "loaded" });
  expect(loaded).toEqual({ state: "loaded", save: null });
  expect(panelStep(loaded.state, { t: "leave", drawn })).toEqual({ state: "loaded", save: drawn });
});
