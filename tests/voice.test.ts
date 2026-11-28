// Unit tests for Voice Mode's pure state machine and spoken `"send prompt"` trigger parser (client/agent/voice-state.ts).

import { expect, test } from "bun:test";
import {
  AUDIO_CAPTURE_INIT_RETRIES,
  CLEAN_RESTART_MS,
  HEALTHY_MS,
  INTERIM_TRIGGER_MS,
  SPEECH_IDLE_MS,
  START_TIMEOUT_MS,
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
  expect(interim.state.speaking).toBe(true);
  expect(interim.effects).toEqual([
    { t: "schedule-speech-idle", ms: SPEECH_IDLE_MS },
    { t: "cancel-interim-trigger" },
    { t: "set-input", value: "Tighten the header spacing", draft: null },
  ]);

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
    { t: "schedule-speech-idle", ms: SPEECH_IDLE_MS },
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
    { t: "schedule-speech-idle", ms: SPEECH_IDLE_MS },
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

  // Healthy session (>= 2s) restarts after CLEAN_RESTART_MS with retries reset.
  const cleanEnd = voiceStep(armed, { t: "rec-end" }, 1100 + HEALTHY_MS);
  expect(cleanEnd.state.phase).toBe("restarting");
  expect(cleanEnd.state.retries).toBe(0);
  expect(cleanEnd.effects).toContainEqual({ t: "schedule-restart", ms: CLEAN_RESTART_MS });

  const restarting = voiceStep(cleanEnd.state, { t: "restart-due" }, 3500);
  expect(restarting.state.phase).toBe("starting");
  expect(restarting.effects).toEqual([{ t: "start-rec" }, { t: "schedule-start-timeout", ms: START_TIMEOUT_MS }]);

  // Rapid failures back off: 400, 800, 1600, 3200, 5000, 5000.
  expect([1, 2, 3, 4, 5, 6].map(nextBackoff)).toEqual([400, 800, 1600, 3200, 5000, 5000]);
  let s = restarting.state;
  const delays: number[] = [];
  for (let i = 0; i < 3; i++) {
    const ended = voiceStep(s, { t: "rec-end" }, 3600 + i * 100);
    const fx = ended.effects.find((e) => e.t == "schedule-restart");
    delays.push(fx && fx.t == "schedule-restart" ? fx.ms : -1);
    s = voiceStep(ended.state, { t: "restart-due" }, 3650 + i * 100).state;
  }
  expect(delays).toEqual([400, 800, 1600]);
});

test("hidden tab pauses recognition while armed and resumes with a settle delay when visible", () => {
  const { state: armed } = run(initialVoiceState(true), [[{ t: "toggle" }], [{ t: "rec-start" }]]);
  const hidden = voiceStep(armed, { t: "visibility", hidden: true }, 12_000);
  expect(hidden.state.phase).toBe("paused");
  expect(isArmed(hidden.state.phase)).toBe(true);
  expect(hidden.state.hasStarted).toBe(true);
  expect(hidden.effects).toEqual([
    { t: "cancel-restart" },
    { t: "cancel-interim-trigger" },
    { t: "cancel-speech-idle" },
    { t: "cancel-start-timeout" },
    { t: "stop-rec" },
  ]);

  // rec-end arriving while paused must not schedule a restart.
  const endWhilePaused = voiceStep(hidden.state, { t: "rec-end" }, 12_100);
  expect(endWhilePaused.state.phase).toBe("paused");
  expect(endWhilePaused.effects).toEqual([]);

  // Returning to the tab settles CLEAN_RESTART_MS so iOS Safari can hand back AVAudioSession.
  const visible = voiceStep(endWhilePaused.state, { t: "visibility", hidden: false }, 15_000);
  expect(visible.state.phase).toBe("restarting");
  expect(visible.effects).toEqual([{ t: "schedule-restart", ms: CLEAN_RESTART_MS }]);

  const resumed = voiceStep(visible.state, { t: "restart-due" }, 15_000 + CLEAN_RESTART_MS);
  expect(resumed.state.phase).toBe("starting");
  expect(resumed.effects).toEqual([{ t: "start-rec" }, { t: "schedule-start-timeout", ms: START_TIMEOUT_MS }]);
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

test("speaking tracks sound-start, sound-end, rec-result decay, and clears on pause or shutoff", () => {
  const { state: armed } = run(initialVoiceState(true), [[{ t: "toggle" }], [{ t: "rec-start" }]]);
  expect(armed.speaking).toBe(false);

  const talking = voiceStep(armed, { t: "sound-start" }, 10_200);
  expect(talking.state.speaking).toBe(true);
  expect(talking.effects).toEqual([{ t: "cancel-speech-idle" }]);

  const quiet = voiceStep(talking.state, { t: "sound-end" }, 10_600);
  expect(quiet.state.speaking).toBe(false);

  // Incoming speech results also activate speaking and schedule a decay back to calm.
  const heard = voiceStep(quiet.state, { t: "rec-result", resultIndex: 0, slices: [{ transcript: "Hello", isFinal: false }] }, 10_800);
  expect(heard.state.speaking).toBe(true);
  expect(heard.effects).toContainEqual({ t: "schedule-speech-idle", ms: SPEECH_IDLE_MS });

  const settled = voiceStep(heard.state, { t: "speech-idle" }, 11_500);
  expect(settled.state.speaking).toBe(false);

  // Shutting off mid-speech clears speaking and cancels the idle timer.
  const off = voiceStep(heard.state, { t: "toggle" }, 11_000);
  expect(off.state.speaking).toBe(false);
  expect(off.effects).toContainEqual({ t: "cancel-speech-idle" });
});

test("post-start audio-capture stays armed across iOS teardown races and prolonged interruptions", () => {
  const { state: mid } = run(initialVoiceState(true), [
    [{ t: "toggle" }, 10_000],
    [{ t: "rec-start" }, 10_100],
    [{ t: "rec-result", resultIndex: 0, slices: [{ transcript: "Also check dark mode", isFinal: false }] }, 15_000],
  ]);
  expect(mid.hasStarted).toBe(true);

  // First audio-capture after healthy uptime (>2s): stays armed, saves interim words, aborts old rec, backs off 400ms.
  const hit1 = voiceStep(mid, { t: "rec-error", code: "audio-capture" }, 15_100);
  expect(hit1.state.phase).toBe("restarting");
  expect(isArmed(hit1.state.phase)).toBe(true);
  expect(hit1.state.committed).toBe("Also check dark mode");
  expect(hit1.state.interim).toBe("");
  expect(hit1.state.retries).toBe(1);
  expect(hit1.state.lastError).toBe("audio-capture");
  expect(hit1.effects).toContainEqual({ t: "stop-rec" });
  expect(hit1.effects).toContainEqual({ t: "schedule-restart", ms: 400 });
  expect(hit1.effects).toContainEqual({ t: "set-input", value: "Also check dark mode", draft: "Also check dark mode" });

  // Trailing rec-end while already restarting must not double-count retries or reset backoff.
  const trailingEnd = voiceStep(hit1.state, { t: "rec-end" }, 15_110);
  expect(trailingEnd.state).toEqual(hit1.state);
  expect(trailingEnd.effects).toEqual([]);

  // Prolonged audio lock (e.g. AirPods switch or phone call): stays armed past 6+ retries at 5s cap.
  let s = hit1.state;
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    s = voiceStep(s, { t: "restart-due" }, 16_000 + i * 1000).state;
    const res = voiceStep(s, { t: "rec-error", code: "audio-capture" }, 16_100 + i * 1000);
    expect(isArmed(res.state.phase)).toBe(true);
    expect(res.state.phase).toBe("restarting");
    const fx = res.effects.find((e) => e.t == "schedule-restart");
    delays.push(fx && fx.t == "schedule-restart" ? fx.ms : -1);
    s = res.state;
  }
  expect(delays).toEqual([800, 1600, 3200, 5000, 5000, 5000]);

  // Recovers cleanly once iOS frees AVAudioSession, preserving saved draft in transcribing phase.
  const due = voiceStep(s, { t: "restart-due" }, 25_000);
  const back = voiceStep(due.state, { t: "rec-start" }, 25_050);
  expect(back.state.phase).toBe("transcribing");
  expect(back.state.lastError).toBeNull();
  expect(back.state.committed).toBe("Also check dark mode");
  expect(back.effects).toContainEqual({ t: "cancel-start-timeout" });
});

test("pre-start audio-capture retries briefly then stops cleanly when no microphone exists", () => {
  let { state } = voiceStep(initialVoiceState(true), { t: "toggle" }, 1000);
  expect(state.hasStarted).toBe(false);

  for (let i = 1; i <= AUDIO_CAPTURE_INIT_RETRIES; i++) {
    const res = voiceStep(state, { t: "rec-error", code: "audio-capture" }, 1000 + i * 500);
    expect(res.state.phase).toBe("restarting");
    expect(isArmed(res.state.phase)).toBe(true);
    expect(res.effects).toContainEqual({ t: "schedule-restart", ms: nextBackoff(i) });
    const due = voiceStep(res.state, { t: "restart-due" }, 1200 + i * 500);
    // Must not arm start-timeout before hasStarted is true (permission dialog may still be open).
    expect(due.effects).toEqual([{ t: "start-rec" }]);
    state = due.state;
  }

  const finalFail = voiceStep(state, { t: "rec-error", code: "audio-capture" }, 5000);
  expect(finalFail.state.phase).toBe("error");
  expect(finalFail.state.error?.code).toBe("audio-capture");
  expect(isArmed(finalFail.state.phase)).toBe(false);
});

test("sync start-failed, zombie start-timeout, no-speech, and service-not-allowed behave cleanly", () => {
  // service-not-allowed before first start is immediately terminal with Dictation guidance.
  const initStart = voiceStep(initialVoiceState(true), { t: "toggle" }, 1000).state;
  const initSvc = voiceStep(initStart, { t: "rec-error", code: "service-not-allowed" }, 1100);
  expect(initSvc.state.phase).toBe("error");
  expect(initSvc.state.error?.code).toBe("service-not-allowed");
  expect(initSvc.state.error?.message).toContain("Dictation");

  // Once started, no-speech does not bump retries, and start-failed schedules backoff immediately (no onend needed).
  const { state: armed } = run(initialVoiceState(true), [
    [{ t: "toggle" }, 2000],
    [{ t: "rec-start" }, 2100],
  ]);
  const quiet = voiceStep(armed, { t: "rec-error", code: "no-speech" }, 2500);
  expect(quiet.state.retries).toBe(0);
  expect(quiet.state.phase).toBe("listening");

  const syncThrow = voiceStep(armed, { t: "rec-error", code: "start-failed" }, 2600);
  expect(syncThrow.state.phase).toBe("restarting");
  expect(syncThrow.effects).toContainEqual({ t: "schedule-restart", ms: 400 });

  // Zombie start after hasStarted fires start-timeout and recovers via abort + backoff.
  const stuck = voiceStep(syncThrow.state, { t: "restart-due" }, 3000);
  expect(stuck.effects).toContainEqual({ t: "schedule-start-timeout", ms: START_TIMEOUT_MS });
  const recovered = voiceStep(stuck.state, { t: "start-timeout" }, 3000 + START_TIMEOUT_MS);
  expect(recovered.state.phase).toBe("restarting");
  expect(recovered.effects).toContainEqual({ t: "stop-rec" });
  expect(recovered.effects).toContainEqual({ t: "schedule-restart", ms: 800 });

  // Mid-session service-not-allowed retries transiently up to 4 times before escalating on 5th.
  let s = run(initialVoiceState(true), [
    [{ t: "toggle" }, 10_000],
    [{ t: "rec-start" }, 10_100],
  ]).state;
  for (let i = 0; i < 4; i++) {
    const r = voiceStep(s, { t: "rec-error", code: "service-not-allowed" }, 10_500 + i * 100);
    expect(isArmed(r.state.phase)).toBe(true);
    s = r.state;
  }
  const fifth = voiceStep(s, { t: "rec-error", code: "service-not-allowed" }, 11_000);
  expect(fifth.state.phase).toBe("error");
  expect(fifth.state.error?.code).toBe("service-not-allowed");
});
