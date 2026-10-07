// Dependencies between the factory's tasks (worker/factory.ts). Pure: no
// storage, no I/O; the factory hands it a way to look a task up by id.
//
// A task has two lists of task ids: startAfter (don't start until they're
// merged) and mergeAfter (don't merge until they're merged; startAfter ones
// count too). Only `merged` satisfies a dependency. Ids must name other
// tasks, not discarded ones, and a cycle (through either list) is refused.
// blockedBy is derived, never stored. README.md, "Dependencies", has the rest.

export type DepStatus = "queued" | "working" | "complete" | "merging" | "needs-agent" | "merged" | "failed" | "discarded";

/** What the model needs of a task. */
export interface DepTask {
  id: number;
  status: DepStatus;
  startAfter?: number[] | null;
  mergeAfter?: number[] | null;
}

/** What a task waits for: dependencies (by id) that aren't merged yet. */
export interface Blocked {
  /** A queued task's startAfter tasks not merged yet: it can't start. */
  start: number[];
  /** Its startAfter and mergeAfter tasks not merged yet: it can't merge. */
  merge: number[];
  /** Those of them that won't merge as things stand (discarded or failed): someone must remove or change the dependency. */
  stuck: number[];
  /** In words: "waiting for #12 to merge", "can't merge until #12 merges", "blocked: #12 was discarded; ...". */
  reason: string;
}

export type DepChanges = { startAfter?: number[]; mergeAfter?: number[] };

const DONE: DepStatus[] = ["merged", "discarded"];

/** "#12", "#12 and #13", "#12, #13 and #14". */
export const ids = (list: number[]) => list.map((id) => `#${id}`).join(", ").replace(/, ([^,]*)$/, " and $1");

/** " (starts after #12; merges after #14)", or nothing. */
export function depsNote(t: { startAfter?: number[] | null; mergeAfter?: number[] | null }): string {
  const parts = [t.startAfter?.length ? `starts after ${ids(t.startAfter)}` : "", t.mergeAfter?.length ? `merges after ${ids(t.mergeAfter)}` : ""].filter(Boolean);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

/** The tasks still to do (in `tasks`) that wait on task `id`. */
export const dependents = <T extends DepTask>(tasks: T[], id: number) =>
  tasks.filter((t) => !DONE.includes(t.status) && (t.startAfter?.includes(id) || t.mergeAfter?.includes(id)));

/** The model's rules, over a queue's tasks, found by id. */
export function depRules<T extends DepTask>(find: (id: number) => T | undefined | null) {
  const unmerged = (list?: number[] | null) => (list ?? []).filter((id) => find(id)?.status != "merged");
  /** The startAfter tasks not merged yet: the task can't start. */
  const unmetStart = (t: DepTask) => unmerged(t.startAfter);
  /** The startAfter and mergeAfter tasks not merged yet: the task can't merge. */
  const unmetMerge = (t: DepTask) => [...new Set([...unmerged(t.startAfter), ...unmerged(t.mergeAfter)])];

  function blocked(t: DepTask): Blocked | undefined {
    if (DONE.includes(t.status)) return undefined;
    const merge = unmetMerge(t);
    if (!merge.length) return undefined;
    const start = t.status == "queued" ? unmetStart(t) : [];
    const stuck = merge.filter((id) => ["discarded", "failed"].includes(find(id)?.status ?? "discarded"));
    const reason = stuck.length
      ? `blocked: ${stuck.map((id) => `#${id} ${find(id)?.status == "failed" ? "failed" : "was discarded"}`).join(", ")}; remove or change the dependency${stuck.some((id) => find(id)?.status == "failed") ? " (or fix and merge it)" : ""}`
      : start.length ? `waiting for ${ids(start)} to merge` : `can't merge until ${ids(merge)} merge${merge.length == 1 ? "s" : ""}`;
    return { start, merge, stuck, reason };
  }

  /**
   * Reads a dependency list from a request: an array of ids (or a "12,13" string); null or [] clears it.
   * Each must be another task that exists and isn't discarded. Returns the ids, or an error.
   */
  function parseDeps(v: unknown, self?: number): number[] | string {
    if (v == null || v === "") return [];
    const raw = Array.isArray(v) ? v : typeof v == "string" || typeof v == "number" ? String(v).split(",") : undefined;
    if (!raw) return "dependencies are a list of task ids";
    const list: number[] = [];
    for (const x of raw) {
      const s = String(x).trim().replace(/^#/, "");
      if (!s) continue;
      if (!/^\d+$/.test(s)) return `${JSON.stringify(x)} isn't a task id`;
      const id = Number(s);
      if (id == self) return `task ${id} can't depend on itself`;
      const t = find(id);
      if (!t) return `no task ${id}`;
      if (t.status == "discarded") return `task ${id} is discarded`;
      if (!list.includes(id)) list.push(id);
    }
    return list;
  }

  /** A chain of dependencies from one of `deps` back to `id` (so `id` waiting on them is a cycle), as ids from `id`. */
  function cycle(id: number, deps: number[]): number[] | undefined {
    const seen = new Set<number>();
    const walk = (n: number, path: number[]): number[] | undefined => {
      if (n == id) return path;
      if (seen.has(n)) return undefined;
      seen.add(n);
      const t = find(n);
      for (const d of [...(t?.startAfter ?? []), ...(t?.mergeAfter ?? [])]) { const p = walk(d, [...path, d]); if (p) return p; }
      return undefined;
    };
    for (const d of deps) { const p = walk(d, [id, d]); if (p) return p; }
    return undefined;
  }

  /**
   * The dependency changes a request body asks for (startAfter, mergeAfter), checked: ids, and no cycle.
   * Returns the changes (only the keys given; an empty list as undefined), or an error.
   */
  function depChanges(b: Record<string, unknown>, task?: DepTask): DepChanges | string {
    const out: DepChanges = {};
    for (const k of ["startAfter", "mergeAfter"] as const) {
      if (!(k in b)) continue;
      const list = parseDeps(b[k], task?.id);
      if (typeof list == "string") return `${k}: ${list}`;
      out[k] = list.length ? list : undefined;
    }
    if (task) {
      const all = [...new Set([...(("startAfter" in out ? out.startAfter : task.startAfter) ?? []), ...(("mergeAfter" in out ? out.mergeAfter : task.mergeAfter) ?? [])])];
      const loop = cycle(task.id, all);
      if (loop) return `that makes a cycle: ${loop.map((id) => `#${id}`).join(" waits for ")}`;
    }
    return out;
  }

  /** Why the task can't start now (with its startAfter list, or the one about to be set), or null. */
  function startRefusal(t: DepTask, startAfter = t.startAfter): string | null {
    const waiting = unmerged(startAfter);
    return waiting.length ? `task ${t.id} can't start: waiting for ${ids(waiting)} to merge (${waiting.map((id) => `#${id} is ${find(id)?.status ?? "gone"}`).join(", ")})` : null;
  }

  /** Why Merge is refused now, or null: a dependency neither merged nor merging (ahead of it in the merge queue, checked again when its turn comes). */
  function mergeRefusal(t: DepTask): string | null {
    const notYet = unmetMerge(t).filter((id) => find(id)?.status != "merging");
    if (!notYet.length) return null;
    const b = blocked(t);
    return `task ${t.id} can't merge until ${ids(notYet)} merge${notYet.length == 1 ? "s" : ""}${b?.stuck.length ? ` (${b.reason})` : ""}`;
  }

  /** When the queued merge runs: why it can't go on (a dependency that didn't merge, or one added meanwhile), or null. */
  function mergeTimeRefusal(t: DepTask): string | null {
    const waiting = unmetMerge(t);
    return waiting.length ? `Can't merge until ${ids(waiting)} merge${waiting.length == 1 ? "s" : ""} (${waiting.map((id) => `#${id} is ${find(id)?.status ?? "gone"}`).join(", ")}). Merge it again when they have, or remove the dependency.` : null;
  }

  /**
   * What a dependency's news (merged, discarded, failed) means for a task waiting on it, for its log, and
   * whether it is now unblocked (to start, for a queued task; else to merge) or blocked.
   */
  function dependentNews(dep: DepTask, t: DepTask): { message: string; change: "unblocked" | "blocked" | null } {
    const b = blocked(t);
    const what = dep.status == "merged" ? `#${dep.id} merged` : `#${dep.id} ${dep.status == "failed" ? "failed" : "was discarded"}`;
    if (dep.status != "merged") return { message: `${what}: this task is blocked until the dependency is removed or changed`, change: "blocked" };
    if (!b || (t.status == "queued" && !b.start.length)) return { message: `${what}: unblocked: it can ${t.status == "queued" ? "start" : "merge"} now`, change: "unblocked" };
    return { message: `${what}: ${b.reason}`, change: null };
  }

  return { unmerged, unmetStart, unmetMerge, blocked, parseDeps, cycle, depChanges, startRefusal, mergeRefusal, mergeTimeRefusal, dependentNews };
}
