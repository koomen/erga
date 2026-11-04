// The MCP benchmark's runner: for each task, two Claude Code agents (Opus 5.5, normal speed) on the same starting
// document at once, through herdr-core (hc): one with only the local Erga's MCP server, one with the plain files in a
// folder. Each run's numbers come from its transcript; each end state is checked by the task's own check.
//
//   bun bench/mcp/run.ts --label baseline [--server http://localhost:4777] [--tasks a,b] [--modes mcp,local] [--pairs 3]
//
// Writes bench/mcp/results/<label>.json and prints a table. Needs hc, claude, and a dev server (bun start).

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { newToken } from "../../e2e/helpers/new-token.ts";
import { runTool } from "../../e2e/helpers/tools.ts";
import { readFiles, withProbe } from "./probe.ts";
import { TASKS } from "./tasks.ts";
import type { Files, Task } from "./types.ts";

const HERE = import.meta.dir;
const { values: opt } = parseArgs({
  options: {
    label: { type: "string", default: "run" },
    server: { type: "string", default: "http://localhost:4777" },
    tasks: { type: "string" },
    modes: { type: "string", default: "mcp,local" },
    pairs: { type: "string", default: "3" },
    dir: { type: "string", default: join(process.env.BENCH_DIR ?? tmpdir(), "erga-mcp-bench") },
  },
});
const root = opt.server!;
const modes = opt.modes!.split(",") as Mode[];
const tasks = opt.tasks ? TASKS.filter((t) => opt.tasks!.split(",").includes(t.id)) : TASKS;
type Mode = "mcp" | "local";

/** One agent's run: what its transcript shows, and the check's verdict. */
export interface Run {
  task: string;
  mode: Mode;
  pass: boolean;
  failures: string[];
  wallS: number;
  apiCalls: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  tools: Record<string, number>;
  speed: string[];
  error?: string;
}

/**
 * Runs a command without blocking (the checks' file server runs in this process too). Its output goes through a file:
 * a pipe can stay open after it ends, held by a process hc starts.
 */
const sh = async (args: string[]) => {
  const out = join(tmpdir(), `erga-bench-${crypto.randomUUID()}`);
  const p = Bun.spawn(args, { stdout: Bun.file(`${out}.out`), stderr: Bun.file(`${out}.err`), stdin: "ignore" });
  const code = await p.exited;
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  const r = { code, out: read(`${out}.out`), err: read(`${out}.err`) };
  rmSync(`${out}.out`, { force: true });
  rmSync(`${out}.err`, { force: true });
  return r;
};

// ---------------------------------------------------------------- the person, as the MCP agent acts

const signIn = await fetch(`${root}/auth/github?as=pete&next=/docs`, { redirect: "manual" });
const cookie = signIn.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .find((c) => /^erga_session/.test(c));
if (!cookie) throw new Error(`can't sign in at ${root}: ${signIn.status}`);
const { token, error } = await newToken(root, { label: `mcp bench ${opt.label}` }, cookie);
if (!token) throw new Error(`no token: ${error}`);
const tool = async (name: string, args: Record<string, unknown>) => {
  const r = await runTool(root, name, args, { token });
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.result;
};

/** A folder's files for create_document: text as text, the rest as base64. */
function filesOf(dir: string): Record<string, string | { base64: string }> {
  const out: Record<string, string | { base64: string }> = {};
  const walk = (d: string, pre: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, `${pre}${n}/`);
      else {
        const b = readFileSync(p);
        out[pre + n] = /\.(html?|css|js|mjs|json|svg|txt|md|csv)$/i.test(n) ? b.toString("utf8") : { base64: b.toString("base64") };
      }
    }
  };
  walk(dir, "");
  return out;
}

/** The document's text files as they are now, through the read tool (pages of lines put together). */
async function exportDoc(id: string, to: string): Promise<void> {
  const ls = (await tool("ls", { document: id })) as { entries: { path: string; kind: string }[] };
  for (const e of ls.entries) {
    if (e.kind != "text") continue;
    let text = "";
    for (let offset = 1; ; ) {
      const r = (await tool("read", { document: id, path: e.path, offset, limit: 100000 })) as { type: string; text: string }[];
      const t = r.map((c) => c.text).join("");
      const more = /\n\n\[Showing lines \d+-(\d+) of \d+\. Use offset=(\d+) to continue\.\]$/.exec(t);
      if (!more) {
        text += t;
        break;
      }
      text += t.slice(0, more.index) + "\n";
      offset = Number(more[2]);
    }
    mkdirSync(dirname(join(to, e.path)), { recursive: true });
    writeFileSync(join(to, e.path), text);
  }
}

// ---------------------------------------------------------------- an agent's run

const WHERE: Record<Mode, (address: string) => string> = {
  mcp: (a) => `The document is the Erga document ${a}: use the erga tools.`,
  local: () => "The document is the folder you are in: its files are in the current directory.",
};
const PROMPT = (where: string, task: Task) =>
  `${where}\n\n${task.prompt}\n\nWork on your own: don't ask questions, and don't start other agents. Stop when it's done.`;

const transcripts = join(homedir(), ".claude", "projects");
function transcriptOf(session: string): string | null {
  for (const d of readdirSync(transcripts)) {
    const f = join(transcripts, d, `${session}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

/** The numbers in a transcript, and whether its last answer ended the turn. */
function measure(file: string) {
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const times = lines.filter((l) => l.timestamp && (l.type == "user" || l.type == "assistant")).map((l) => Date.parse(l.timestamp));
  const calls = new Map<string, { usage: Record<string, number> & { speed?: string }; stop: string | null }>();
  const tools: Record<string, number> = {};
  let toolErrors = 0;
  for (const l of lines) {
    if (l.type == "assistant") {
      calls.set(l.message.id, { usage: l.message.usage, stop: l.message.stop_reason });
      for (const c of l.message.content ?? []) if (c.type == "tool_use") tools[c.name] = (tools[c.name] ?? 0) + 1;
    }
    if (l.type == "user" && Array.isArray(l.message?.content))
      for (const c of l.message.content) if (c.type == "tool_result" && c.is_error) toolErrors++;
  }
  const all = [...calls.values()];
  const last = lines.filter((l) => l.type == "assistant").at(-1);
  return {
    done: last?.message.stop_reason == "end_turn",
    wallS: times.length ? (Math.max(...times) - Math.min(...times)) / 1000 : 0,
    apiCalls: all.length,
    toolCalls: Object.values(tools).reduce((a, b) => a + b, 0),
    toolErrors,
    inputTokens: all.reduce(
      (a, c) => a + (c.usage.input_tokens ?? 0) + (c.usage.cache_creation_input_tokens ?? 0) + (c.usage.cache_read_input_tokens ?? 0),
      0
    ),
    outputTokens: all.reduce((a, c) => a + (c.usage.output_tokens ?? 0), 0),
    tools,
    speed: [...new Set(all.map((c) => c.usage.speed ?? "?"))],
  };
}

async function runOne(task: Task, mode: Mode, base: string): Promise<Run> {
  const dir = join(base, task.id, mode);
  rmSync(dir, { recursive: true, force: true });
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  const corpus = join(HERE, "corpus", task.doc);
  const session = crypto.randomUUID();
  const name = `${opt.label}-${task.id}-${mode}`.replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
  let args: string[];
  let doc: { id: string; address: string } | null = null;
  if (mode == "local") {
    cpSync(corpus, work, { recursive: true });
    args = ["--tools", "Read,Edit,Write,Glob,Grep,Bash", "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash"];
  } else {
    const files = filesOf(corpus);
    const pages = Object.keys(files).filter((p) => p.endsWith(".html")).length;
    doc = (await tool("create_document", {
      files,
      kind: pages > 1 ? "project" : "document",
      title: `bench ${task.doc}`,
      slug: `bench-${opt.label}-${task.id}-${session.slice(0, 6)}`,
    })) as { id: string; address: string };
    const config = join(dir, "mcp.json");
    writeFileSync(
      config,
      JSON.stringify({ mcpServers: { erga: { type: "http", url: `${root}/mcp`, headers: { Authorization: `Bearer ${token}` } } } })
    );
    args = ["--tools", "", "--mcp-config", config, "--allowedTools", "mcp__erga"];
  }
  const prompt = PROMPT(WHERE[mode](doc?.address ?? ""), task);
  const started = Date.now();
  const launch = await sh([
    "hc",
    "run",
    "--bg",
    "--no-notify",
    "--name",
    name,
    "--cwd",
    work,
    "--",
    "claude",
    "--model",
    "claude-opus-5-5",
    "--settings",
    '{"fastMode":false}',
    "--session-id",
    session,
    ...args,
    "--strict-mcp-config",
  ]);
  if (launch.code) return failed(task, mode, `hc run: ${launch.err}`);
  // A folder Claude Code hasn't seen asks whether to trust it first. The task goes in once the prompt shows and MCP
  // has had time to connect: a task given at launch reaches the model before the MCP server's tools do.
  for (let i = 0; i < 30; i++) {
    const screen = (await sh(["hc", "read", name, "--lines", "0"])).out;
    if (screen.includes("Yes, I trust this folder")) await sh(["hc", "keys", name, "down", "enter"]);
    else if (screen.includes("auto mode") || screen.includes("? for shortcuts")) break;
    await Bun.sleep(1000);
  }
  await Bun.sleep(8000);
  const sent = await sh(["hc", "send", name, prompt]);
  if (sent.code) return failed(task, mode, `hc send: ${sent.err}`);
  // Wait for its turn to end: the transcript's last answer ends the turn, and hc says it stopped working.
  let file: string | null = null;
  for (;;) {
    await sh(["hc", "wait", name, "--timeout", "60"]);
    file = transcriptOf(session);
    const status = JSON.parse((await sh(["hc", "get", name])).out || "{}");
    if (status.state != "live") break;
    if (file && measure(file).done && status.status?.state != "working") break;
    if (Date.now() - started > 30 * 60_000) break;
    await Bun.sleep(2000);
  }
  if (!file) return failed(task, mode, "no transcript");
  const m = measure(file);
  // The end state, as files, checked.
  const out = join(dir, "out");
  rmSync(out, { recursive: true, force: true });
  if (mode == "local") cpSync(work, out, { recursive: true });
  else await exportDoc(doc!.id, out);
  const files: Files = readFiles(out);
  let failures: string[];
  try {
    failures = await withProbe(out, async (p) => task.check(files, p));
  } catch (e) {
    failures = [`check threw: ${(e as Error).message}`];
  }
  writeFileSync(join(dir, "screen.txt"), (await sh(["hc", "read", name, "--lines", "400"])).out);
  await sh(["hc", "kill", name]);
  await sh(["hc", "rm", name]);
  const { done: _, ...numbers } = m;
  // A run whose agent never reached its tools says nothing about them.
  const error = !m.toolCalls ? "the agent made no tool call" : undefined;
  return { task: task.id, mode, pass: failures.length == 0, failures, ...numbers, ...(error ? { error } : {}) };
}

const failed = (task: Task, mode: Mode, error: string): Run => ({
  task: task.id,
  mode,
  pass: false,
  failures: [error],
  wallS: 0,
  apiCalls: 0,
  toolCalls: 0,
  toolErrors: 0,
  inputTokens: 0,
  outputTokens: 0,
  tools: {},
  speed: [],
  error,
});

// ---------------------------------------------------------------- all of them, a few pairs at once

const base = join(opt.dir!, opt.label!);
mkdirSync(base, { recursive: true });
const results: Run[] = [];
const queue = [...tasks];
await Promise.all(
  Array.from({ length: Number(opt.pairs) }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const pair = await Promise.all(modes.map((m) => runOne(t!, m, base).catch((e) => failed(t!, m, String(e)))));
      results.push(...pair);
      for (const r of pair) console.log(line(r));
      save();
    }
  })
);

/** The results so far, in bench/mcp/results/<label>.json. */
function save() {
  results.sort((a, b) => a.task.localeCompare(b.task) || a.mode.localeCompare(b.mode));
  mkdirSync(join(HERE, "results"), { recursive: true });
  writeFileSync(join(HERE, "results", `${opt.label}.json`), JSON.stringify(results, null, 1));
}

function line(r: Run) {
  return `${r.task.padEnd(24)} ${r.mode.padEnd(5)} ${r.pass ? "PASS" : "FAIL"} ${r.wallS.toFixed(0).padStart(5)}s ${String(r.apiCalls).padStart(3)} calls ${String(r.toolCalls).padStart(3)} tools ${String(r.toolErrors).padStart(2)} err ${(r.inputTokens / 1000).toFixed(0).padStart(5)}k in ${(r.outputTokens / 1000).toFixed(1).padStart(5)}k out ${r.speed.join(",")}${r.pass ? "" : `  ${r.failures.slice(0, 2).join("; ").slice(0, 160)}`}`;
}

save();
console.log(`\n${results.map(line).join("\n")}`);
for (const mode of modes) {
  const rs = results.filter((r) => r.mode == mode);
  const sum = (f: (r: Run) => number) => rs.reduce((a, r) => a + f(r), 0);
  console.log(
    `${mode}: ${rs.filter((r) => r.pass).length}/${rs.length} pass, ${sum((r) => r.wallS).toFixed(0)} s, ${sum((r) => r.toolCalls)} tool calls, ${sum((r) => r.toolErrors)} errors, ${(sum((r) => r.inputTokens) / 1000).toFixed(0)}k in, ${(sum((r) => r.outputTokens) / 1000).toFixed(1)}k out`
  );
}
