// Connected local agents for one person (agents/person/sessions.ts): a pure
// state machine with no IO. A local ACP bridge connects over /api/agent/bridge
// and advertises itself (globally, or bound to specific documents). Connected
// agents show above built-in models in the panel dropdown, become the default
// when connected, keep their own per-session conversation scope apart from the
// embedded agent's, and stay selected (never auto-switching) when disconnected.

import { bridgeIdOf, EMBEDDED_THREAD, isLocalChoice, localChoice, localThreadKey, type PanelOption } from "../../shared/bridge-protocol.ts";

/** One connected local agent bridge. */
export interface ConnectedBridge {
  readonly id: string;
  readonly agent: string;
  readonly label: string;
  readonly version: string;
  readonly grantId: string;
  readonly onlyDoc: string | null;
  /** Documents explicitly bound to this bridge; empty means available on every allowed document. */
  readonly docs: readonly string[];
  /** Optional per-document display label override. */
  readonly docLabels: Readonly<Record<string, string>>;
  /** Per-document thread identity (sessionId or per-bind UUID) so each local session gets its own thread. */
  readonly docThreads: Readonly<Record<string, string>>;
  /** Default thread identity for this bridge connection (global / unbound documents). */
  readonly threadId: string;
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly connectedAt: number;
}

/** Disconnected local agent metadata retained per thread so the panel never auto-switches away. */
export interface DisconnectedBridge {
  readonly id: string;
  readonly agent: string;
  readonly label: string;
  readonly threadId: string;
  readonly disconnectedAt: number;
}

export interface BridgeState {
  readonly bridges: readonly ConnectedBridge[];
  /**
   * Explicit thread selection by thread key (doc id, or "" for non-document pages):
   * - "local:<id>": that local bridge (connected or retained while disconnected)
   * - "embedded": user explicitly switched back to a built-in server model
   * - absent: default (prefer the best connected bridge for this doc, else global disconnected, else embedded)
   */
  readonly picks: Readonly<Record<string, string>>;
  /**
   * Disconnected local agent retained per thread key (doc id, "" for non-document pages, or "*" for an unbound
   * global bridge that went offline while active by default).
   */
  readonly disconnected: Readonly<Record<string, DisconnectedBridge>>;
}

export const EMPTY_BRIDGES: BridgeState = { bridges: [], picks: {}, disconnected: {} };

export const EMBEDDED_PICK = "embedded";

export const threadKey = (doc: string | null): string => doc ?? "";

/** Thread identity of `bridge` on `doc`. */
export const bridgeThreadId = (bridge: ConnectedBridge, doc: string | null): string =>
  (doc != null ? bridge.docThreads[doc] : undefined) ?? bridge.threadId;

/** Stable wire/client thread identifier for the active agent on `doc`. */
export const threadKeyFor = (bridge: ConnectedBridge | null, doc: string | null): string =>
  bridge ? localThreadKey(bridge.id, bridgeThreadId(bridge, doc)) : EMBEDDED_THREAD;

/** Separate ChatTables scope for one connected bridge session on one document. */
export const localScopeOf = (login: string, doc: string | null, bridgeId: string, threadId: string): string =>
  doc ? `local:${bridgeId}:${threadId}:${doc}:${login}` : `local:${bridgeId}:${threadId}:you:${login}`;

export type BridgeEvent =
  | {
      readonly on: "connect";
      readonly bridge: Omit<ConnectedBridge, "docs" | "docLabels" | "docThreads" | "threadId"> & {
        readonly doc?: string | null;
        readonly threadId?: string | null;
      };
      readonly fallbackThreadId: string;
      readonly reconnect?: boolean;
    }
  | {
      readonly on: "bind";
      readonly id: string;
      readonly doc: string;
      readonly label?: string;
      readonly sessionId?: string | null;
      readonly threadId?: string | null;
      readonly fallbackThreadId: string;
      readonly cwd?: string | null;
      readonly reconnect?: boolean;
    }
  | { readonly on: "unbind"; readonly id: string; readonly doc: string; readonly now?: number }
  | { readonly on: "reset"; readonly id: string; readonly doc: string | null; readonly nextThreadId: string }
  | { readonly on: "disconnect"; readonly id: string; readonly now?: number }
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
  const discId = state.disconnected[threadKey(doc)]?.id;
  return state.bridges
    .filter((b) => allowsDoc(b, doc) && b.id != discId)
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

/** The connected bridge currently active for `doc`, or null when disconnected or embedded is active. */
export function activeBridge(state: BridgeState, doc: string | null): ConnectedBridge | null {
  const key = threadKey(doc);
  const pick = state.picks[key];
  if (pick == EMBEDDED_PICK) return null;
  const available = bridgesFor(state, doc);
  if (pick && isLocalChoice(pick)) {
    const id = bridgeIdOf(pick);
    const chosen = available.find((b) => b.id == id);
    if (chosen) return chosen;
    if (state.disconnected[key]?.id == id) return null;
  }
  if (!available.length) return null;
  return available[0];
}

/** The disconnected local bridge retained for `doc` (never auto-switched), or null. */
export function disconnectedBridge(state: BridgeState, doc: string | null): DisconnectedBridge | null {
  const key = threadKey(doc);
  const pick = state.picks[key];
  if (pick == EMBEDDED_PICK) return null;
  const available = bridgesFor(state, doc);
  if (pick && isLocalChoice(pick)) {
    const id = bridgeIdOf(pick);
    if (available.some((b) => b.id == id)) return null;
    const disc = state.disconnected[key];
    if (disc && disc.id == id) return disc;
  }
  if (!pick && !available.length && state.disconnected["*"]) return state.disconnected["*"];
  return null;
}

/** Whether `doc` is currently on a local agent thread (either connected or retained while disconnected). */
export const isLocalSelected = (state: BridgeState, doc: string | null): boolean =>
  activeBridge(state, doc) !== null || disconnectedBridge(state, doc) !== null;

/** Wire/client thread key currently selected for `doc` (connected local, disconnected local, or embedded). */
export function selectedThreadKey(state: BridgeState, doc: string | null): string {
  const active = activeBridge(state, doc);
  if (active) return threadKeyFor(active, doc);
  const disc = disconnectedBridge(state, doc);
  if (disc) return localThreadKey(disc.id, disc.threadId);
  return EMBEDDED_THREAD;
}

/** Combined dropdown options for `doc`: connected (and selected disconnected) local agents above built-in models. */
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
  const disc = disconnectedBridge(state, doc);
  if (disc && !locals.some((o) => o.id == localChoice(disc.id))) {
    locals.unshift({
      id: localChoice(disc.id),
      label: disc.label,
      group: "local",
      agent: disc.agent,
      disconnected: true,
    });
  }
  if (!locals.length) return embedded.map((m) => ({ ...m }));
  return [...locals, ...embedded.map((m): PanelOption => ({ ...m, group: "embedded" }))];
}

/** Pure state transition for connected local bridges, retained disconnects, and thread selection. */
export function bridgeStep(state: BridgeState, ev: BridgeEvent): BridgeStepResult {
  switch (ev.on) {
    case "connect": {
      const { doc, threadId: incomingThreadId, ...rest } = ev.bridge;
      const prev = state.bridges.find((b) => b.id == rest.id);
      const prevDiscFor = (k: string) => (state.disconnected[k]?.id == rest.id ? state.disconnected[k] : undefined);
      const prevGlobalDisc = prevDiscFor("*") ?? prevDiscFor("");
      const docs = doc ? [doc] : rest.onlyDoc ? [rest.onlyDoc] : [];
      const threadId =
        rest.sessionId ||
        incomingThreadId ||
        (ev.reconnect ? (prev?.threadId ?? prevGlobalDisc?.threadId) : undefined) ||
        ev.fallbackThreadId;
      const docThreads: Record<string, string> = ev.reconnect && prev ? { ...prev.docThreads } : {};
      for (const d of docs) {
        const k = threadKey(d);
        docThreads[d] =
          rest.sessionId || incomingThreadId || (ev.reconnect ? (prev?.docThreads[d] ?? prevDiscFor(k)?.threadId) : undefined) || threadId;
      }
      const bridge: ConnectedBridge = {
        ...rest,
        docs,
        docLabels: prev?.docLabels ?? {},
        docThreads,
        threadId,
      };
      const bridges = [...state.bridges.filter((b) => b.id != bridge.id), bridge];
      const picks = { ...state.picks };
      const disconnected = { ...state.disconnected };
      if (docs.length) {
        for (const d of docs) {
          const k = threadKey(d);
          if (!ev.reconnect) {
            picks[k] = localChoice(bridge.id);
            delete disconnected[k];
          } else if (disconnected[k]?.id == bridge.id) {
            delete disconnected[k];
          }
        }
        return { state: { bridges, picks, disconnected }, notify: docs, ok: true };
      }
      for (const [k, d] of Object.entries(disconnected)) {
        if (d.id == bridge.id || !ev.reconnect) delete disconnected[k];
      }
      if (!ev.reconnect) {
        for (const [k, v] of Object.entries(picks)) {
          if (v == EMBEDDED_PICK) delete picks[k];
        }
        picks[""] = localChoice(bridge.id);
      }
      return { state: { bridges, picks, disconnected }, notify: ["*"], ok: true };
    }
    case "bind": {
      const target = state.bridges.find((b) => b.id == ev.id);
      if (!target || (target.onlyDoc != null && target.onlyDoc != ev.doc)) return { state, notify: null, ok: false };
      const key = threadKey(ev.doc);
      const prevDisc = state.disconnected[key]?.id == ev.id ? state.disconnected[key] : undefined;
      const docs = target.docs.includes(ev.doc) ? target.docs : [...target.docs, ev.doc];
      const docLabels = ev.label ? { ...target.docLabels, [ev.doc]: ev.label } : target.docLabels;
      const nextThread =
        ev.sessionId ||
        ev.threadId ||
        (ev.reconnect ? (target.docThreads[ev.doc] ?? prevDisc?.threadId) : undefined) ||
        ev.fallbackThreadId;
      const docThreads = { ...target.docThreads, [ev.doc]: nextThread };
      const updated: ConnectedBridge = {
        ...target,
        docs,
        docLabels,
        docThreads,
        sessionId: ev.sessionId !== undefined ? ev.sessionId : target.sessionId,
        cwd: ev.cwd !== undefined ? ev.cwd : target.cwd,
      };
      const bridges = state.bridges.map((b) => (b.id == ev.id ? updated : b));
      const picks = ev.reconnect ? state.picks : { ...state.picks, [key]: localChoice(ev.id) };
      const disconnected = { ...state.disconnected };
      if (!ev.reconnect || disconnected[key]?.id == ev.id) delete disconnected[key];
      return { state: { bridges, picks, disconnected }, notify: [ev.doc], ok: true };
    }
    case "unbind": {
      const target = state.bridges.find((b) => b.id == ev.id);
      if (!target || !target.docs.includes(ev.doc)) return { state, notify: null, ok: false };
      const key = threadKey(ev.doc);
      const wasActive = activeBridge(state, ev.doc)?.id == ev.id;
      const docs = target.docs.filter((d) => d != ev.doc);
      const docLabels = { ...target.docLabels };
      delete docLabels[ev.doc];
      const docThreads = { ...target.docThreads };
      delete docThreads[ev.doc];
      const bridges = state.bridges.map((b) => (b.id == ev.id ? { ...b, docs, docLabels, docThreads } : b));
      const picks = { ...state.picks };
      const disconnected = { ...state.disconnected };
      if (wasActive) {
        picks[key] = localChoice(ev.id);
        disconnected[key] = {
          id: ev.id,
          agent: target.agent,
          label: bridgeLabelFor(target, ev.doc),
          threadId: bridgeThreadId(target, ev.doc),
          disconnectedAt: ev.now ?? 0,
        };
      } else if (picks[key] == localChoice(ev.id)) {
        delete picks[key];
      }
      return { state: { bridges, picks, disconnected }, notify: [ev.doc], ok: true };
    }
    case "reset": {
      const target = state.bridges.find((b) => b.id == ev.id);
      if (!target) return { state, notify: null, ok: false };
      const updated: ConnectedBridge =
        ev.doc != null
          ? { ...target, docThreads: { ...target.docThreads, [ev.doc]: ev.nextThreadId } }
          : { ...target, threadId: ev.nextThreadId };
      const bridges = state.bridges.map((b) => (b.id == ev.id ? updated : b));
      return { state: { ...state, bridges }, notify: [ev.doc ?? ""], ok: true };
    }
    case "disconnect": {
      const had = state.bridges.find((b) => b.id == ev.id);
      if (!had) return { state, notify: null, ok: false };
      const bridges = state.bridges.filter((b) => b.id != ev.id);
      const choice = localChoice(ev.id);
      const picks = { ...state.picks };
      const disconnected = { ...state.disconnected };
      const at = ev.now ?? 0;
      const record = (doc: string | null) => {
        const k = threadKey(doc);
        picks[k] = choice;
        disconnected[k] = {
          id: had.id,
          agent: had.agent,
          label: bridgeLabelFor(had, doc),
          threadId: bridgeThreadId(had, doc),
          disconnectedAt: at,
        };
      };
      for (const d of had.docs) {
        if (activeBridge(state, d)?.id == had.id) record(d);
      }
      for (const [k, v] of Object.entries(state.picks)) {
        if (v == choice && !disconnected[k]) record(k || null);
      }
      if (had.docs.length == 0) {
        if (activeBridge(state, null)?.id == had.id) record(null);
        if (had.onlyDoc == null && !bridges.some((b) => b.docs.length == 0 && b.onlyDoc == null)) {
          disconnected["*"] = {
            id: had.id,
            agent: had.agent,
            label: had.label,
            threadId: had.threadId,
            disconnectedAt: at,
          };
        }
      }
      return { state: { bridges, picks, disconnected }, notify: had.docs.length ? had.docs : ["*"], ok: true };
    }
    case "select": {
      const key = threadKey(ev.doc);
      const disconnected = { ...state.disconnected };
      if (isLocalChoice(ev.choice)) {
        const id = bridgeIdOf(ev.choice);
        const found = bridgesFor(state, ev.doc).find((b) => b.id == id);
        if (!found) return { state, notify: null, ok: false };
        delete disconnected[key];
        return { state: { ...state, picks: { ...state.picks, [key]: ev.choice }, disconnected }, notify: [ev.doc ?? ""], ok: true };
      }
      delete disconnected[key];
      return { state: { ...state, picks: { ...state.picks, [key]: EMBEDDED_PICK }, disconnected }, notify: [ev.doc ?? ""], ok: true };
    }
  }
}
