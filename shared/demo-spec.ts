// Declarative specification and pure lifecycle state machine for verified
// architecture demos. Human and agent authors choose zoom level, layout, and
// story; the verification harness (dev/verify-demo.ts) checks every structural
// binding, auth gate outcome, wire frame, state transition, lifecycle
// precondition, and execution trace against Erga's real codebase.

import * as Schema from "effect/Schema";

/** "proposal" allows explicit `planned: true` items for unimplemented designs; "verified" requires 100% grounding. */
export type DemoStatus = "proposal" | "verified";

/** Code-derived constants pulled directly from Erga's codebase so demos cannot drift. */
export type CodeRef =
  | "gate.SIGN_IN_DAYS"
  | "gate.SIGN_IN_DAYS_MAX"
  | "gate.GRANT_DAYS"
  | "gate.openPaths"
  | "gate.accessOpen"
  | "gate.cookies";

export interface RefValue {
  readonly $ref: CodeRef;
}

export type Proto = "http" | "ws" | "acp" | "mcp" | "yjs" | "fs" | "sql" | "rpc" | "r2" | "browser";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "WS";

/** Explicit finite lifecycle states for a stateful node (e.g. absent -> installed -> mounted). */
export interface NodeLifecycle {
  readonly states: readonly string[];
  readonly initial: string;
  /** States in which this node may emit a hop (defaults to all non-"absent" states). */
  readonly canEmit?: readonly string[];
  /** States in which this node may receive a hop (defaults to all non-"absent" states). */
  readonly canReceive?: readonly string[];
}

/** Real codebase artifacts a diagram node projects from. */
export interface NodeBinding {
  readonly files?: readonly string[];
  readonly exports?: readonly { readonly file: string; readonly symbol: string }[];
  readonly bindings?: readonly string[];
  readonly tables?: readonly string[];
  readonly machines?: readonly string[];
  readonly planned?: boolean;
}

export interface DemoNode {
  readonly title: string;
  readonly kind?: string;
  readonly zone?: string;
  readonly bindsTo?: NodeBinding;
  readonly lifecycle?: NodeLifecycle;
  readonly openPaths?: readonly string[] | RefValue;
  readonly constants?: Readonly<Record<string, number | string | RefValue>>;
  readonly planned?: boolean;
}

export interface DemoWire {
  readonly from: string;
  readonly to: string;
  readonly proto: Proto;
  readonly label?: string;
  readonly planned?: boolean;
}

export interface GateExpect {
  readonly do: "forward" | "respond" | "exchange" | "body";
  readonly status?: number;
  readonly caller?: "none" | "member" | "person" | "agent";
}

export interface BridgeFrameCheck {
  readonly direction: "fromBridge" | "toBridge";
  readonly frame: Readonly<Record<string, unknown>>;
}

export interface MachineCheck {
  readonly machine: "updateStep" | "bridgeStep" | "blockedStep" | "threadEventStep";
  readonly state: Readonly<Record<string, unknown>>;
  readonly event: Readonly<Record<string, unknown>>;
  readonly expectAt?: string;
  readonly expectExpand?: boolean;
  readonly expectAccept?: boolean;
  readonly expectOk?: boolean;
  readonly expectThread?: string | null;
}

export interface TraceMatch {
  readonly from?: string;
  readonly to?: string;
  readonly proto?: string;
  readonly op?: string;
  readonly path?: string;
  readonly status?: number;
}

export interface StepEffects {
  readonly setState?: Readonly<Record<string, string>>;
  readonly gain?: readonly string[];
  readonly lose?: readonly string[];
}

export interface HopStep {
  readonly kind: "hop";
  readonly wire: string;
  readonly from: string;
  readonly to: string;
  readonly via?: string;
  readonly proto: Proto;
  readonly method?: HttpMethod;
  readonly path?: string;
  readonly host?: "shell" | "content" | "accept";
  readonly secFetchDest?: "document" | "iframe" | "empty";
  readonly authHeader?: "agent" | "none";
  readonly label: string;
  readonly requires?: {
    readonly fromState?: string;
    readonly toState?: string;
    readonly holds?: readonly string[];
  };
  readonly effects?: StepEffects;
  readonly gateExpect?: GateExpect;
  readonly bridgeFrame?: BridgeFrameCheck;
  readonly machineCheck?: MachineCheck;
  readonly traceMatch?: TraceMatch;
  readonly planned?: boolean;
}

export interface StateStep {
  readonly kind: "state";
  readonly label?: string;
  readonly effects: StepEffects;
  readonly machineCheck?: MachineCheck;
  readonly planned?: boolean;
}

export interface BranchStep {
  readonly kind: "branch";
  readonly when: (combo: Readonly<Record<string, string>>) => boolean;
  readonly steps: readonly DemoStep[];
  readonly otherwise?: readonly DemoStep[];
}

export interface ParallelStep {
  readonly kind: "parallel";
  readonly branches: readonly (readonly DemoStep[])[];
}

export type DemoStep = HopStep | StateStep | BranchStep | ParallelStep;

/** Intentional pedagogical omission from a real execution trace, with a one-line reason. */
export interface ElidedEvent {
  readonly op: string;
  readonly proto?: string;
  readonly why: string;
}

export interface DemoScene {
  readonly id: string;
  readonly label: string;
  readonly traceId?: string;
  readonly elided?: readonly ElidedEvent[];
  readonly steps: readonly DemoStep[];
}

export interface DemoMatrix {
  readonly axes: Readonly<Record<string, readonly string[]>>;
  readonly valid?: (combo: Readonly<Record<string, string>>) => boolean;
}

export interface DemoSpec {
  readonly id: string;
  readonly title: string;
  readonly status: DemoStatus;
  readonly matrix: DemoMatrix;
  readonly nodes: Readonly<Record<string, DemoNode>>;
  readonly wires: Readonly<Record<string, DemoWire>>;
  /** Maps trace actor/component names onto diagram node IDs (defaults to identity). */
  readonly projection?: Readonly<Record<string, string>>;
  readonly scenes: readonly DemoScene[];
}

/** Identity helper for typed demo specifications. */
export const defineDemo = (spec: DemoSpec): DemoSpec => spec;

export const isRefValue = (v: unknown): v is RefValue =>
  typeof v == "object" && v !== null && "$ref" in v && typeof (v as RefValue).$ref == "string";

/** Expands a scenario toggle matrix into all valid combinations. */
export function expandMatrix(matrix: DemoMatrix): Record<string, string>[] {
  const keys = Object.keys(matrix.axes);
  let combos: Record<string, string>[] = [{}];
  for (const k of keys) {
    const vals = matrix.axes[k];
    combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  }
  return matrix.valid ? combos.filter((c) => matrix.valid!(c)) : combos;
}

/** Resolves branches for one toggle combination into a flat list of concrete hops, states, and parallel blocks. */
export function resolveSteps(steps: readonly DemoStep[], combo: Readonly<Record<string, string>>): (HopStep | StateStep | ParallelStep)[] {
  const out: (HopStep | StateStep | ParallelStep)[] = [];
  for (const step of steps) {
    if (step.kind == "branch") {
      const picked = step.when(combo) ? step.steps : (step.otherwise ?? []);
      out.push(...resolveSteps(picked, combo));
    } else {
      out.push(step);
    }
  }
  return out;
}

// ---------------------------------------------------------------- pure lifecycle state machine

export interface LifecycleState {
  readonly nodeStates: Readonly<Record<string, string>>;
  readonly holds: ReadonlySet<string>;
}

export type LifecycleEvent =
  | { readonly on: "hop"; readonly hop: HopStep; readonly where: string }
  | { readonly on: "state"; readonly step: StateStep; readonly where: string };

export interface LifecycleStepResult {
  readonly state: LifecycleState;
  readonly errors: readonly string[];
}

/** Builds initial lifecycle state from a spec's node declarations. */
export function initialLifecycle(nodes: Readonly<Record<string, DemoNode>>): LifecycleState {
  const nodeStates: Record<string, string> = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (node.lifecycle) nodeStates[id] = node.lifecycle.initial;
  }
  return { nodeStates, holds: new Set() };
}

function applyEffects(state: LifecycleState, nodes: Readonly<Record<string, DemoNode>>, effects?: StepEffects): LifecycleState {
  if (!effects) return state;
  const nodeStates = { ...state.nodeStates };
  if (effects.setState) {
    for (const [id, next] of Object.entries(effects.setState)) {
      if (id in nodes) nodeStates[id] = next;
    }
  }
  const holds = new Set(state.holds);
  for (const h of effects.gain ?? []) holds.add(h);
  for (const h of effects.lose ?? []) holds.delete(h);
  return { nodeStates, holds };
}

/** Pure state transition checking node existence, lifecycle states, and held credentials for one step. */
export function lifecycleStep(
  state: LifecycleState,
  ev: LifecycleEvent,
  nodes: Readonly<Record<string, DemoNode>>,
  wires: Readonly<Record<string, DemoWire>>
): LifecycleStepResult {
  const errors: string[] = [];

  if (ev.on == "state") {
    for (const [id, next] of Object.entries(ev.step.effects.setState ?? {})) {
      const node = nodes[id];
      if (!node) errors.push(`${ev.where}: setState names unknown node "${id}"`);
      else if (node.lifecycle && !node.lifecycle.states.includes(next)) {
        errors.push(`${ev.where}: node "${id}" has no lifecycle state "${next}"`);
      }
    }
    return { state: applyEffects(state, nodes, ev.step.effects), errors };
  }

  const h = ev.hop;
  const fromNode = nodes[h.from];
  const toNode = nodes[h.to];
  if (!fromNode) errors.push(`${ev.where}: unknown sender node "${h.from}"`);
  if (!toNode) errors.push(`${ev.where}: unknown target node "${h.to}"`);
  if (h.via && !nodes[h.via]) errors.push(`${ev.where}: unknown via node "${h.via}"`);

  const wire = wires[h.wire];
  if (!wire) {
    errors.push(`${ev.where}: unknown wire "${h.wire}"`);
  } else {
    const endpoints = new Set([wire.from, wire.to]);
    const validVia = h.via && endpoints.has(h.via);
    if (!endpoints.has(h.from) && !endpoints.has(h.to) && !validVia) {
      errors.push(`${ev.where}: wire "${h.wire}" (${wire.from} <-> ${wire.to}) does not connect "${h.from}" or "${h.to}"`);
    }
  }

  // Enforce sender lifecycle state
  if (fromNode?.lifecycle) {
    const cur = state.nodeStates[h.from] ?? fromNode.lifecycle.initial;
    const allowed = fromNode.lifecycle.canEmit ?? fromNode.lifecycle.states.filter((s) => s != "absent");
    if (!allowed.includes(cur)) {
      errors.push(`${ev.where}: sender "${h.from}" is in state "${cur}" (must be ${allowed.join(" | ")} to emit "${h.label}")`);
    }
    if (h.requires?.fromState && cur != h.requires.fromState) {
      errors.push(`${ev.where}: sender "${h.from}" is "${cur}", expected "${h.requires.fromState}"`);
    }
  }

  // Enforce target lifecycle state (unless this hop itself transitions target into a valid state, e.g. mkdir/mount)
  if (toNode?.lifecycle) {
    const cur = state.nodeStates[h.to] ?? toNode.lifecycle.initial;
    const nextTarget = h.effects?.setState?.[h.to];
    const effective = nextTarget ?? cur;
    const allowed = toNode.lifecycle.canReceive ?? toNode.lifecycle.states.filter((s) => s != "absent");
    if (!allowed.includes(effective)) {
      errors.push(`${ev.where}: target "${h.to}" is in state "${cur}" (must be ${allowed.join(" | ")} to receive "${h.label}")`);
    }
    if (h.requires?.toState && cur != h.requires.toState) {
      errors.push(`${ev.where}: target "${h.to}" is "${cur}", expected "${h.requires.toState}"`);
    }
  }

  // Enforce required held credentials/chips
  for (const req of h.requires?.holds ?? []) {
    if (!state.holds.has(req)) {
      errors.push(`${ev.where}: missing required credential/chip "${req}" before "${h.label}"`);
    }
  }

  // Validate effect target states
  for (const [id, next] of Object.entries(h.effects?.setState ?? {})) {
    const node = nodes[id];
    if (!node) errors.push(`${ev.where}: setState names unknown node "${id}"`);
    else if (node.lifecycle && !node.lifecycle.states.includes(next)) {
      errors.push(`${ev.where}: node "${id}" has no lifecycle state "${next}"`);
    }
  }

  return { state: applyEffects(state, nodes, h.effects), errors };
}

// ---------------------------------------------------------------- verification ledger schema

export const VerificationIssueSchema = Schema.Struct({
  layer: Schema.Literals(["L1", "L2", "L3", "L4", "L5"]),
  code: Schema.String,
  where: Schema.String,
  message: Schema.String,
});
export type VerificationIssue = typeof VerificationIssueSchema.Type;

export const VerificationLedgerSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["proposal", "verified"]),
  ok: Schema.Boolean,
  combosChecked: Schema.Number,
  hopsChecked: Schema.Number,
  gateChecks: Schema.Number,
  machineChecks: Schema.Number,
  frameChecks: Schema.Number,
  tracesChecked: Schema.Number,
  plannedCount: Schema.Number,
  elidedCount: Schema.Number,
  resolvedConstants: Schema.Record(Schema.String, Schema.Unknown),
  plannedItems: Schema.Array(Schema.String),
  issues: Schema.Array(VerificationIssueSchema),
});
export type VerificationLedger = typeof VerificationLedgerSchema.Type;

export const encodeLedger = (ledger: VerificationLedger): string =>
  JSON.stringify(Schema.encodeSync(VerificationLedgerSchema)(ledger), null, 2);
