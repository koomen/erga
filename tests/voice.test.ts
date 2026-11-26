// Unit tests for Voice Mode's pure state machine and spoken `"send prompt"` trigger parser (client/agent/voice-state.ts).

import { expect, test } from "bun:test";
import {
  CLEAN_RESTART_MS,
  HEALTHY_MS,
  INTERIM_TRIGGER_MS,
  initialVoiceState,
  isArmed,
  joinSpeech,
  nextBackoff,
  parseVoiceTrigger,
  voiceStep,
  type VoiceEvent,
  type VoiceState,
} from "../client/agent/voice-state";

function run(start: VoiceState, events: [VoiceEvent, number?][]) {
  let state = start;
  let effects: ReturnType<typeof voiceStep>["effects"] = [];
  let t = 10_000;
  let q = 0;
  for (const [ev, now] of events) {
    t = now ?? t;
    const res = voiceStep(state, ev, t, () => `q${++q}`);
    state = res.state;
    effects = res.effects;
  }
  return { state, effects };
}

test("joinSpeech merges speech segments cleanly without double spaces or spaces before punctuation", () => {
  expect(joinSpeech("", "hello")).toBe("hello");
  expect(joinSpeech("hello", "")).toBe("hello");
  expect(joinSpeech("hello ", " world")).toBe("hello world");
  expect(joinSpeech("hello", ", world")).toBe("hello, world");
  expect(joinSpeech("make it bigger", ".")).toBe("make it bigger.");
});

test("parseVoiceTrigger handles casing, punctuation, word boundaries, and mid-utterance carry-over", () => {
  expect(parseVoiceTrigger("Make the header bigger send prompt")).toEqual({
    prompt: "Make the header bigger",
    remainder: "",
  });
  expect(parseVoiceTrigger("Summarize section two, Send Prompt.")).toEqual({
    prompt: "Summarize section two",
    remainder: "",
  });
  expect(parseVoiceTrigger("Add a footer. Send-prompt! Now check mobile")).toEqual({
    prompt: "Add a footer.",
    remainder: "Now check mobile",
  });
  expect(parseVoiceTrigger("SEND, PROMPT?")).toEqual({ prompt: "", remainder: "" });
  expect(parseVoiceTrigger("Don't resend prompts automatically")).toBeNull();
  expect(parseVoiceTrigger("send prompting instructions")).toBeNull();
});

test("unsupported browsers never fail silently and never arm", () => {
  const s0 = initialVoiceState(false);
  expect(s0.phase).toBe("unsupported");
  expect(isArmed(s0.phase)).toBe(false);
  const { state, effects } = voiceStep(s0, { t: "toggle" }, 1000);
  expect(state.phase).toBe("unsupported");
  expect(effects).toEqual([
    { t: "hint", text: "Voice mode needs a browser with Web Speech recognition (Chrome, Edge, or Safari).", sticky: false },
  ]);
});

test("live dictation transcribes interim and final speech, strips send prompt, and stays armed", () => {
  const { state: armed } = run(initialVoiceState(true), [[{ t: "toggle" }], [{ t: "rec-start" }]]);
  expect(armed.phase).toBe("listening");
  expect(isArmed(armed.phase)).toBe(true);

  const interim = voiceStep(
    armed,
    { t: "rec-result", resultIndex: 0, slices: [{ transcript: "Tighten the header spacing", isFinal: false }] },
    10_500
  );
  expect(interim.state.phase).toBe("transcribing");
  expect(interim.effects).toEqual([{ t: "cancel-interim-trigger" }, { t: "set-input", value: "Tighten the header spacing", draft: null }]);

  const sent = voiceStep(
    interim.state,
    { t: "rec-result", resultIndex: 0, slices: [{ transcript: "Tighten the header spacing, send prompt.", isFinal: true }] },
    11_000
  );
  expect(sent.state.phase).toBe("listening");
  expect(isArmed(sent.state.phase)).toBe(true);
  expect(sent.state.agentBusy).toBe(true);
  expect(sent.state.committed).toBe("");
  expect(sent.effects).toEqual([
    { t: "cancel-interim-trigger" },
    { t: "dispatch-prompt", text: "Tighten the header spacing" },
    { t: "set-input", value: "", draft: null },
  ]);
});

test("interim trigger fires after stability window and suppresses duplicate final delivery", () => {
  const { state: armed } = run(initialVoiceState(true), [[{ t: "toggle" }], [{ t: "rec-start" }]]);

  const scheduled = voiceStep(
    armed,
    { t: "rec-result", resultIndex: 0, slices: [{ transcript: "Check dark mode send prompt", isFinal: false }] },
    10_500
  );
  expect(scheduled.effects).toContainEqual({ t: "schedule-interim-trigger", ms: INTERIM_TRIGGER_MS });

  const fired = voiceStep(scheduled.state, { t: "interim-trigger-due" }, 11_200);
  expect(fired.effects).toContainEqual({ t: "dispatch-prompt", text: "Check dark mode" });
  expect(fired.effects).toContainEqual({ t: "flush-rec" });
  expect(fired.state.committed).toBe("");

  // Late final echo of the exact same utterance index is ignored.
  const echo = voiceStep(
    fired.state,
    { t: "rec-result", resultIndex: 0, slices: [{ transcript: "Check dark mode send prompt", isFinal: true }] },
    11_400
  );
  expect(echo.state.queue).toEqual([]);
  expect(echo.effects.some((e) => e.t == "dispatch-prompt")).toBe(false);
});

test("mid-utterance carry-over preserves words spoken right after send prompt", () => {
  const { state: armed } = run(initialVoiceState(true), [[{ t: "toggle" }], [{ t: "rec-start" }]]);
  const res = voiceStep(
    armed,
    {
      t: "rec-result",
      resultIndex: 0,
      slices: [{ transcript: "Make the title larger send prompt also check dark mode", isFinal: true }],
    },
    10_800
  );
  expect(res.state.phase).toBe("transcribing");
  expect(res.state.committed).toBe("also check dark mode");
  expect(res.effects).toEqual([
    { t: "cancel-interim-trigger" },
    { t: "dispatch-prompt", text: "Make the title larger" },
    { t: "set-input", value: "also check dark mode", draft: "also check dark mode" },
  ]);
});

test("empty send prompt shows a brief hint without dispatching", () => {
  const { state: armed } = run(initialVoiceState(true), [[{ t: "toggle" }], [{ t: "rec-start" }]]);
  const res = voiceStep(armed, { t: "rec-result", resultIndex: 0, slices: [{ transcript: "Send prompt.", isFinal: true }] }, 10_500);
  expect(res.state.phase).toBe("listening");
  expect(res.state.agentBusy).toBe(false);
  expect(res.effects).toContainEqual({
    t: "hint",
    text: "Nothing to send yet — speak a message, then say “send prompt”.",
    sticky: false,
  });
});

test("busy and asking states queue spoken prompts and auto-drain only when idle and not asking", () => {
  const { state: busy } = run(initialVoiceState(true), [
    [{ t: "toggle" }],
    [{ t: "rec-start" }],
    [{ t: "agent-status", busy: true, asking: false, off: null, readingFiles: 0, files: 0 }],
    [{ t: "rec-result", resultIndex: 0, slices: [{ transcript: "Add dark mode tokens send prompt", isFinal: true }] }],
  ]);
  expect(busy.queue).toEqual([{ id: "q1", text: "Add dark mode tokens" }]);

  // Transitioning to asking (tool approval) must NOT auto-drain, or it would auto-deny the tool call.
  const asking = voiceStep(busy, { t: "agent-status", busy: false, asking: true, off: null, readingFiles: 0, files: 0 }, 12_000);
  expect(asking.state.queue).toEqual([{ id: "q1", text: "Add dark mode tokens" }]);
  expect(asking.effects).toEqual([]);

  // Once the user answers approval and the turn is idle, the queue drains automatically.
  const drained = voiceStep(asking.state, { t: "agent-status", busy: false, asking: false, off: null, readingFiles: 0, files: 0 }, 13_000);
  expect(drained.state.queue).toEqual([]);
  expect(drained.state.agentBusy).toBe(true);
  expect(drained.effects).toEqual([{ t: "dispatch-prompt", text: "Add dark mode tokens" }]);
});

test("queue-send-now, queue-drop, conversation-reset, and Stop holdQueue work cleanly", () => {
  const { state: queued } = run(initialVoiceState(true), [
    [{ t: "toggle" }],
    [{ t: "rec-start" }],
    [{ t: "agent-status", busy: true, asking: false, off: null, readingFiles: 0, files: 0 }],
    [{ t: "rec-result", resultIndex: 0, slices: [{ transcript: "First follow-up send prompt", isFinal: true }] }],
    [
      {
        t: "rec-result",
        resultIndex: 1,
        slices: [
          { transcript: "First follow-up send prompt", isFinal: true },
          { transcript: "Second follow-up send prompt", isFinal: true },
        ],
      },
    ],
  ]);
  expect(queued.queue.map((q) => q.text)).toEqual(["First follow-up", "Second follow-up"]);

  // Explicit Stop holds queue instead of draining.
  const stopped = voiceStep(
    queued,
    { t: "agent-status", busy: false, asking: false, off: null, readingFiles: 0, files: 0, holdQueue: true },
    11_000
  );
  expect(stopped.effects).toEqual([]);
  expect(stopped.state.queue.length).toBe(2);

  // Send now dispatches head immediately.
  const sentNow = voiceStep(stopped.state, { t: "queue-send-now", id: stopped.state.queue[0].id }, 11_100);
  expect(sentNow.effects).toEqual([{ t: "dispatch-prompt", text: "First follow-up" }]);
  expect(sentNow.state.queue.map((q) => q.text)).toEqual(["Second follow-up"]);

  // Conversation reset clears any remaining queued prompts.
  const reset = voiceStep(sentNow.state, { t: "conversation-reset" }, 11_200);
  expect(reset.state.queue).toEqual([]);
});

test("onend auto-restarts quickly after healthy uptime and backs off exponentially on rapid failures", () => {
  const { state: armed } = run(initialVoiceState(true), [
    [{ t: "toggle" }, 1000],
    [{ t: "rec-start" }, 1100],
  ]);

  // Healthy session (>= 2s) restarts in 150ms with retries reset.
  const cleanEnd = voiceStep(armed, { t: "rec-end" }, 1100 + HEALTHY_MS);
  expect(cleanEnd.state.phase).toBe("restarting");
  expect(cleanEnd.state.retries).toBe(0);
  expect(cleanEnd.effects).toContainEqual({ t: "schedule-restart", ms: CLEAN_RESTART_MS });

  const restarting = voiceStep(cleanEnd.state, { t: "restart-due" }, 3300);
  expect(restarting.state.phase).toBe("starting");
  expect(restarting.effects).toEqual([{ t: "start-rec" }]);

  // Rapid failures back off: 250, 500, 1000, 2000, 4000, 5000.
  expect([1, 2, 3, 4, 5, 6].map(nextBackoff)).toEqual([250, 500, 1000, 2000, 4000, 5000]);
  let s = restarting.state;
  const delays: number[] = [];
  for (let i = 0; i < 3; i++) {
    const ended = voiceStep(s, { t: "rec-end" }, 3400 + i * 100);
    const fx = ended.effects.find((e) => e.t == "schedule-restart");
    delays.push(fx && fx.t == "schedule-restart" ? fx.ms : -1);
    s = voiceStep(ended.state, { t: "restart-due" }, 3450 + i * 100).state;
  }
  expect(delays).toEqual([250, 500, 1000]);
});

test("hidden tab pauses recognition while armed and resumes automatically when visible", () => {
  const { state: armed } = run(initialVoiceState(true), [[{ t: "toggle" }], [{ t: "rec-start" }]]);
  const hidden = voiceStep(armed, { t: "visibility", hidden: true }, 12_000);
  expect(hidden.state.phase).toBe("paused");
  expect(isArmed(hidden.state.phase)).toBe(true);
  expect(hidden.effects).toEqual([{ t: "cancel-restart" }, { t: "cancel-interim-trigger" }, { t: "stop-rec" }]);

  // rec-end arriving while paused must not schedule a restart.
  const endWhilePaused = voiceStep(hidden.state, { t: "rec-end" }, 12_100);
  expect(endWhilePaused.state.phase).toBe("paused");
  expect(endWhilePaused.effects).toEqual([]);

  const visible = voiceStep(endWhilePaused.state, { t: "visibility", hidden: false }, 15_000);
  expect(visible.state.phase).toBe("starting");
  expect(visible.effects).toEqual([{ t: "start-rec" }]);
});

test("manual shutoff mid-sentence preserves spoken text, and terminal mic errors never loop", () => {
  const { state: mid } = run(initialVoiceState(true), [
    [{ t: "toggle" }],
    [{ t: "rec-start" }],
    [{ t: "rec-result", resultIndex: 0, slices: [{ transcript: "Keep these words", isFinal: false }] }],
  ]);
  const off = voiceStep(mid, { t: "toggle" }, 12_000);
  expect(off.state.phase).toBe("off");
  expect(off.state.committed).toBe("Keep these words");
  expect(off.effects).toContainEqual({ t: "set-input", value: "Keep these words", draft: "Keep these words" });

  // Terminal not-allowed error transitions to error and stops restarting.
  const { state: starting } = run(off.state, [[{ t: "toggle" }]]);
  const blocked = voiceStep(starting, { t: "rec-error", code: "not-allowed" }, 13_000);
  expect(blocked.state.phase).toBe("error");
  expect(blocked.state.error?.code).toBe("not-allowed");
  expect(isArmed(blocked.state.phase)).toBe(false);

  // Clicking toggle again retries cleanly.
  const retry = voiceStep(blocked.state, { t: "toggle" }, 14_000);
  expect(retry.state.phase).toBe("starting");
  expect(retry.state.error).toBeNull();
  expect(retry.effects).toEqual([{ t: "start-rec" }]);
});

test("repeated network errors escalate to terminal error after 5 failures", () => {
  let { state } = run(initialVoiceState(true), [[{ t: "toggle" }], [{ t: "rec-start" }]]);
  for (let i = 0; i < 4; i++) {
    state = voiceStep(state, { t: "rec-error", code: "network" }, 11_000 + i * 100).state;
    expect(isArmed(state.phase)).toBe(true);
  }
  const fifth = voiceStep(state, { t: "rec-error", code: "network" }, 12_000);
  expect(fifth.state.phase).toBe("error");
  expect(fifth.state.error?.code).toBe("network-fatal");
});

test("manual typing and manual send coexist cleanly with armed Voice Mode", () => {
  const { state: armed } = run(initialVoiceState(true), [[{ t: "toggle" }], [{ t: "rec-start" }]]);
  const typed = voiceStep(armed, { t: "input-edited", value: "Manual prefix" }, 11_000);
  expect(typed.state.committed).toBe("Manual prefix");
  expect(typed.state.phase).toBe("transcribing");

  const sent = voiceStep(typed.state, { t: "manual-send" }, 11_200);
  expect(sent.state.phase).toBe("listening");
  expect(isArmed(sent.state.phase)).toBe(true);
  expect(sent.state.committed).toBe("");
});
