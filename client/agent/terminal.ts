// Lazy-loaded interactive browser terminal pane for connected local bridges
// (herdr-core and rex). Imported dynamically by client/agent/person-agent.ts
// ONLY when a local bridge connects, so normal document views and embedded
// server models pay 0 KB of JS and 0 KB of CSS.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { LocalBridgeView, TerminalSummary } from "../../shared/bridge-protocol";

const STYLE_ID = "erga-term-style";

const TERM_CSS = `
.agent-card.local-terminal > :is(#agent-log, #agent-jump, #agent-turn, #agent-form, .agent-attachments, .agent-voice-queue) { display: none !important; }
.agent-card.local-terminal #agent-reset { display: none; }
.agent-term-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 10px 10px; gap: 6px; }
.agent-term-wrap[hidden] { display: none; }
.agent-term-bar { display: flex; align-items: center; gap: 6px; padding: 2px 2px 0; font: 500 11.5px/1 var(--font-text); color: var(--soft); }
.agent-term-backend { font: 600 10.5px/1 var(--font-mono); padding: 3px 7px; border-radius: 999px; background: color-mix(in srgb, #16a34a 15%, transparent); color: #15803d; }
.agent-term-backend[data-backend="rex"] { background: color-mix(in srgb, #2563eb 15%, transparent); color: #1d4ed8; }
.agent-term-osc { font: 600 10.5px/1 var(--font-mono); padding: 3px 7px; border-radius: 999px; background: var(--code-bg); color: var(--soft); max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-term-osc[data-state="working"] { background: color-mix(in srgb, #2563eb 16%, transparent); color: #2563eb; }
.agent-term-osc[data-state="blocked"] { background: color-mix(in srgb, #d97706 20%, transparent); color: #b45309; }
.agent-term-osc[data-state="done"] { background: color-mix(in srgb, #16a34a 16%, transparent); color: #15803d; }
.agent-term-osc[data-state="error"] { background: color-mix(in srgb, #dc2626 16%, transparent); color: #dc2626; }
.agent-term-sp { flex: 1; }
.agent-term-stop { border: 1px solid var(--panel-border); border-radius: 8px; padding: 3px 8px; background: transparent; color: var(--fg); font: 600 11px/1.2 var(--font-text); cursor: pointer; }
.agent-term-stop:hover { background: var(--code-bg); }
.agent-space-bar { display: flex; align-items: center; gap: 4px; overflow-x: auto; padding: 2px 0; scrollbar-width: none; }
.agent-space-bar::-webkit-scrollbar { display: none; }
.agent-space-bar[hidden] { display: none; }
.agent-space-pill { flex: none; display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--rule); border-radius: 999px; padding: 4px 9px; background: var(--bg); color: var(--soft); font: 500 11.5px/1 var(--font-text); cursor: pointer; transition: background-color 120ms, color 120ms, border-color 120ms; }
.agent-space-pill:hover { color: var(--fg-strong); border-color: var(--chrome); }
.agent-space-pill[aria-pressed="true"] { background: var(--fg-strong); color: var(--bg); border-color: transparent; }
.agent-space-pill i { width: 6px; height: 6px; border-radius: 50%; background: #16a34a; flex: none; }
.agent-space-pill i[data-state="working"] { background: #3b82f6; }
.agent-space-pill i[data-state="blocked"] { background: #f59e0b; box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.35); }
.agent-space-pill i[data-state="error"] { background: #ef4444; }
.agent-space-pill i[data-state="finished"] { background: #9ca3af; }
.agent-term-host { flex: 1; min-height: 160px; position: relative; border-radius: 10px; overflow: hidden; background: #15161a; padding: 6px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08); }
.agent-term-host .xterm { position: relative; width: 100%; height: 100%; user-select: none; -webkit-user-select: none; cursor: text; }
.agent-term-host .xterm.focus, .agent-term-host .xterm:focus { outline: none; }
.agent-term-host .xterm .xterm-helpers { position: absolute; top: 0; z-index: 5; }
.agent-term-host .xterm .xterm-helper-textarea { padding: 0; border: 0; margin: 0; position: absolute; opacity: 0; left: -9999em; top: 0; width: 0; height: 0; z-index: -5; white-space: nowrap; overflow: hidden; resize: none; }
.agent-term-host .xterm .xterm-viewport { background-color: #15161a; overflow-y: auto; cursor: default; position: absolute; inset: 0; }
.agent-term-host .xterm .xterm-screen { position: relative; }
.agent-term-host .xterm .xterm-screen canvas { position: absolute; left: 0; top: 0; }
.agent-term-host .xterm-char-measure-element { display: inline-block; visibility: hidden; position: absolute; top: 0; left: -9999em; line-height: normal; }
.agent-term-host .xterm .xterm-accessibility:not(.debug) { position: absolute; inset: 0; z-index: 10; color: transparent; pointer-events: none; }
.agent-term-empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; text-align: center; color: #9ca3af; font: 12.5px/1.5 var(--font-text); }
.agent-term-empty[hidden] { display: none; }
#agent-fab.blocked { box-shadow: 0 0 0 2.5px #f59e0b, var(--shadow); }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = TERM_CSS;
  document.head.append(style);
}

const utf8Enc = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface TerminalPaneOptions {
  card: HTMLElement;
  before: HTMLElement;
  onAttach(terminal: string, cols: number, rows: number): void;
  onDetach(terminal?: string): void;
  onInput(terminal: string, dataB64: string): void;
  onResize(terminal: string, cols: number, rows: number): void;
  onSelect(terminal: string): void;
  onInterrupt(): void;
}

export interface TerminalPane {
  show(view: LocalBridgeView): void;
  writeData(terminal: string, dataB64: string): void;
  closed(terminal: string, reason?: string): void;
  reattach(): void;
  hide(): void;
  focus(): void;
}

export function mountTerminalPane(opts: TerminalPaneOptions): TerminalPane {
  ensureStyles();

  const wrap = document.createElement("div");
  wrap.className = "agent-term-wrap";
  wrap.id = "agent-term-wrap";
  wrap.hidden = true;
  wrap.innerHTML = `<div class="agent-term-bar"><span class="agent-term-backend" data-backend="herdr-core"></span><span class="agent-term-osc" data-state="idle">7501: idle</span><span class="agent-term-sp"></span><button type="button" class="agent-term-stop" hidden>Stop</button></div><div class="agent-space-bar" role="tablist" aria-label="Space terminals" hidden></div><div class="agent-term-host"><div class="agent-term-empty" hidden>No live terminal attached.</div></div>`;
  opts.card.insertBefore(wrap, opts.before);

  const backendEl = wrap.querySelector<HTMLElement>(".agent-term-backend")!;
  const oscEl = wrap.querySelector<HTMLElement>(".agent-term-osc")!;
  const stopBtn = wrap.querySelector<HTMLButtonElement>(".agent-term-stop")!;
  const spaceBar = wrap.querySelector<HTMLElement>(".agent-space-bar")!;
  const host = wrap.querySelector<HTMLElement>(".agent-term-host")!;
  const emptyEl = wrap.querySelector<HTMLElement>(".agent-term-empty")!;

  const term = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontSize: 12,
    lineHeight: 1.32,
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
    scrollback: 2000,
    theme: {
      background: "#15161a",
      foreground: "#e4e4e7",
      cursor: "#60a5fa",
      selectionBackground: "rgba(96, 165, 250, 0.28)",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  let opened = false;
  let visible = false;
  let currentView: LocalBridgeView | null = null;
  let attachedId: string | null = null;
  let lastSize = { cols: 80, rows: 24 };
  let resizeRaf = 0;

  term.onData((data) => {
    if (!attachedId || !visible) return;
    opts.onInput(attachedId, bytesToBase64(utf8Enc.encode(data)));
  });

  stopBtn.addEventListener("click", () => opts.onInterrupt());

  spaceBar.addEventListener("click", (e) => {
    const btn = (e.target as Element | null)?.closest<HTMLButtonElement>(".agent-space-pill");
    const id = btn?.dataset.terminal;
    if (!id || id == attachedId) return;
    opts.onSelect(id);
    attachTo(id);
  });

  function fitNow(): { cols: number; rows: number } {
    if (!opened) {
      term.open(host);
      opened = true;
    }
    try {
      fit.fit();
    } catch {
      /* container hidden */
    }
    const cols = Math.max(20, term.cols || 80);
    const rows = Math.max(6, term.rows || 24);
    lastSize = { cols, rows };
    return lastSize;
  }

  function attachTo(id: string | null) {
    if (!id) {
      if (attachedId) opts.onDetach(attachedId);
      attachedId = null;
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    const changed = attachedId != id;
    attachedId = id;
    if (changed) term.reset();
    const { cols, rows } = fitNow();
    opts.onAttach(id, cols, rows);
  }

  new ResizeObserver(() => {
    if (!visible || !attachedId) return;
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (!visible || !attachedId) return;
      const prev = lastSize;
      const next = fitNow();
      if (next.cols != prev.cols || next.rows != prev.rows) opts.onResize(attachedId, next.cols, next.rows);
    });
  }).observe(host);

  function renderHeader(view: LocalBridgeView) {
    backendEl.textContent = view.backend;
    backendEl.dataset.backend = view.backend;

    const active = view.terminals.find((t) => t.id == (attachedId ?? view.activeTerminal)) ?? view.terminals[0] ?? null;
    const state = active?.state == "finished" ? "finished" : (active?.status?.state ?? "idle");
    const kind = active?.status?.kind ? ` (${active.status.kind})` : "";
    oscEl.dataset.state = state;
    oscEl.textContent = `7501: ${state}${kind}`;
    oscEl.title = active?.status?.msg || active?.status?.title || oscEl.textContent;
    stopBtn.hidden = state != "working";

    const showSpace = view.scope == "space" || view.terminals.length > 1;
    spaceBar.hidden = !showSpace;
    if (showSpace) {
      spaceBar.textContent = "";
      for (const t of view.terminals) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "agent-space-pill";
        btn.dataset.terminal = t.id;
        btn.setAttribute("role", "tab");
        btn.setAttribute("aria-pressed", String(t.id == (attachedId ?? view.activeTerminal)));
        const dot = document.createElement("i");
        dot.dataset.state = t.state == "finished" ? "finished" : (t.status?.state ?? "idle");
        const label = document.createElement("span");
        label.textContent = t.label;
        btn.append(dot, label);
        spaceBar.append(btn);
      }
    }
  }

  function show(view: LocalBridgeView) {
    const wasVisible = visible;
    currentView = view;
    visible = true;
    wrap.hidden = false;
    opts.card.classList.add("local-terminal");
    const wantId = view.activeTerminal ?? view.terminals[0]?.id ?? null;
    renderHeader(view);
    if (!wasVisible || wantId != attachedId) {
      attachTo(wantId);
    }
  }

  function writeData(terminal: string, dataB64: string) {
    if (!visible || terminal != attachedId) return;
    if (!opened) fitNow();
    try {
      term.write(base64ToBytes(dataB64));
    } catch {
      /* ignore malformed base64 */
    }
  }

  function closed(terminal: string, reason?: string) {
    if (!visible || terminal != attachedId) return;
    term.write(`\r\n\x1b[2m[detached${reason ? `: ${reason}` : ""}]\x1b[0m\r\n`);
  }

  function reattach() {
    if (!visible || !currentView) return;
    const id = attachedId ?? currentView.activeTerminal ?? currentView.terminals[0]?.id ?? null;
    if (!id) return;
    const { cols, rows } = fitNow();
    opts.onAttach(id, cols, rows);
  }

  function hide() {
    if (!visible) return;
    visible = false;
    wrap.hidden = true;
    opts.card.classList.remove("local-terminal");
    if (attachedId) opts.onDetach(attachedId);
    attachedId = null;
    currentView = null;
  }

  function focus() {
    if (visible && opened) term.focus();
  }

  return { show, writeData, closed, reattach, hide, focus };
}

/** Whether any terminal in `view` is currently working or blocked (for FAB badges). */
export function terminalAttention(view: LocalBridgeView | null): { working: boolean; blocked: TerminalSummary | null } {
  if (!view) return { working: false, blocked: null };
  const blocked = view.terminals.find((t) => t.state == "live" && t.status?.state == "blocked") ?? null;
  const working = view.terminals.some((t) => t.state == "live" && t.status?.state == "working");
  return { working, blocked };
}
