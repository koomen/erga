// Connected local bridges for one person (agents/person/sessions.ts): a pure
// state machine with no IO. A local bridge (herdr-core or rex) connects over
// /api/agent/bridge and binds documents to either a single terminal or a whole
// space. Connected bridges show above built-in models in the panel dropdown
// and expose live OSC 7501 terminal rosters to the browser terminal pane.

import {
  bridgeIdOf,
  isLocalChoice,
  localChoice,
  type AttachScope,
  type BackendKind,
  type LocalBridgeView,
  type PanelOption,
  type TerminalSummary,
} from "../../shared/bridge-protocol.ts";

/** One document's terminal/space binding on a connected bridge. */
export interface DocBinding {
  readonly label?: string;
  readonly scope: AttachScope;
  readonly spaceId: string | null;
  readonly spaceName: string | null;
  readonly terminals: readonly TerminalSummary[];
  readonly activeTerminal: string | null;
}

/** One connected local bridge daemon (herdr-core or rex). */
export interface ConnectedBridge {
  readonly id: string;
  readonly backend: BackendKind;
  readonly label: string;
  readonly version: string;
  readonly grantId: string;
  readonly onlyDoc: string | null;
  /** Documents explicitly bound to this bridge; empty means available on every allowed document. */
  readonly docs: readonly string[];
  /** Per-document terminal/space bindings (keyed by doc id, or "" for global). */
  readonly bindings: Readonly<Record<string, DocBinding>>;
  readonly connectedAt: number;
}

export interface BridgeState {
  readonly bridges: readonly ConnectedBridge[];
  /**
   * Explicit thread selection by thread key (doc id, or "" for non-document pages):
   * - "local:<id>": that connected bridge
   * - "embedded": user explicitly switched back to a built-in server model
   * - absent: default (prefer the best connected bridge for this doc, else embedded)
   */
  readonly picks: Readonly<Record<string, string>>;
}

export const EMPTY_BRIDGES: BridgeState = { bridges: [], picks: {} };

export const EMBEDDED_PICK = "embedded";

export const threadKey = (doc: string | null): string => doc ?? "";

export type BridgeEvent =
  | {
      readonly on: "connect";
      readonly bridge: Omit<ConnectedBridge, "docs" | "bindings"> & { readonly doc?: string | null };
      readonly reconnect?: boolean;
    }
  | {
      readonly on: "bind";
      readonly id: string;
      readonly doc: string;
      readonly label?: string;
      readonly scope: AttachScope;
      readonly spaceId?: string | null;
      readonly spaceName?: string | null;
      readonly terminals: readonly TerminalSummary[];
      readonly activeTerminal?: string | null;
      readonly reconnect?: boolean;
    }
  | {
      readonly on: "terminals";
      readonly id: string;
      readonly doc: string | null;
      readonly terminals: readonly TerminalSummary[];
      readonly spaceName?: string | null;
    }
  | {
      readonly on: "select_terminal";
      readonly id: string;
      readonly doc: string | null;
      readonly terminal: string;
    }
  | { readonly on: "unbind"; readonly id: string; readonly doc: string }
  | { readonly on: "disconnect"; readonly id: string }
  | { readonly on: "select"; readonly doc: string | null; readonly choice: string };

/** Which threads need their open browser tabs updated after a transition ("*" means all). */
export interface BridgeStepResult {
  readonly state: BridgeState;
  readonly notify: readonly (string | "*")[] | null;
  readonly ok: boolean;
}

/** Whether `bridge` may serve `doc`. */
export function allowsDoc(bridge: ConnectedBridge, doc: string | null): boolean {
  if (bridge.onlyDoc != null && bridge.onlyDoc != doc) return false;
  if (bridge.docs.length == 0) return true;
  return doc != null && bridge.docs.includes(doc);
}

/**
 * Connected bridges eligible for `doc`, ordered for display and default selection:
 * bridges explicitly bound to `doc` first, then global bridges; newest first within each group.
 */
export function bridgesFor(state: BridgeState, doc: string | null): ConnectedBridge[] {
  return state.bridges
    .filter((b) => allowsDoc(b, doc))
    .sort((a, b) => {
      const aBound = doc != null && a.docs.includes(doc) ? 1 : 0;
      const bBound = doc != null && b.docs.includes(doc) ? 1 : 0;
      if (aBound != bBound) return bBound - aBound;
      return b.connectedAt - a.connectedAt;
    });
}

const bindingFor = (bridge: ConnectedBridge, doc: string | null): DocBinding | null =>
  (doc != null ? bridge.bindings[doc] : undefined) ?? bridge.bindings[""] ?? null;

/** Display label of `bridge` on `doc`. */
export const bridgeLabelFor = (bridge: ConnectedBridge, doc: string | null): string => bindingFor(bridge, doc)?.label ?? bridge.label;

/** The connected bridge currently active for `doc`, or null when the embedded agent is active. */
export function activeBridge(state: BridgeState, doc: string | null): ConnectedBridge | null {
  const available = bridgesFor(state, doc);
  if (!available.length) return null;
  const pick = state.picks[threadKey(doc)];
  if (pick == EMBEDDED_PICK) return null;
  if (pick && isLocalChoice(pick)) {
    const id = bridgeIdOf(pick);
    const chosen = available.find((b) => b.id == id);
    if (chosen) return chosen;
  }
  return available[0];
}

/** Browser-facing snapshot of the active local bridge on `doc`, or null when embedded is active. */
export function localBridgeView(state: BridgeState, doc: string | null): LocalBridgeView | null {
  const active = activeBridge(state, doc);
  if (!active) return null;
  const binding = bindingFor(active, doc);
  const terminals = binding?.terminals ?? [];
  const activeTerminal =
    binding?.activeTerminal && terminals.some((t) => t.id == binding.activeTerminal)
      ? binding.activeTerminal
      : (terminals.find((t) => t.state == "live")?.id ?? terminals[0]?.id ?? null);
  return {
    bridgeId: active.id,
    backend: active.backend,
    label: bridgeLabelFor(active, doc),
    scope: binding?.scope ?? "single",
    spaceId: binding?.spaceId ?? null,
    spaceName: binding?.spaceName ?? null,
    terminals,
    activeTerminal,
  };
}

/** Combined dropdown options for `doc`: connected local bridges above built-in models. */
export function panelOptions(
  state: BridgeState,
  doc: string | null,
  embedded: readonly { id: string; label: string; key?: "own" | "server" }[]
): PanelOption[] {
  const locals = bridgesFor(state, doc).map(
    (b): PanelOption => ({
      id: localChoice(b.id),
      label: bridgeLabelFor(b, doc),
      group: "local",
      agent: b.backend,
    })
  );
  if (!locals.length) return embedded.map((m) => ({ ...m }));
  return [...locals, ...embedded.map((m): PanelOption => ({ ...m, group: "embedded" }))];
}

function pickActiveTerminal(
  prev: string | null | undefined,
  requested: string | null | undefined,
  terminals: readonly TerminalSummary[]
): string | null {
  if (requested && terminals.some((t) => t.id == requested)) return requested;
  if (prev && terminals.some((t) => t.id == prev)) return prev;
  return terminals.find((t) => t.state == "live")?.id ?? terminals[0]?.id ?? null;
}

/** Pure state transition for connected local bridges, space rosters, and terminal selection. */
export function bridgeStep(state: BridgeState, ev: BridgeEvent): BridgeStepResult {
  switch (ev.on) {
    case "connect": {
      const { doc, ...rest } = ev.bridge;
      const prev = state.bridges.find((b) => b.id == rest.id);
      const docs = doc ? [doc] : rest.onlyDoc ? [rest.onlyDoc] : [];
      const bridge: ConnectedBridge = {
        ...rest,
        docs,
        bindings: prev?.bindings ?? {},
      };
      const bridges = [...state.bridges.filter((b) => b.id != bridge.id), bridge];
      const picks = { ...state.picks };
      if (docs.length) {
        if (!ev.reconnect) for (const d of docs) picks[threadKey(d)] = localChoice(bridge.id);
        return { state: { bridges, picks }, notify: docs, ok: true };
      }
      if (!ev.reconnect) {
        for (const [k, v] of Object.entries(picks)) if (v == EMBEDDED_PICK) delete picks[k];
        picks[""] = localChoice(bridge.id);
      }
      return { state: { bridges, picks }, notify: ["*"], ok: true };
    }
    case "bind": {
      const target = state.bridges.find((b) => b.id == ev.id);
      if (!target || (target.onlyDoc != null && target.onlyDoc != ev.doc)) return { state, notify: null, ok: false };
      const docs = target.docs.includes(ev.doc) ? target.docs : [...target.docs, ev.doc];
      const prevBinding = target.bindings[ev.doc];
      const nextBinding: DocBinding = {
        label: ev.label ?? prevBinding?.label,
        scope: ev.scope,
        spaceId: ev.spaceId ?? null,
        spaceName: ev.spaceName ?? null,
        terminals: ev.terminals,
        activeTerminal: pickActiveTerminal(
          prevBinding?.activeTerminal,
          ev.reconnect ? prevBinding?.activeTerminal : ev.activeTerminal,
          ev.terminals
        ),
      };
      const updated: ConnectedBridge = {
        ...target,
        docs,
        bindings: { ...target.bindings, [ev.doc]: nextBinding },
      };
      const bridges = state.bridges.map((b) => (b.id == ev.id ? updated : b));
      const picks = ev.reconnect ? state.picks : { ...state.picks, [threadKey(ev.doc)]: localChoice(ev.id) };
      return { state: { bridges, picks }, notify: [ev.doc], ok: true };
    }
    case "terminals": {
      const target = state.bridges.find((b) => b.id == ev.id);
      if (!target) return { state, notify: null, ok: false };
      const key = threadKey(ev.doc);
      const prev = target.bindings[key];
      const nextBinding: DocBinding = {
        label: prev?.label,
        scope: prev?.scope ?? (ev.terminals.length > 1 ? "space" : "single"),
        spaceId: prev?.spaceId ?? null,
        spaceName: ev.spaceName !== undefined ? ev.spaceName : (prev?.spaceName ?? null),
        terminals: ev.terminals,
        activeTerminal: pickActiveTerminal(prev?.activeTerminal, null, ev.terminals),
      };
      const updated: ConnectedBridge = {
        ...target,
        bindings: { ...target.bindings, [key]: nextBinding },
      };
      const bridges = state.bridges.map((b) => (b.id == ev.id ? updated : b));
      return { state: { ...state, bridges }, notify: ev.doc ? [ev.doc] : ["*"], ok: true };
    }
    case "select_terminal": {
      const target = state.bridges.find((b) => b.id == ev.id);
      if (!target) return { state, notify: null, ok: false };
      const key = threadKey(ev.doc);
      const prev = target.bindings[key] ?? target.bindings[""];
      if (!prev || !prev.terminals.some((t) => t.id == ev.terminal)) return { state, notify: null, ok: false };
      const updated: ConnectedBridge = {
        ...target,
        bindings: { ...target.bindings, [key]: { ...prev, activeTerminal: ev.terminal } },
      };
      const bridges = state.bridges.map((b) => (b.id == ev.id ? updated : b));
      return { state: { ...state, bridges }, notify: [key], ok: true };
    }
    case "unbind": {
      const target = state.bridges.find((b) => b.id == ev.id);
      if (!target || !target.docs.includes(ev.doc)) return { state, notify: null, ok: false };
      const docs = target.docs.filter((d) => d != ev.doc);
      const bindings = { ...target.bindings };
      delete bindings[ev.doc];
      const bridges = state.bridges.map((b) => (b.id == ev.id ? { ...b, docs, bindings } : b));
      const picks = { ...state.picks };
      if (picks[threadKey(ev.doc)] == localChoice(ev.id)) delete picks[threadKey(ev.doc)];
      return { state: { bridges, picks }, notify: [ev.doc], ok: true };
    }
    case "disconnect": {
      const had = state.bridges.find((b) => b.id == ev.id);
      if (!had) return { state, notify: null, ok: false };
      const bridges = state.bridges.filter((b) => b.id != ev.id);
      const choice = localChoice(ev.id);
      const picks = { ...state.picks };
      for (const [k, v] of Object.entries(picks)) if (v == choice) delete picks[k];
      return { state: { bridges, picks }, notify: had.docs.length ? had.docs : ["*"], ok: true };
    }
    case "select": {
      const key = threadKey(ev.doc);
      if (isLocalChoice(ev.choice)) {
        const id = bridgeIdOf(ev.choice);
        const found = bridgesFor(state, ev.doc).find((b) => b.id == id);
        if (!found) return { state, notify: null, ok: false };
        return { state: { ...state, picks: { ...state.picks, [key]: ev.choice } }, notify: [ev.doc ?? ""], ok: true };
      }
      return { state: { ...state, picks: { ...state.picks, [key]: EMBEDDED_PICK } }, notify: [ev.doc ?? ""], ok: true };
    }
  }
}
