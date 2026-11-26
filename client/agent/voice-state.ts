// Voice Mode for the agent panel (client/agent/voice.ts runs it): one state, one pure step function (`voiceStep`),
// and the spoken `"send prompt"` trigger parser (`parseVoiceTrigger`). No DOM or browser globals here, so every
// transition, backoff curve, queue rule and punctuation quirk tests directly in bun:test.
//
// Phases:
//   unsupported   browser lacks SpeechRecognition / webkitSpeechRecognition (never a silent no: click shows a hint)
//   off           disabled; mic closed
//   starting      armed; waiting for SpeechRecognition.onstart (and permission prompt if first time)
//   listening     armed; mic open and waiting for speech
//   transcribing  armed; live speech (committed and/or interim) is in the compose box
//   restarting    armed; browser ended the session (silence cutoff or transient error), restart timer scheduled
//   paused        armed; tab is hidden (document.hidden), resumes automatically when visible again
//   error         terminal mic failure (not-allowed, audio-capture, or repeated network errors); click retries

export type VoicePhase = "unsupported" | "off" | "starting" | "listening" | "transcribing" | "restarting" | "paused" | "error";

export type VoiceErrorCode = "not-allowed" | "service-not-allowed" | "audio-capture" | "network-fatal";

export interface SpeechSlice {
  readonly transcript: string;
  readonly isFinal: boolean;
}

export interface QueuedPrompt {
  readonly id: string;
  readonly text: string;
}

export interface VoiceState {
  readonly phase: VoicePhase;
  /** Finalized speech and any manual edits currently in #agent-input. */
  readonly committed: string;
  /** Live, unstable speech hypothesis appended after `committed`. */
  readonly interim: string;
  /** Prompts ended with "send prompt" while the agent was busy, asking for approval, or reading attachments. */
  readonly queue: readonly QueuedPrompt[];
  readonly agentBusy: boolean;
  readonly agentAsking: boolean;
  readonly agentOff: string | null;
  readonly readingFiles: number;
  readonly files: number;
  /** Consecutive rapid restarts or transient errors, for exponential backoff. */
  readonly retries: number;
  /** Timestamp (ms) when the current recognition session started, to tell healthy uptime from rapid cutoffs. */
  readonly lastStartedAt: number | null;
  /** Highest SpeechRecognitionResult index already consumed in this recognition session. */
  readonly consumedThrough: number;
  readonly error: { readonly code: VoiceErrorCode; readonly message: string } | null;
}

export type VoiceEvent =
  | { readonly t: "toggle" }
  | { readonly t: "rec-start" }
  | { readonly t: "rec-result"; readonly resultIndex: number; readonly slices: readonly SpeechSlice[] }
  | { readonly t: "rec-end" }
  | { readonly t: "rec-error"; readonly code: string }
  | { readonly t: "restart-due" }
  | { readonly t: "interim-trigger-due" }
  | { readonly t: "input-edited"; readonly value: string }
  | { readonly t: "manual-send" }
  | {
      readonly t: "agent-status";
      readonly busy: boolean;
      readonly asking: boolean;
      readonly off: string | null;
      readonly readingFiles: number;
      readonly files: number;
      /** True after an explicit Stop: keep queued items visible instead of draining at once. */
      readonly holdQueue?: boolean;
    }
  | { readonly t: "queue-send-now"; readonly id: string }
  | { readonly t: "queue-drop"; readonly id: string }
  | { readonly t: "conversation-reset" }
  | { readonly t: "visibility"; readonly hidden: boolean };

export type VoiceEffect =
  | { readonly t: "start-rec" }
  | { readonly t: "stop-rec" }
  | { readonly t: "flush-rec" }
  | { readonly t: "schedule-restart"; readonly ms: number }
  | { readonly t: "cancel-restart" }
  | { readonly t: "schedule-interim-trigger"; readonly ms: number }
  | { readonly t: "cancel-interim-trigger" }
  | { readonly t: "set-input"; readonly value: string; readonly draft: string | null }
  | { readonly t: "dispatch-prompt"; readonly text: string }
  | { readonly t: "hint"; readonly text: string; readonly sticky: boolean; readonly error?: boolean };

const ARMED = new Set<VoicePhase>(["starting", "listening", "transcribing", "restarting", "paused"]);

/** Matches "send prompt" with case-insensitive spelling, recognizer punctuation, and word boundaries. */
const TRIGGER_RE = /(?:^|[\s,.;:!?—–-])send[\s,-]+prompt(?:[.!?,;:\s]+|$)/i;

/** A recognition session that lasted at least this long resets the restart backoff. */
export const HEALTHY_MS = 2000;
/** Delay before a clean restart after a healthy session or silence cutoff. */
export const CLEAN_RESTART_MS = 150;
/** Stability window before firing a trigger phrase that sits only in trailing interim speech. */
export const INTERIM_TRIGGER_MS = 700;

export const isArmed = (phase: VoicePhase): boolean => ARMED.has(phase);

/** Joins two speech segments without double spaces or spaces before punctuation. */
export function joinSpeech(a: string, b: string): string {
  const left = a.trimEnd();
  const right = b.trimStart();
  if (!left) return right;
  if (!right) return left;
  if (/^[,.;:!?)]/.test(right)) return left + right;
  return `${left} ${right}`;
}

export interface TriggerMatch {
  readonly prompt: string;
  readonly remainder: string;
}

/** Extracts the prompt before the first `"send prompt"` phrase and any trailing carry-over speech after it. */
export function parseVoiceTrigger(text: string): TriggerMatch | null {
  const m = TRIGGER_RE.exec(text);
  if (!m) return null;
  const prompt = text
    .slice(0, m.index)
    .replace(/[\s,;—–-]+$/, "")
    .trim();
  const remainder = text.slice(m.index + m[0].length).trimStart();
  return { prompt, remainder };
}

/** Exponential backoff for rapid restarts or transient errors: 250 ms, 500 ms, 1 s, 2 s, 4 s, capped at 5 s. */
export const nextBackoff = (retries: number): number => Math.min(5000, 250 * 2 ** Math.max(0, retries - 1));

export const initialVoiceState = (supported: boolean): VoiceState => ({
  phase: supported ? "off" : "unsupported",
  committed: "",
  interim: "",
  queue: [],
  agentBusy: false,
  agentAsking: false,
  agentOff: null,
  readingFiles: 0,
  files: 0,
  retries: 0,
  lastStartedAt: null,
  consumedThrough: 0,
  error: null,
});

let seq = 0;
const defaultId = () => `v${++seq}`;

function enqueueOrDispatch(s: VoiceState, prompt: string, effects: VoiceEffect[], makeId: () => string): VoiceState {
  if (!prompt.trim() && s.files == 0) {
    effects.push({
      t: "hint",
      text: "Nothing to send yet — speak a message, then say “send prompt”.",
      sticky: false,
    });
    return s;
  }
  if (s.agentOff) {
    effects.push({ t: "hint", text: s.agentOff, sticky: true });
    return { ...s, committed: prompt, interim: "" };
  }
  if (s.agentBusy || s.agentAsking || s.readingFiles > 0) {
    return { ...s, queue: [...s.queue, { id: makeId(), text: prompt }] };
  }
  effects.push({ t: "dispatch-prompt", text: prompt });
  return { ...s, agentBusy: true };
}

export function voiceStep(
  s: VoiceState,
  ev: VoiceEvent,
  now: number,
  makeId: () => string = defaultId
): { state: VoiceState; effects: VoiceEffect[] } {
  const effects: VoiceEffect[] = [];
  const syncInput = (next: VoiceState) => {
    const value = joinSpeech(next.committed, next.interim);
    effects.push({ t: "set-input", value, draft: next.committed || null });
  };

  switch (ev.t) {
    case "toggle": {
      if (s.phase == "unsupported") {
        effects.push({
          t: "hint",
          text: "Voice mode needs a browser with Web Speech recognition (Chrome, Edge, or Safari).",
          sticky: false,
        });
        return { state: s, effects };
      }
      if (isArmed(s.phase)) {
        const merged = joinSpeech(s.committed, s.interim);
        const next: VoiceState = { ...s, phase: "off", committed: merged, interim: "", retries: 0 };
        effects.push({ t: "cancel-restart" }, { t: "cancel-interim-trigger" }, { t: "stop-rec" });
        syncInput(next);
        return { state: next, effects };
      }
      const next: VoiceState = { ...s, phase: "starting", error: null, retries: 0 };
      effects.push({ t: "start-rec" });
      return { state: next, effects };
    }

    case "rec-start": {
      if (!isArmed(s.phase)) return { state: s, effects };
      const phase: VoicePhase = s.committed || s.interim ? "transcribing" : "listening";
      return { state: { ...s, phase, lastStartedAt: now, consumedThrough: 0, error: null }, effects };
    }

    case "rec-result": {
      if (!isArmed(s.phase)) return { state: s, effects };
      let committed = s.committed;
      let interim = "";
      let consumedThrough = s.consumedThrough;
      const start = Math.max(ev.resultIndex, s.consumedThrough);

      for (let i = start; i < ev.slices.length; i++) {
        const slice = ev.slices[i];
        if (!slice) continue;
        if (slice.isFinal) {
          committed = joinSpeech(committed, slice.transcript);
          consumedThrough = i + 1;
        } else {
          interim = joinSpeech(interim, slice.transcript);
        }
      }

      let next: VoiceState = { ...s, committed, interim, consumedThrough, retries: 0 };

      // 1. Immediate dispatch on finalized trigger.
      const finalMatch = parseVoiceTrigger(next.committed);
      if (finalMatch) {
        effects.push({ t: "cancel-interim-trigger" });
        next = { ...next, committed: finalMatch.remainder, interim: "" };
        next = enqueueOrDispatch(next, finalMatch.prompt, effects, makeId);
        next = { ...next, phase: next.committed ? "transcribing" : "listening" };
        syncInput(next);
        return { state: next, effects };
      }

      // 2. Debounced dispatch when trigger sits only in trailing interim speech.
      const combined = joinSpeech(next.committed, next.interim);
      if (next.interim && parseVoiceTrigger(combined)) effects.push({ t: "schedule-interim-trigger", ms: INTERIM_TRIGGER_MS });
      else effects.push({ t: "cancel-interim-trigger" });

      next = { ...next, phase: combined ? "transcribing" : "listening" };
      syncInput(next);
      return { state: next, effects };
    }

    case "interim-trigger-due": {
      if (!isArmed(s.phase)) return { state: s, effects };
      const combined = joinSpeech(s.committed, s.interim);
      const match = parseVoiceTrigger(combined);
      if (!match) return { state: s, effects };
      let next: VoiceState = {
        ...s,
        committed: match.remainder,
        interim: "",
        // Guard past any pending in-flight results from this utterance while the recognizer flushes.
        consumedThrough: s.consumedThrough + 100,
      };
      next = enqueueOrDispatch(next, match.prompt, effects, makeId);
      next = { ...next, phase: next.committed ? "transcribing" : "listening" };
      syncInput(next);
      effects.push({ t: "flush-rec" });
      return { state: next, effects };
    }

    case "rec-error": {
      if (!isArmed(s.phase)) return { state: s, effects };
      const code = ev.code || "unknown";
      if (code == "not-allowed" || code == "service-not-allowed" || code == "audio-capture") {
        const message =
          code == "audio-capture"
            ? "No microphone was found. Connect a microphone, then click the voice mode button again."
            : "Microphone access is blocked. Allow mic access in your browser's site settings, then click the voice mode button again.";
        const merged = joinSpeech(s.committed, s.interim);
        const next: VoiceState = { ...s, phase: "error", committed: merged, interim: "", error: { code, message } };
        effects.push(
          { t: "cancel-restart" },
          { t: "cancel-interim-trigger" },
          { t: "stop-rec" },
          { t: "hint", text: message, sticky: true, error: true }
        );
        syncInput(next);
        return { state: next, effects };
      }
      if (code == "network" && s.retries >= 4) {
        const message =
          "Voice recognition could not reach the browser's speech service. Check your connection, then click the voice mode button to retry.";
        const next: VoiceState = { ...s, phase: "error", error: { code: "network-fatal", message } };
        effects.push(
          { t: "cancel-restart" },
          { t: "cancel-interim-trigger" },
          { t: "stop-rec" },
          { t: "hint", text: message, sticky: true, error: true }
        );
        return { state: next, effects };
      }
      return { state: { ...s, retries: s.retries + 1 }, effects };
    }

    case "rec-end": {
      if (!isArmed(s.phase) || s.phase == "paused") return { state: s, effects };
      const healthy = s.lastStartedAt != null && now - s.lastStartedAt >= HEALTHY_MS;
      const retries = healthy ? 0 : s.retries + 1;
      const ms = healthy ? CLEAN_RESTART_MS : nextBackoff(retries);
      effects.push({ t: "cancel-interim-trigger" }, { t: "schedule-restart", ms });
      return { state: { ...s, phase: "restarting", retries, lastStartedAt: null, interim: "" }, effects };
    }

    case "restart-due": {
      if (s.phase != "restarting") return { state: s, effects };
      effects.push({ t: "start-rec" });
      return { state: { ...s, phase: "starting" }, effects };
    }

    case "visibility": {
      if (!isArmed(s.phase)) return { state: s, effects };
      if (ev.hidden) {
        effects.push({ t: "cancel-restart" }, { t: "cancel-interim-trigger" }, { t: "stop-rec" });
        return { state: { ...s, phase: "paused" }, effects };
      }
      if (s.phase == "paused") {
        effects.push({ t: "start-rec" });
        return { state: { ...s, phase: "starting" }, effects };
      }
      return { state: s, effects };
    }

    case "input-edited": {
      effects.push({ t: "cancel-interim-trigger" });
      const phase: VoicePhase =
        s.phase == "listening" || s.phase == "transcribing" ? (ev.value.trim() ? "transcribing" : "listening") : s.phase;
      return { state: { ...s, committed: ev.value, interim: "", phase }, effects };
    }

    case "manual-send": {
      effects.push({ t: "cancel-interim-trigger" });
      const next: VoiceState = { ...s, committed: "", interim: "", phase: s.phase == "transcribing" ? "listening" : s.phase };
      return { state: next, effects };
    }

    case "agent-status": {
      let next: VoiceState = {
        ...s,
        agentBusy: ev.busy,
        agentAsking: ev.asking,
        agentOff: ev.off,
        readingFiles: ev.readingFiles,
        files: ev.files,
      };
      if (!next.agentBusy && !next.agentAsking && !next.agentOff && next.readingFiles == 0 && next.queue.length > 0 && !ev.holdQueue) {
        const [head, ...rest] = next.queue;
        next = { ...next, queue: rest, agentBusy: true };
        effects.push({ t: "dispatch-prompt", text: head.text });
      }
      return { state: next, effects };
    }

    case "queue-send-now": {
      const item = s.queue.find((q) => q.id == ev.id);
      if (!item) return { state: s, effects };
      const rest = s.queue.filter((q) => q.id != ev.id);
      effects.push({ t: "dispatch-prompt", text: item.text });
      return { state: { ...s, queue: rest, agentBusy: true }, effects };
    }

    case "queue-drop":
      return { state: { ...s, queue: s.queue.filter((q) => q.id != ev.id) }, effects };

    case "conversation-reset":
      return { state: { ...s, queue: [] }, effects };
  }
}
