// The benchmark's results: medians, the tables it prints, the JSON it writes,
// and the comparison with an earlier JSON (--compare).

import type { Keys, Load } from "./measure";

export interface Results {
  meta: { date: string; commit: string; runs: number; rttMs: number; handshakeRtts: number; serverLatencyMs: number; keys: number; keyGapMs: number; server: string };
  /** For each case ("small viewer cold"): the median of each number, and every run. */
  loads: Record<string, { median: Partial<Load>; runs: Load[] }>;
  /** For each document: key press to paint, ms, every key of every run. */
  keys: Record<string, { median: number; p95: number; max: number; work?: number; n: number; lost: number; samples: number[] }>;
}

export const LOAD_METRICS = ["visible", "editable", "saved", "ttfb", "fcp", "load", "reqs", "kB", "docs", "docChain", "chain", "ws"] as const;
type Metric = (typeof LOAD_METRICS)[number];
/** `work`: the median from a key press to the change in the page, before the frame that paints it. */
const KEY_METRICS = ["median", "p95", "max", "work", "lost"] as const;

export const median = (xs: number[]) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
export const percentile = (xs: number[], p: number) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)] : NaN;
};

export function summarize(meta: Results["meta"], loads: Record<string, Load[]>, keys: Record<string, Keys[]>): Results {
  const out: Results = { meta, loads: {}, keys: {} };
  for (const [name, runs] of Object.entries(loads)) {
    const m: Partial<Load> = {};
    for (const k of LOAD_METRICS) { const v = median(runs.map((r) => r[k] ?? NaN)); if (Number.isFinite(v)) m[k] = Math.round(v * 10) / 10; }
    out.loads[name] = { median: m, runs };
  }
  for (const [name, runs] of Object.entries(keys)) {
    const s = runs.flatMap((r) => r.samples);
    out.keys[name] = { median: median(s), p95: percentile(s, 95), max: Math.max(...s), work: median(runs.flatMap((r) => r.work ?? [])), n: s.length, lost: runs.reduce((n, r) => n + r.lost, 0), samples: s };
  }
  return out;
}

const HEAD: Record<Metric, string> = { visible: "visible", editable: "editable", saved: "saved", ttfb: "ttfb", fcp: "fcp", load: "load", reqs: "reqs", kB: "kB", docs: "docs", docChain: "docChain", chain: "chain", ws: "ws" };
const cell = (v: number | undefined) => (v == null || !Number.isFinite(v) ? "-" : String(Math.round(v * 10) / 10));

/** The tables: loads (medians of the runs) and key presses (every key of every run). */
export function table(r: Results): string {
  const m = r.meta;
  const lines = [
    `${m.server}, ${m.commit}, median of ${m.runs} runs; network ${m.rttMs} ms round trip (+${m.handshakeRtts} for each new connection), server ${m.serverLatencyMs} ms to the database and each document`,
    "Times in ms from the start of the navigation; kB over the wire, compressed.",
    "",
    "case".padEnd(20) + LOAD_METRICS.map((k) => HEAD[k].padStart(9)).join(""),
  ];
  for (const [name, { median }] of Object.entries(r.loads)) lines.push(name.padEnd(20) + LOAD_METRICS.map((k) => cell(median[k]).padStart(9)).join(""));
  lines.push("", `key press to paint (ms), ${m.keys} keys a run, one each ${m.keyGapMs} ms`, "document".padEnd(20) + KEY_METRICS.map((k) => k.padStart(9)).join("") + "n".padStart(9));
  for (const [name, k] of Object.entries(r.keys)) lines.push(name.padEnd(20) + KEY_METRICS.map((x) => cell(k[x]).padStart(9)).join("") + String(k.n).padStart(9));
  return lines.join("\n");
}

/** Before and after: each median of `before` (an earlier results file), this run's, and the change. */
export function compare(before: Results, after: Results): string {
  const lines = [`before: ${before.meta.commit} (${before.meta.date}); after: ${after.meta.commit} (${after.meta.date})`, ""];
  const delta = (a: number | undefined, b: number | undefined) => {
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return `${cell(a)} -> ${cell(b)}`;
    const d = b - a, pct = a ? Math.round((d / a) * 100) : 0;
    return `${cell(a)} -> ${cell(b)} (${d > 0 ? "+" : ""}${cell(d)}${a ? `, ${pct > 0 ? "+" : ""}${pct}%` : ""})`;
  };
  for (const name of new Set([...Object.keys(before.loads), ...Object.keys(after.loads)])) {
    const a = before.loads[name]?.median ?? {}, b = after.loads[name]?.median ?? {};
    lines.push(name);
    for (const k of LOAD_METRICS) if (a[k] != null || b[k] != null) lines.push(`  ${HEAD[k].padEnd(10)}${delta(a[k], b[k])}`);
  }
  for (const name of new Set([...Object.keys(before.keys), ...Object.keys(after.keys)])) {
    const a = before.keys[name], b = after.keys[name];
    lines.push(`keys ${name}`);
    for (const k of KEY_METRICS) lines.push(`  ${k.padEnd(10)}${delta(a?.[k], b?.[k])}`);
  }
  return lines.join("\n");
}
