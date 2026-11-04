// Before and after, per task: the mean of each group's runs (results/<label>.json), MCP and local side by side.
//
//   bun bench/mcp/compare.ts baseline-1,base2 after2 [--html]
//
// Each argument is a group: labels joined by commas. The first group is "before", the last "after".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "./run.ts";

const html = process.argv.includes("--html");
const groups = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (groups.length < 1) throw new Error("usage: bun bench/mcp/compare.ts <labels> [<labels>] [--html]");
const load = (g: string): Run[] =>
  g.split(",").flatMap((l) => JSON.parse(readFileSync(join(import.meta.dir, "results", `${l}.json`), "utf8")) as Run[]);
const runs = groups.map(load);
const tasks = [...new Set(runs.flat().map((r) => r.task))].sort();

/** The mean of one task's runs on one side, in one group. */
function mean(rs: Run[], task: string, mode: string) {
  const mine = rs.filter((r) => r.task == task && r.mode == mode);
  const avg = (f: (r: Run) => number) => (mine.length ? mine.reduce((a, r) => a + f(r), 0) / mine.length : Number.NaN);
  return {
    n: mine.length,
    pass: mine.filter((r) => r.pass).length,
    s: avg((r) => r.wallS),
    calls: avg((r) => r.apiCalls),
    tools: avg((r) => r.toolCalls),
    errors: avg((r) => r.toolErrors),
    tokens: avg((r) => r.inputTokens + r.outputTokens),
  };
}
type Mean = ReturnType<typeof mean>;
const passes = (m: Mean) => `${m.pass}/${m.n}`;
const f0 = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(0));
const f1 = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(1));

const before = runs[0],
  after = runs[runs.length - 1];
const rows = tasks.map((t) => ({ t, mb: mean(before, t, "mcp"), ma: mean(after, t, "mcp"), l: mean([...before, ...after], t, "local") }));
const total = (pick: (r: (typeof rows)[number]) => Mean, f: (m: Mean) => number) => rows.reduce((a, r) => a + f(pick(r)), 0);

if (html) {
  for (const { t, mb, ma, l } of rows)
    console.log(
      `      <tr><td>${t}</td><td class="n">${f0(mb.s)}</td><td class="n">${f1(mb.calls)}</td><td class="n">${passes(mb)}</td><td class="n">${f0(ma.s)}</td><td class="n">${f1(ma.calls)}</td><td class="n">${passes(ma)}</td><td class="n">${f0(l.s)}</td><td class="n">${f1(l.calls)}</td><td class="n">${passes(l)}</td></tr>`
    );
} else {
  console.log(`${"task".padEnd(20)} | MCP before: s calls tools err pass | MCP after: s calls tools err pass | local: s calls tools pass`);
  for (const { t, mb, ma, l } of rows)
    console.log(
      `${t.padEnd(20)} | ${f0(mb.s).padStart(4)} ${f1(mb.calls).padStart(5)} ${f1(mb.tools).padStart(5)} ${f1(mb.errors).padStart(4)} ${passes(mb).padStart(4)} | ${f0(ma.s).padStart(4)} ${f1(ma.calls).padStart(5)} ${f1(ma.tools).padStart(5)} ${f1(ma.errors).padStart(4)} ${passes(ma).padStart(4)} | ${f0(l.s).padStart(4)} ${f1(l.calls).padStart(5)} ${f1(l.tools).padStart(5)} ${passes(l).padStart(4)}`
    );
}
const line = (name: string, pick: (r: (typeof rows)[number]) => Mean) =>
  `${name}: ${f0(total(pick, (m) => m.s))} s, ${f0(total(pick, (m) => m.calls))} model calls, ${f0(total(pick, (m) => m.tools))} tool calls, ${f1(total(pick, (m) => m.errors))} tool errors, ${f0(total(pick, (m) => m.tokens) / 1000)}k tokens, ${total(pick, (m) => m.pass)}/${total(pick, (m) => m.n)} pass`;
console.log(`\n${line("MCP before", (r) => r.mb)}\n${line("MCP after ", (r) => r.ma)}\n${line("local     ", (r) => r.l)}`);
