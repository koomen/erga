// Voice Mode for the agent panel (client/agent/person-agent.ts): thin browser IO owner around `voiceStep`
// (client/agent/voice-state.ts). Mounts the five-bar waveform toggle button (#agent-voice) between #agent-field and
// #agent-send, and a compact queue strip above #agent-form. Uses the browser's Web Speech API
// (SpeechRecognition / webkitSpeechRecognition) so speech streams live into #agent-input and saying "send prompt"
// dispatches while Voice Mode stays armed until the user turns it off manually.

import { initialVoiceState, isArmed, voiceStep, type SpeechSlice, type VoiceEffect, type VoiceEvent, type VoiceState } from "./voice-state";

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  onstart: (() => void) | null;
  onsoundstart: (() => void) | null;
  onsoundend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((e: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionResultEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: { readonly isFinal: boolean; readonly 0?: { readonly transcript?: string } };
  };
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const speechCtor = (): SpeechRecognitionCtor | null => {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export interface VoiceOptions {
  pane: HTMLElement;
  form: HTMLElement;
  field: HTMLElement;
  input: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  fab: HTMLElement;
  /** Sends a prompt through the panel's existing ask() pipeline. */
  send(text: string): void;
  /** Called whenever speech updates #agent-input, with the committed draft for localStorage. */
  onInput(draft: string | null): void;
  /** Shows an inline hint in #agent-hint. */
  hint(text: string, sticky?: boolean, error?: boolean): void;
  /** Clears a voice-owned sticky error hint when the user toggles or edits. */
  clearVoiceHint(): void;
}

export interface VoiceControl {
  /** True while Voice Mode is armed (listening, transcribing, restarting, starting, or paused while tab hidden). */
  readonly armed: boolean;
  /** True while this module is writing to #agent-input programmatically. */
  readonly writing: boolean;
  /** Syncs current agent busy/asking/off/attachment state into the state machine and refreshes voice chrome. */
  sync(status: { busy: boolean; asking: boolean; off: string | null; readingFiles: number; files: number; holdQueue?: boolean }): void;
  /** Notifies the state machine that the user edited #agent-input manually. */
  inputEdited(value: string): void;
  /** Notifies the state machine that the user submitted #agent-input manually (stays armed). */
  manualSend(): void;
  /** Clears queued voice prompts when starting a new conversation. */
  resetConversation(): void;
}

const WAVE_ICON = `<svg class="voice-wave" viewBox="0 0 24 24" aria-hidden="true"><path class="bar b1" d="M4 10.5v3"/><path class="bar b2" d="M8 7v10"/><path class="bar b3" d="M12 4v16"/><path class="bar b4" d="M16 7v10"/><path class="bar b5" d="M20 10.5v3"/></svg>`;
const WAVE_ERR_ICON = `<svg class="voice-wave" viewBox="0 0 24 24" aria-hidden="true"><path class="bar b1" d="M4 10.5v3"/><path class="bar b2" d="M8 7v10"/><path class="bar b3" d="M12 4v16"/><path class="bar b4" d="M16 7v10"/><path class="bar b5" d="M20 10.5v3"/><path d="M3.5 3.5 20.5 20.5"/></svg>`;

export function mountVoice(o: VoiceOptions): VoiceControl {
  const { pane, form, field, input, sendBtn, fab } = o;

  const queueEl = document.createElement("div");
  queueEl.className = "agent-voice-queue";
  queueEl.hidden = true;
  const queueText = document.createElement("span");
  queueText.className = "queue-text";
  const queueActs = document.createElement("span");
  queueActs.className = "queue-acts";
  const queueNow = Object.assign(document.createElement("button"), { type: "button", textContent: "Send now" });
  const queueDrop = Object.assign(document.createElement("button"), { type: "button", textContent: "×", title: "Remove queued prompt" });
  queueDrop.setAttribute("aria-label", "Remove queued prompt");
  queueActs.append(queueNow, queueDrop);
  queueEl.append(queueText, queueActs);
  form.before(queueEl);

  const btn = Object.assign(document.createElement("button"), {
    type: "button",
    id: "agent-voice",
    className: "icon-btn agent-voice",
  });
  btn.innerHTML = WAVE_ICON;
  sendBtn.before(btn);

  // Lower-left sub-icon on the collapsed agent FAB: blue circle with the animated waveform while Voice Mode stays on.
  const fabVoice = document.createElement("span");
  fabVoice.className = "agent-fab-voice";
  fabVoice.setAttribute("aria-hidden", "true");
  fabVoice.innerHTML = WAVE_ICON;
  pane.append(fabVoice);

  let state: VoiceState = initialVoiceState(!!speechCtor());
  let rec: SpeechRecognitionLike | null = null;
  let restartTimer = 0;
  let interimTimer = 0;
  let speechIdleTimer = 0;
  let writing = false;
  let iconError = false;

  function stopRec() {
    if (!rec) return;
    const old = rec;
    rec = null;
    old.onstart = old.onsoundstart = old.onsoundend = old.onspeechstart = old.onspeechend = old.onresult = old.onerror = old.onend = null;
    try {
      old.stop();
    } catch {
      /* already stopped */
    }
  }

  function startRec() {
    stopRec();
    const Ctor = speechCtor();
    if (!Ctor) {
      dispatch({ t: "rec-error", code: "service-not-allowed" });
      return;
    }
    try {
      const r = new Ctor();
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 1;
      r.lang = navigator.language || "en-US";
      r.onstart = () => dispatch({ t: "rec-start" });
      r.onsoundstart = r.onspeechstart = () => dispatch({ t: "sound-start" });
      r.onsoundend = r.onspeechend = () => dispatch({ t: "sound-end" });
      r.onresult = (e) => {
        const slices: SpeechSlice[] = [];
        for (let i = 0; i < e.results.length; i++) {
          slices[i] = { transcript: e.results[i][0]?.transcript ?? "", isFinal: !!e.results[i].isFinal };
        }
        dispatch({ t: "rec-result", resultIndex: e.resultIndex, slices });
      };
      r.onerror = (e) => dispatch({ t: "rec-error", code: e.error ?? "unknown" });
      r.onend = () => {
        if (rec == r) rec = null;
        dispatch({ t: "rec-end" });
      };
      rec = r;
      r.start();
    } catch (err) {
      const code = err instanceof Error && err.name == "NotAllowedError" ? "not-allowed" : "service-not-allowed";
      dispatch({ t: "rec-error", code });
    }
  }

  function runEffects(effects: VoiceEffect[]) {
    for (const fx of effects) {
      switch (fx.t) {
        case "start-rec":
          startRec();
          break;
        case "stop-rec":
          stopRec();
          break;
        case "flush-rec":
          if (rec) {
            try {
              rec.stop();
            } catch {
              /* already stopping */
            }
          }
          break;
        case "schedule-restart":
          clearTimeout(restartTimer);
          restartTimer = window.setTimeout(() => dispatch({ t: "restart-due" }), fx.ms);
          break;
        case "cancel-restart":
          clearTimeout(restartTimer);
          break;
        case "schedule-interim-trigger":
          clearTimeout(interimTimer);
          interimTimer = window.setTimeout(() => dispatch({ t: "interim-trigger-due" }), fx.ms);
          break;
        case "cancel-interim-trigger":
          clearTimeout(interimTimer);
          break;
        case "schedule-speech-idle":
          clearTimeout(speechIdleTimer);
          speechIdleTimer = window.setTimeout(() => dispatch({ t: "speech-idle" }), fx.ms);
          break;
        case "cancel-speech-idle":
          clearTimeout(speechIdleTimer);
          break;
        case "set-input":
          writing = true;
          input.value = fx.value;
          o.onInput(fx.draft);
          writing = false;
          break;
        case "dispatch-prompt":
          o.send(fx.text);
          break;
        case "hint":
          o.hint(fx.text, fx.sticky, fx.error);
          break;
      }
    }
  }

  function render() {
    const armed = isArmed(state.phase);
    const busy = state.agentBusy || state.agentAsking;
    const speaking = armed && state.speaking;
    const isErr = state.phase == "error";
    if (isErr != iconError) {
      iconError = isErr;
      btn.innerHTML = isErr ? WAVE_ERR_ICON : WAVE_ICON;
    }
    btn.dataset.voice = state.phase;
    btn.dataset.armedBusy = String(armed && busy);
    btn.dataset.speaking = String(speaking);
    btn.setAttribute("aria-pressed", String(armed));
    btn.setAttribute("aria-disabled", String(state.phase == "unsupported"));
    const label =
      state.phase == "unsupported" ? "Voice mode needs Chrome, Edge, or Safari" : armed ? "Stop voice mode" : "Start voice mode";
    btn.title = label;
    btn.setAttribute("aria-label", label);

    field.classList.toggle("voice-live", armed);
    field.classList.toggle("voice-busy", armed && busy);
    if (armed && !state.agentOff) {
      input.placeholder = state.agentAsking
        ? "Waiting for approval…"
        : state.agentBusy
          ? "Voice on · working…"
          : state.phase == "restarting"
            ? "Reconnecting voice…"
            : "Listening…";
    }

    fab.classList.toggle("voice-on", armed);
    fab.setAttribute("aria-label", armed ? "Open the agent (voice mode is on)" : "Open the agent (⌘J)");
    fabVoice.dataset.voiceOn = String(armed);
    fabVoice.dataset.speaking = String(speaking);

    if (state.queue.length > 0) {
      queueEl.hidden = false;
      const head = state.queue[0];
      const suffix = state.agentAsking ? " (waiting for approval)" : state.readingFiles > 0 ? " (reading files…)" : "";
      queueText.textContent = `Queued (${state.queue.length}): “${head.text || "Attachments"}”${suffix}`;
      queueNow.hidden = state.agentAsking || state.readingFiles > 0;
    } else {
      queueEl.hidden = true;
    }
  }

  function dispatch(ev: VoiceEvent) {
    const res = voiceStep(state, ev, Date.now());
    state = res.state;
    runEffects(res.effects);
    render();
  }

  btn.addEventListener("click", () => {
    o.clearVoiceHint();
    // Seed committed from any draft already in the box when arming Voice Mode.
    if (!isArmed(state.phase) && input.value) state = { ...state, committed: input.value, interim: "" };
    dispatch({ t: "toggle" });
  });
  queueNow.addEventListener("click", () => {
    if (state.queue.length) dispatch({ t: "queue-send-now", id: state.queue[0].id });
  });
  queueDrop.addEventListener("click", () => {
    if (state.queue.length) dispatch({ t: "queue-drop", id: state.queue[0].id });
  });
  document.addEventListener("visibilitychange", () => dispatch({ t: "visibility", hidden: document.hidden }));
  window.addEventListener("pagehide", () => stopRec());

  render();

  return {
    get armed() {
      return isArmed(state.phase);
    },
    get writing() {
      return writing;
    },
    sync(status) {
      dispatch({ t: "agent-status", ...status });
    },
    inputEdited(value) {
      dispatch({ t: "input-edited", value });
    },
    manualSend() {
      dispatch({ t: "manual-send" });
    },
    resetConversation() {
      dispatch({ t: "conversation-reset" });
    },
  };
}
