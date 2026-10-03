#!/usr/bin/env bun
// End-to-end test of the task queue against a throwaway repo (with a bare
// "origin" to push to), never this one:
//
//   bun development/task-queue/test.ts
//
// Registers tasks, commits in their worktrees, runs a preview, attaches
// screenshots (one taken by headless Chrome), merges and pushes (through the
// merging status), merges a conflicting task with a stand-in resolver, fails
// a merge back to complete (with tq merge --wait), recovers a merge cut off by
// a restart, and discards one.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "tq-test-"));
const repo = join(tmp, "repo"), origin = join(tmp, "origin.git"), data = join(tmp, "data");
const sh = (cmd: string, cwd = repo) => {
  const r = Bun.spawnSync(["bash", "-c", cmd], { cwd, stderr: "pipe" });
  if (r.exitCode != 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
sh(`git init -q --bare -b main ${origin}`, tmp);
sh(`git init -q -b main ${repo} && cd ${repo} && git config user.email t@t && git config user.name t && echo "a\nb\nc" > notes.txt && git add . && git commit -qm init && git remote add origin ${origin} && git push -q origin main`, tmp);

const port = 4790 + Math.floor(Math.random() * 9);
const base = `http://127.0.0.1:${port}`;
// The stand-in for claude -p: keeps both sides of every conflict (taking a moment, so the merge is seen merging).
const resolver = `sleep 1; for f in $(git diff --name-only --diff-filter=U); do grep -v -e '^<<<<<<<' -e '^=======' -e '^>>>>>>>' "$f" > "$f.x" && mv "$f.x" "$f" && git add "$f"; done; git commit -q --no-edit`;
const env = { ...process.env, TASK_QUEUE_PORT: String(port), TASK_QUEUE_REPO: repo, TASK_QUEUE_DATA: data, TASK_QUEUE_RESOLVER: resolver, TASK_QUEUE_INSTALL: "0" };
const startServer = () => Bun.spawn(["bun", join(import.meta.dir, "server.ts")], { env, stdout: "pipe", stderr: "inherit" });
const waitUp = async () => { for (let i = 0; i < 50; i++) { try { await fetch(base + "/api"); return; } catch { await Bun.sleep(100); } } };
let server = startServer();
const tq = (...args: string[]) => {
  const r = Bun.spawnSync([join(import.meta.dir, "tq"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

let failures = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { ...(await r.json()), code: r.status };
};
const until = async (id: number, pred: (t: any) => boolean) => {
  for (let i = 0; i < 100; i++) { const t = await api("GET", `/api/tasks/${id}`); if (pred(t)) return t; await Bun.sleep(100); }
  return api("GET", `/api/tasks/${id}`);
};

try {
  await waitUp();
  const about = await api("GET", "/api");
  check(about.endpoints, "GET /api describes the API");
  check(about.statuses.merging && about.columns.Merging?.[0] == "merging", "GET /api describes the merging status and its column");

  // Live updates: the board's event stream.
  const events: any[][] = [];
  const stream = await fetch(base + "/api/events");
  (async () => {
    try {
    const reader = stream.body!.getReader(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += new TextDecoder().decode(value);
      let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const d = chunk.split("\n").find((l) => l.startsWith("data: ")); if (d) events.push(JSON.parse(d.slice(6))); }
    }
    } catch {} // the server restarting, below
  })();

  // A task, start to finish.
  const t1 = await api("POST", "/api/tasks", { title: "Add a greeting!", description: "Say hello" });
  check(t1.code == 201 && t1.branch == "task/1-add-a-greeting" && existsSync(t1.worktree) && t1.port >= 4501, "POST /api/tasks makes a branch, worktree and port");
  await Bun.sleep(200);
  check(events.some((ts) => ts.some((t) => t.id == 1)), "the event stream sends the new task");
  check((await api("PATCH", "/api/tasks/1", { status: "working", message: "On it" })).log.at(-1).message == "On it", "PATCH sets status and logs");
  check((await api("PATCH", "/api/tasks/1", { status: "merged" })).code == 400, "agents can't set merged");
  check((await api("PATCH", "/api/tasks/1", { status: "merging" })).code == 400, "agents can't set merging");
  sh(`echo hello > hello.txt && git add . && git commit -qm "Say hello"`, t1.worktree);

  const p = await api("POST", "/api/tasks/1/preview", { command: `bun -e 'Bun.serve({port: Number(process.env.PORT), fetch: () => new Response("<h1>hello from the preview</h1>", {headers: {"content-type": "text/html"}})})'`, path: "/hi" });
  check(p.url == `http://localhost:${t1.port}/hi`, "preview sets the url");
  const up = await until(1, (t) => t.previewUp);
  check(up.previewUp, "the board sees the preview is up");
  check((await (await fetch(`http://localhost:${t1.port}/`)).text()).includes("hello from the preview"), "the preview serves");

  const shot = await api("POST", "/api/tasks/1/screenshots", { url: `http://localhost:${t1.port}/`, caption: "The greeting" });
  check(shot.screenshots?.length == 1 && (await fetch(`${base}/shots/${shot.screenshots[0].file}`)).headers.get("content-type")?.includes("png"), "a URL screenshot is taken with headless Chrome and served");
  const png = await Bun.file(join(data, "screenshots", shot.screenshots[0].file)).arrayBuffer();
  const raw = await fetch(`${base}/api/tasks/1/screenshots?caption=raw`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
  check(raw.ok && (await raw.json()).screenshots.length == 2, "a raw image body is attached");

  await api("PATCH", "/api/tasks/1", { status: "complete", summary: "Added hello.txt" });
  const started = await api("POST", "/api/tasks/1/merge");
  check(started.code == 202 && started.status == "merging", "merge starts, and the task is merging");
  const m1 = await until(1, (t) => t.status != "merging");
  check(m1.status == "merged" && m1.commit, `task 1 merged (${m1.error ?? m1.commit})`);
  const seen1 = events.map((ts) => ts.find((t) => t.id == 1)?.status).filter((s, i, a) => s && s != a[i - 1]);
  check(seen1.join(" ").endsWith("complete merging merged"), `the event stream shows complete → merging → merged (${seen1.join(" → ")})`);
  check(m1.log.some((l: any) => l.message == "Merge requested") && m1.log.some((l: any) => l.message == "Merging"), "the log says when the merge was asked for and when it began");
  check(sh(`git --git-dir=${origin} show main:hello.txt`) == "hello", "the merge is pushed to origin");
  check(!existsSync(t1.worktree) && !sh("git branch --list task/1-*"), "the worktree and branch are cleaned up");
  await Bun.sleep(5500);
  check(!(await fetch(`http://localhost:${t1.port}/`).then(() => true, () => false)), "the preview is stopped");

  // Two tasks changing the same line: the second conflicts with main once the first is in.
  const t2 = await api("POST", "/api/tasks", { title: "Line b, one way" });
  const t3 = await api("POST", "/api/tasks", { title: "Line b, another" });
  sh(`sed -i '' 's/^b$/b two/' notes.txt && git commit -qam two`, t2.worktree);
  sh(`sed -i '' 's/^b$/b three/' notes.txt && git commit -qam three`, t3.worktree);
  for (const id of [t2.id, t3.id]) await api("PATCH", `/api/tasks/${id}`, { status: "complete" });
  await api("POST", `/api/tasks/${t2.id}/merge`);
  const q3 = await api("POST", `/api/tasks/${t3.id}/merge`); // queued behind t2's
  check(q3.status == "merging" && q3.log.at(-1).message.includes(`waiting for #${t2.id}`), "a merge queued behind another is merging, and says what it waits for");
  check((await fetch(`${base}/api/tasks?status=merging`).then((r) => r.json())).some((t: any) => t.id == t3.id), "GET /api/tasks?status=merging lists it");
  check((await api("POST", `/api/tasks/${t3.id}/merge`)).code == 409, "a merging task can't be merged again");
  check((await api("PATCH", `/api/tasks/${t3.id}`, { status: "complete" })).code == 409, "an agent can't change a merging task's status");
  check((await api("POST", `/api/tasks/${t3.id}/discard`)).code == 409, "a merging task can't be discarded");
  const m3 = await until(t3.id, (t) => t.status != "merging" && t.status != "complete");
  check(m3.status == "merged", `the conflicting task merged (${m3.error ?? m3.commit})`);
  check(m3.log.some((l: any) => l.message.startsWith("Conflicts merging")), "the conflict went to the resolver");
  const notes = sh(`git --git-dir=${origin} show main:notes.txt`);
  check(notes.includes("b two") && notes.includes("b three"), "both sides are in origin/main");

  // Uncommitted work blocks a merge, with a message.
  const t4 = await api("POST", "/api/tasks", { title: "Dirty" });
  writeFileSync(join(t4.worktree, "notes.txt"), "dirty\n");
  await api("PATCH", `/api/tasks/${t4.id}`, { status: "complete" });
  const w4 = tq("merge", String(t4.id), "--wait");
  check(w4.code == 1 && /merge failed: .*uncommitted/.test(w4.err), "tq merge --wait waits, and exits 1 when the merge fails");
  const m4 = await api("GET", `/api/tasks/${t4.id}`);
  check(m4.status == "complete" && /uncommitted/.test(m4.error), "uncommitted changes stop a merge, back to complete, and say so");

  // A merge cut off by the queue stopping goes back to Ready to merge when it starts again.
  server.kill(); await server.exited;
  const saved = JSON.parse(readFileSync(join(data, "tasks.json"), "utf8"));
  saved.tasks.find((t: any) => t.id == t4.id).status = "merging";
  writeFileSync(join(data, "tasks.json"), JSON.stringify(saved));
  server = startServer(); await waitUp();
  const r4 = await api("GET", `/api/tasks/${t4.id}`);
  check(r4.status == "complete" && /stopped while this was merging/.test(r4.error), "a merge interrupted by a restart is back at complete, saying why");
  const d4 = await api("POST", `/api/tasks/${t4.id}/discard`);
  check(d4.status == "discarded" && !existsSync(t4.worktree) && !sh("git branch --list task/4-*"), "discard removes worktree and branch");

  check(JSON.parse(readFileSync(join(data, "tasks.json"), "utf8")).tasks.length == 4, "tasks are saved to disk");
} finally {
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passing");
process.exit(failures ? 1 : 0);
