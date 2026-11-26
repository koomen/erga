// Connected local agents for one person (agents/person/sessions.ts): a pure
// state machine with no IO. A local bridge connects over /api/agent/bridge and
// advertises itself (globally, or bound to specific documents). Connected
// agents show above built-in models in the panel dropdown, become the default
// when connected, and keep their own conversation scope apart from the
// embedded agent's.

import { bridgeIdOf, isLocalChoice, localChoice, type PanelOption } from "../../shared/bridge-protocol.ts";

/** One connected local agent bridge. */
export interface ConnectedBridge {
  readonly id: string;
  readonly agent: string;
  readonly label: string;
  readonly grantId: string;
  readonly onlyDoc: string | null;
  /** Documents explicitly bound to this bridge; empty means available on every allowed document. */
  readonly docs: readonly string[];
  /** Optional per-document display label override. */
  readonly docLabels: Readonly<Record<string, string>>;
  readonly sessionId: string | null;
  readonly cwd: string | null;
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

/** Separate ChatTables scope for one connected bridge on one thread. */
export const localScopeOf = (login: string, doc: string | null, bridgeId: string): string =>
  doc ? `local:${bridgeId}:${doc}:${login}` : `local:${bridgeId}:you:${login}`;

export type BridgeEvent =
  | {
      readonly on: "connect";
      readonly bridge: Omit<ConnectedBridge, "docs" | "docLabels"> & { readonly doc?: string | null };
      readonly reconnect?: boolean;
    }
  | {
      readonly on: "bind";
      readonly id: string;
      readonly doc: string;
      readonly label?: string;
      readonly sessionId?: string | null;
      readonly cwd?: string | null;
      readonly reconnect?: boolean;
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

/** Display label of `bridge` on `doc`. */
export const bridgeLabelFor = (bridge: ConnectedBridge, doc: string | null): string =>
  (doc != null ? bridge.docLabels[doc] : undefined) ?? bridge.label;

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

/** Combined dropdown options for `doc`: connected local agents above built-in models. */
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
      agent: b.agent,
    })
  );
  if (!locals.length) return embedded.map((m) => ({ ...m }));
  return [...locals, ...embedded.map((m): PanelOption => ({ ...m, group: "embedded" }))];
}

/** Pure state transition for connected local bridges and thread selection. */
export function bridgeStep(state: BridgeState, ev: BridgeEvent): BridgeStepResult {
  switch (ev.on) {
    case "connect": {
      const { doc, ...rest } = ev.bridge;
      const prev = state.bridges.find((b) => b.id == rest.id);
      const docs = doc ? [doc] : rest.onlyDoc ? [rest.onlyDoc] : [];
      const bridge: ConnectedBridge = {
        ...rest,
        docs,
        docLabels: prev?.docLabels ?? {},
      };
      const bridges = [...state.bridges.filter((b) => b.id != bridge.id), bridge];
      // When a local agent connects initially, switch/default affected threads to it; a transient reconnect keeps explicit picks.
      const picks = { ...state.picks };
      if (docs.length) {
        if (!ev.reconnect) {
          for (const d of docs) picks[threadKey(d)] = localChoice(bridge.id);
        }
        return { state: { bridges, picks }, notify: docs, ok: true };
      }
      if (!ev.reconnect) {
        // Global bridge: clear any prior "embedded" pins so open threads default to the newly connected agent.
        for (const [k, v] of Object.entries(picks)) {
          if (v == EMBEDDED_PICK) delete picks[k];
        }
        picks[""] = localChoice(bridge.id);
      }
      return { state: { bridges, picks }, notify: ["*"], ok: true };
    }
    case "bind": {
      const target = state.bridges.find((b) => b.id == ev.id);
      if (!target || (target.onlyDoc != null && target.onlyDoc != ev.doc)) return { state, notify: null, ok: false };
      const docs = target.docs.includes(ev.doc) ? target.docs : [...target.docs, ev.doc];
      const docLabels = ev.label ? { ...target.docLabels, [ev.doc]: ev.label } : target.docLabels;
      const updated: ConnectedBridge = {
        ...target,
        docs,
        docLabels,
        sessionId: ev.sessionId !== undefined ? ev.sessionId : target.sessionId,
        cwd: ev.cwd !== undefined ? ev.cwd : target.cwd,
      };
      const bridges = state.bridges.map((b) => (b.id == ev.id ? updated : b));
      const picks = ev.reconnect ? state.picks : { ...state.picks, [threadKey(ev.doc)]: localChoice(ev.id) };
      return { state: { bridges, picks }, notify: [ev.doc], ok: true };
    }
    case "unbind": {
      const target = state.bridges.find((b) => b.id == ev.id);
      if (!target || !target.docs.includes(ev.doc)) return { state, notify: null, ok: false };
      const docs = target.docs.filter((d) => d != ev.doc);
      const docLabels = { ...target.docLabels };
      delete docLabels[ev.doc];
      const bridges = state.bridges.map((b) => (b.id == ev.id ? { ...b, docs, docLabels } : b));
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
