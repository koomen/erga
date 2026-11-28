// Opt-in boundary execution trace collector and homomorphic conformance checker
// for verified architecture demos (Layer 4). Uses the same AsyncLocalStorage
// pattern as cloudflare/timing.ts so production code pays zero overhead.

import { AsyncLocalStorage } from "node:async_hooks";
import type { DemoScene, ElidedEvent, HopStep, ParallelStep, StateStep } from "../shared/demo-spec.ts";

export interface TraceEvent {
  readonly seq: number;
  readonly from: string;
  readonly to: string;
  readonly proto: string;
  readonly op: string;
  readonly path?: string;
  readonly status?: number;
  /** Architectural milestones (auth crossings, grants, WS upgrades, storage writes) must be shown or explicitly elided. */
  readonly milestone?: boolean;
}

interface TraceBucket {
  seq: number;
  events: TraceEvent[];
}

const current = new AsyncLocalStorage<TraceBucket>();

/** Records one coarse architectural boundary event when running inside `withTrace()`. */
export function recordTrace(ev: Omit<TraceEvent, "seq">): void {
  const bucket = current.getStore();
  if (!bucket) return;
  bucket.events.push({ ...ev, seq: bucket.seq++ });
}

/** Runs `fn` inside an isolated trace context and returns its value plus ordered boundary events. */
export async function withTrace<T>(
  fn: (emit: (ev: Omit<TraceEvent, "seq">) => void) => Promise<T> | T
): Promise<{ value: T; events: TraceEvent[] }> {
  const bucket: TraceBucket = { seq: 0, events: [] };
  const emit = (ev: Omit<TraceEvent, "seq">) => {
    bucket.events.push({ ...ev, seq: bucket.seq++ });
  };
  const value = await current.run(bucket, () => fn(emit));
  return { value, events: bucket.events };
}

/** Projects trace actor IDs onto diagram node IDs through the spec's projection map. */
export function projectTrace(events: readonly TraceEvent[], projection: Readonly<Record<string, string>> = {}): TraceEvent[] {
  const map = (actor: string) => projection[actor] ?? actor;
  return events.map((e) => ({ ...e, from: map(e.from), to: map(e.to) }));
}

/** Matches a path template (`/d/:id/api/start` or `/d/<id>/api/start`) against a concrete trace path. */
export function pathMatches(pattern: string, actual: string): boolean {
  const cleanPattern = pattern.split("?")[0].replace(/\/+$/, "") || "/";
  const cleanActual = actual.split("?")[0].replace(/\/+$/, "") || "/";
  if (cleanPattern == cleanActual) return true;
  const escaped = cleanPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/<[^>]+>|:\w+/g, "[^/]+");
  return new RegExp(`^${escaped}$`).test(cleanActual);
}

/** Whether a trace event matches a demo hop's semantic signature. */
function hopMatchesEvent(hop: HopStep, ev: TraceEvent): boolean {
  const m = hop.traceMatch;
  const wantProto = m?.proto ?? hop.proto;
  if (wantProto && ev.proto != wantProto) return false;
  if (m?.from && ev.from != m.from) return false;
  if (m?.to && ev.to != m.to) return false;
  if (m?.status != null && ev.status != m.status) return false;
  if (m?.op && ev.op != m.op) return false;
  const wantPath = m?.path ?? hop.path;
  if (wantPath) {
    if (!ev.path) return false;
    if (!pathMatches(wantPath, ev.path)) return false;
  }
  if (!m?.op && hop.method && hop.proto == "http" && ev.op != hop.method) return false;
  return true;
}

/** Whether a trace milestone is covered by an explicit `elided` entry. */
function isElided(ev: TraceEvent, elided: readonly ElidedEvent[]): boolean {
  const full = ev.path ? `${ev.op} ${ev.path}` : ev.op;
  return elided.some((el) => {
    if (el.proto && el.proto != ev.proto) return false;
    if (el.op == full || el.op == ev.op) return true;
    const parts = el.op.split(" ");
    if (parts.length == 2 && ev.path && parts[0] == ev.op) return pathMatches(parts[1], ev.path);
    return false;
  });
}

const NOISE_OPS = new Set(["PING", "PONG", "heartbeat"]);

export interface TraceConformanceResult {
  readonly ok: boolean;
  readonly matchedIndices: readonly number[];
  readonly errors: readonly string[];
}

/**
 * Checks two properties between a scene's concrete steps and a captured trace:
 * 1. Soundness: every non-planned hop matches a real trace event in causal order (order-preserving subsequence).
 * 2. Milestone completeness: every milestone event in the trace is either matched by a hop or declared in `scene.elided`.
 */
export function checkTraceConformance(
  scene: DemoScene,
  resolvedSteps: readonly (HopStep | StateStep | ParallelStep)[],
  rawEvents: readonly TraceEvent[],
  projection: Readonly<Record<string, string>> = {}
): TraceConformanceResult {
  const events = projectTrace(rawEvents, projection).filter((e) => !NOISE_OPS.has(e.op));
  const errors: string[] = [];
  const matched = new Set<number>();

  let cursor = 0;

  const matchOne = (hop: HopStep, fromIdx: number, where: string): number => {
    if (hop.planned) return fromIdx;
    for (let i = fromIdx; i < events.length; i++) {
      if (hopMatchesEvent(hop, events[i])) {
        matched.add(i);
        return i + 1;
      }
    }
    const want = hop.traceMatch ? JSON.stringify(hop.traceMatch) : `${hop.proto} ${hop.method ?? ""} ${hop.path ?? hop.label}`.trim();
    errors.push(`${where}: hop "${hop.label}" (${want}) not found in trace "${scene.traceId}" after event #${fromIdx}`);
    return fromIdx;
  };

  for (let i = 0; i < resolvedSteps.length; i++) {
    const step = resolvedSteps[i];
    if (step.kind == "state") continue;
    if (step.kind == "hop") {
      cursor = matchOne(step, cursor, `scene=${scene.id} step=${i}`);
      continue;
    }
    // Parallel block: each concurrent branch must match monotonically starting from `cursor`.
    let maxCursor = cursor;
    for (let b = 0; b < step.branches.length; b++) {
      let branchCursor = cursor;
      for (const sub of step.branches[b]) {
        if (sub.kind == "hop") {
          branchCursor = matchOne(sub, branchCursor, `scene=${scene.id} parallel[${b}]`);
        }
      }
      if (branchCursor > maxCursor) maxCursor = branchCursor;
    }
    cursor = maxCursor;
  }

  const elided = scene.elided ?? [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev.milestone || matched.has(i)) continue;
    if (!isElided(ev, elided)) {
      const desc = ev.path ? `${ev.op} ${ev.path}` : ev.op;
      errors.push(
        `scene=${scene.id}: real trace milestone "${ev.proto} ${desc}" (${ev.from} -> ${ev.to}) was omitted without an entry in elided[]`
      );
    }
  }

  return {
    ok: errors.length == 0,
    matchedIndices: [...matched].sort((a, b) => a - b),
    errors,
  };
}
