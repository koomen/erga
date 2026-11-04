// A run's tool calls, one after another, with the time each answer took: where an agent spends its turns.
//
//   bun bench/mcp/trace.ts <run folder>   (e.g. $BENCH_DIR/erga-mcp-bench/<label>/<task>/mcp)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2];
// The session's transcript: the one whose project folder is the run's work folder.
const projects = join(homedir(), ".claude", "projects");
const key = join(dir, "work").replace(/[^A-Za-z0-9]/g, "-");
const folder = readdirSync(projects).find((d) => d == key);
if (!folder) throw new Error(`no transcript folder ${key}`);
// The newest, when the folder has had more than one run.
const file = readdirSync(join(projects, folder))
  .filter((f) => f.endsWith(".jsonl"))
  .sort((a, b) => statSync(join(projects, folder, b)).mtimeMs - statSync(join(projects, folder, a)).mtimeMs)[0];
if (!file) throw new Error("no transcript");
const lines = readFileSync(join(projects, folder, file), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const short = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s).replace(/\n/g, "⏎");
const asked = new Map<string, number>();
let t0 = 0;
for (const l of lines) {
  const at = Date.parse(l.timestamp ?? "");
  if (!t0 && at) t0 = at;
  const s = ((at - t0) / 1000).toFixed(1).padStart(6);
  if (l.type == "assistant")
    for (const c of l.message.content ?? []) {
      if (c.type == "text" && c.text.trim()) console.log(`${s}s  say   ${short(c.text, 300)}`);
      if (c.type == "tool_use") {
        asked.set(c.id, at);
        console.log(`${s}s  call  ${c.name.replace("mcp__erga__", "")} ${short(JSON.stringify(c.input), 400)}`);
      }
    }
  if (l.type == "user" && Array.isArray(l.message?.content))
    for (const c of l.message.content)
      if (c.type == "tool_result") {
        const text = Array.isArray(c.content)
          ? c.content.map((x: { text?: string }) => x.text ?? `[${(x as { type: string }).type}]`).join("")
          : String(c.content);
        const took = asked.has(c.tool_use_id) ? ` (${((at - asked.get(c.tool_use_id)!) / 1000).toFixed(1)}s)` : "";
        console.log(`${s}s  ${c.is_error ? "ERROR" : "got  "}${took} ${short(text)}`);
      }
}
