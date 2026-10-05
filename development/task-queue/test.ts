#!/usr/bin/env bun
// End-to-end test of the task queue against a throwaway repo (with a bare
// "origin" to push to), never this one:
//
//   bun development/task-queue/test.ts
//
// Registers tasks, commits in their worktrees, runs a preview, attaches
// screenshots (one taken by headless Chrome), removes them (one, all, tq shot
// --replace; not while merging; the board's ×), merges and pushes (through the
// merging status), and discards one; tq watch follows it all, through a restart.
// One agent per task: tq start --agent and tq agent record it; a conflicting
// merge stops (its preview and a process left in the worktree stopped first),
// puts the worktree back and goes to needs-agent (tq watch, the board's Needs
// agent column, Merge refused), the "agent" resolves and commits, tq continue
// merges it; uncommitted changes go to the agent too; a hung check times out,
// its whole process tree killed, and goes to the agent; a merge that fails for
// a reason outside the worktree goes back to complete (with tq merge --wait),
// and one cut off by a restart too.
// Then main's history (the Branches column):
// its order, which commits are only local, done tasks matched to their merge
// commits, live updates on a commit, a push, a fetch and a merge, and the
// board (Branches in place of a Done column) in headless Chrome.
// Last, a queue run from a throwaway repo's own copy of its code: merging a
// change to that code restarts it with the new code (after the merge queued
// behind, once), keeping tasks, previews and a board connected in headless
// Chrome (which loads the new board); other merges don't restart it; a change
// on disk without a merge restarts it too, but not one that doesn't build.
// And live mode: tq add --live, tq live (the dev server, and a Chrome window of
// its own, launched headless here, reattached, relaunched when closed), tq look
// (url, title, selection, console, a screenshot), the board's live badge, and
// the window and dev server stopped on discard and on merge.
// Dependencies: startAfter and mergeAfter set on creation and changed (ids
// checked, cycles refused), start and merge refused until the dependency
// merges and allowed after, a queued merge whose dependency's merge fails
// (the race), a discarded and a failed dependency, tq watch's unblocked and
// blocked lines, tq add --after/--merge-after and tq deps, and the board (the
// chip, Merge disabled with the reason, adding and removing one in the detail
// view) in headless Chrome. DEPS_ONLY=1 runs just this part.
// Origin as Erga sets it up (TASK_QUEUE_ORIGIN): left alone while the checkout
// is dirty, then pointed at the new origin (the old one kept as `github`, main
// pushing to staging, a credential helper for its host); signing in
// (TASK_QUEUE_LOGIN) waiting for an approval, shown by GET /api/history, the
// board and tq watch; origin's staging merged into a task's branch, and main
// pushed to staging, never to main; tq release moving origin's main to
// staging; a refused push on the task's log, pushed again by itself once
// origin takes it. ORIGIN_ONLY=1 runs just this part.

import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, Page } from "../../tests/cdp.ts";

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
// What the task's agent does with a conflict here: keeps both sides of every conflicted file, and commits.
const resolve = `for f in $(git diff --name-only --diff-filter=U); do grep -v -e '^<<<<<<<' -e '^=======' -e '^>>>>>>>' "$f" > "$f.x" && mv "$f.x" "$f" && git add "$f"; done; git commit -q --no-edit`;
// The pre-merge check: a task's own check.sh, if it has one (to slow a merge, fail it, or hang it), within 3 seconds.
const env = { ...process.env, TASK_QUEUE_PORT: String(port), TASK_QUEUE_REPO: repo, TASK_QUEUE_DATA: data, TASK_QUEUE_INSTALL: "0", TASK_QUEUE_FETCH: "2", TASK_QUEUE_CHROME_HEADLESS: "1",
  TASK_QUEUE_CHECK: "if [ -f check.sh ]; then bash check.sh; fi", TASK_QUEUE_TIMEOUT_CHECK: "3" };
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
  for (let i = 0; i < 300; i++) { const t = await api("GET", `/api/tasks/${id}`); if (pred(t)) return t; await Bun.sleep(100); } // 30s: merges are slower on a busy machine
  return api("GET", `/api/tasks/${id}`);
};

let watcher: ReturnType<typeof Bun.spawn> | undefined;
/** Live mode's windows and dev servers, killed at the end if the test stops before the queue does. */
const leftovers: number[] = [];
let selfPid = 0;
try {
  await waitUp();
  if (process.env.DEPS_ONLY) { await dependencies(); throw "done"; }
  if (process.env.ORIGIN_ONLY) { await originPart(); throw "done"; }
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
      let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const d = chunk.split("\n").find((l) => l.startsWith("data: ")); if (d) { const v = JSON.parse(d.slice(6)); if (Array.isArray(v)) events.push(v); } }
    }
    } catch {} // the server restarting, below
  })();

  // tq watch: one line per status change, from here on, flushed as it happens.
  const watchLines: string[] = [];
  const follow = (proc: ReturnType<typeof Bun.spawn>, into: string[]) => (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader(); let buf = "";
    for (;;) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); let i; while ((i = buf.indexOf("\n")) >= 0) { into.push(buf.slice(0, i)); buf = buf.slice(i + 1); } }
  })();
  const watchState = join(tmp, "watch-state.json");
  watcher = Bun.spawn([join(import.meta.dir, "tq"), "watch", "--state", watchState], { env, stdout: "pipe", stderr: "pipe" });
  follow(watcher, watchLines);
  await Bun.sleep(1000);
  check(watchLines.length == 0, "tq watch is quiet until something changes");

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

  // Removing screenshots: one by index or file name, all, and tq shot --replace; each file goes from disk.
  const shotsDir = join(data, "screenshots"), pngFile = join(tmp, "shot.png");
  writeFileSync(pngFile, Buffer.from(png));
  tq("shot", "1", pngFile, "third");
  const three = (await api("GET", "/api/tasks/1")).screenshots;
  const u1 = tq("unshot", "1", "2");
  const after1 = JSON.parse(u1.out || "{}").screenshots ?? [];
  check(u1.code == 0 && after1.map((s: any) => s.caption).join(",") == "The greeting,third" && !existsSync(join(shotsDir, three[1].file)), "tq unshot ID INDEX removes that screenshot and its file");
  const u2 = await api("DELETE", `/api/tasks/1/screenshots/${three[2].file}`);
  check(u2.code == 200 && u2.screenshots.length == 1 && !existsSync(join(shotsDir, three[2].file)) && u2.log.at(-1).message == "Screenshot removed: third", "DELETE .../screenshots/:file removes it by file name, and logs it");
  check((await api("DELETE", "/api/tasks/1/screenshots/9")).code == 404 && tq("unshot", "1", "nope.png").code == 1, "removing a screenshot that isn't there is a 404");
  tq("shot", "1", pngFile, "second");
  const kept = (await api("GET", "/api/tasks/1")).screenshots.map((s: any) => s.file);
  const r1 = tq("shot", "1", pngFile, "fresh", "--replace");
  const fresh = JSON.parse(r1.out || "{}").screenshots ?? [];
  check(r1.code == 0 && fresh.length == 1 && fresh[0].caption == "fresh" && kept.every((f: string) => !existsSync(join(shotsDir, f))), "tq shot --replace removes the old screenshots (and files) before it attaches the new one");
  tq("shot", "1", pngFile, "another");
  const cleared = tq("unshot", "1", "--all");
  check(cleared.code == 0 && JSON.parse(cleared.out).screenshots.length == 0 && !existsSync(join(shotsDir, fresh[0].file)), "tq unshot ID --all removes them all");
  check(tq("help").out.includes("tq unshot ID FILE|INDEX") && tq("help").out.includes("--replace"), "tq help lists unshot and --replace");
  const about2 = await api("GET", "/api");
  check(about2.endpoints?.["DELETE /api/tasks/:id/screenshots/:file"] && about2.endpoints?.["DELETE /api/tasks/:id/screenshots"] && about2.cli.includes("tq unshot"), "GET /api lists the DELETE endpoints and tq unshot");
  await fetch(`${base}/api/tasks/1/screenshots?caption=raw`, { method: "POST", headers: { "content-type": "image/png" }, body: png });

  await api("PATCH", "/api/tasks/1", { status: "complete", summary: "Added hello.txt" });
  const started = await api("POST", "/api/tasks/1/merge");
  check(started.code == 202 && started.status == "merging", "merge starts, and the task is merging");
  const m1 = await until(1, (t) => t.status != "merging");
  check(m1.status == "merged" && m1.commit, `task 1 merged (${m1.error ?? m1.commit})`);
  const seen1 = events.map((ts) => ts.find((t) => t.id == 1)?.status).filter((s, i, a) => s && s != a[i - 1]);
  check(seen1.join(" ").endsWith("complete merging merged"), `the event stream shows complete → merging → merged (${seen1.join(" → ")})`);
  check(m1.log.some((l: any) => l.message == "Merge requested") && m1.log.some((l: any) => l.message == "Merging"), "the log says when the merge was asked for and when it began");
  check(sh(`git --git-dir=${origin} show main:hello.txt`) == "hello", "the merge is pushed to origin");
  for (let i = 0; i < 30 && (existsSync(t1.worktree) || sh("git branch --list task/1-*")); i++) await Bun.sleep(100); // cleaned up just after it's marked merged
  check(!existsSync(t1.worktree) && !sh("git branch --list task/1-*"), "the worktree and branch are cleaned up");
  await Bun.sleep(5500);
  check(!(await fetch(`http://localhost:${t1.port}/`).then(() => true, () => false)), "the preview is stopped");

  check(["#1 queued: Add a greeting!", "#1 working: Add a greeting!", "#1 ready to merge: Add a greeting!", "#1 merging: Add a greeting!", "#1 merged: Add a greeting!"].every((l, i) => watchLines[i] == l) && watchLines.length == 5, `tq watch prints each status change of task 1 (${JSON.stringify(watchLines)})`);

  // Two tasks changing the same line: the second conflicts with main once the first is in.
  const t2 = await api("POST", "/api/tasks", { title: "Line b, one way" });
  const t3 = await api("POST", "/api/tasks", { title: "Line b, another" });
  // One agent per task: recorded when it starts (tq start --agent), changed with tq agent.
  const st = JSON.parse(tq("start", String(t3.id), "--agent", "agent-x").out || "{}");
  check(st.status == "working" && st.agent == "agent-x" && st.log.at(-1).message == "Started; Agent: agent-x", "tq start --agent records the task's agent");
  const ag = JSON.parse(tq("agent", String(t3.id), "agent-3").out || "{}");
  check(ag.agent == "agent-3" && ag.log.at(-1).message == "Agent: agent-3", "tq agent changes it");
  sh(`sed -i '' 's/^b$/b two/' notes.txt && git commit -qam two`, t2.worktree);
  sh(`sed -i '' 's/^b$/b three/' notes.txt && git commit -qam three`, t3.worktree);
  const head3 = sh("git rev-parse HEAD", t3.worktree);
  for (const id of [t2.id, t3.id]) await api("PATCH", `/api/tasks/${id}`, { status: "complete" });
  // t3's preview runs, and something its agent left behind runs in its worktree: both must stop before the merge.
  await api("POST", `/api/tasks/${t3.id}/preview`, { command: `bun -e 'Bun.serve({port: Number(process.env.PORT), fetch: () => new Response("three")})'` });
  await until(t3.id, (t) => t.previewUp);
  const stray = Bun.spawn(["sleep", "300"], { cwd: t3.worktree });
  await api("POST", `/api/tasks/${t2.id}/merge`);
  const q3 = await api("POST", `/api/tasks/${t3.id}/merge`); // queued behind t2's
  check(q3.status == "merging" && q3.log.at(-1).message.includes(`waiting for #${t2.id}`), "a merge queued behind another is merging, and says what it waits for");
  check((await fetch(`${base}/api/tasks?status=merging`).then((r) => r.json())).some((t: any) => t.id == t3.id), "GET /api/tasks?status=merging lists it");
  check((await api("POST", `/api/tasks/${t3.id}/merge`)).code == 409, "a merging task can't be merged again");
  check((await api("PATCH", `/api/tasks/${t3.id}`, { status: "complete" })).code == 409, "an agent can't change a merging task's status");
  check((await api("POST", `/api/tasks/${t3.id}/discard`)).code == 409, "a merging task can't be discarded");
  check((await api("DELETE", `/api/tasks/${t3.id}/screenshots`)).code == 409 && tq("unshot", String(t3.id), "1").code == 1, "a merging task's screenshots can't be removed");
  const m3 = await until(t3.id, (t) => t.status != "merging");
  check((await api("GET", `/api/tasks/${t2.id}`)).status == "merged", "the first task merged");
  check(m3.status == "needs-agent" && m3.error == "conflicts merging origin/main: notes.txt" && m3.needsAgent?.files?.join() == "notes.txt" && m3.needsAgent.step == "git merge origin/main" && /CONFLICT/.test(m3.needsAgent.output ?? ""),
    `the conflict stops the merge: needs-agent, with the files and git's output (${m3.status}: ${m3.error})`);
  check(m3.log.some((l: any) => l.message.startsWith("Needs agent: conflicts merging origin/main: notes.txt. Its agent (agent-3) fixes it")), "the log says so, and names the agent");
  check(sh("git rev-parse HEAD", t3.worktree) == head3 && !sh("git status --porcelain", t3.worktree) && !existsSync(join(sh("git rev-parse --absolute-git-dir", t3.worktree), "MERGE_HEAD")), "the worktree is back on the branch's last commit, clean, with no merge under way");
  check(m3.log.some((l: any) => l.message == "Preview stopped") && m3.log.some((l: any) => /^Stopped 1 process left running in the worktree: \d+ \(sleep 300\)/.test(l.message)), "the merge stopped the preview, and the process left in the worktree, first");
  check(stray.exitCode != null || stray.signalCode != null || (await Promise.race([stray.exited.then(() => true), Bun.sleep(3000).then(() => false)])), "that process is gone");
  check((await until(t3.id, (t) => t.previewUp)).previewUp && m3.log.some((l: any) => l.message.startsWith("Preview started")), "and the preview runs again, for the user to look at");
  for (let i = 0; i < 30 && !watchLines.some((l) => l.startsWith(`#${t3.id} needs agent`)); i++) await Bun.sleep(100);
  check(watchLines.includes(`#${t3.id} needs agent: Line b, another: conflicts merging origin/main: notes.txt (agent agent-3)`), `tq watch says it needs its agent, and which (${watchLines.filter((l) => l.includes("needs agent"))})`);
  const refused = await api("POST", `/api/tasks/${t3.id}/merge`);
  check(refused.code == 409 && refused.error.includes(`tq continue ${t3.id}`), `Merge is refused while it waits for its agent (${refused.error})`);
  check((await api("POST", `/api/tasks/${t2.id}/continue`)).code == 409, "tq continue is only for a task that needs its agent");

  // The board: its own column, the agent, Merge off, and why in the detail view.
  const browserNA = await Browser.launch();
  try {
    const page = await browserNA.page();
    await page.open(base + "/", { width: 1700, height: 900, clear: false });
    await Bun.sleep(600);
    const v = await page.eval(`(() => { const c = document.querySelector('[data-col="needs-agent"] .card[data-open="${t3.id}"]'); const m = c?.querySelector(".actions button.primary");
      return { inCol: !!c, chip: c?.querySelector(".chip.agent")?.textContent, err: c?.querySelector(".err")?.textContent, off: m?.disabled, n: document.querySelector('[data-col="needs-agent"] .n')?.textContent,
        cols: [...document.querySelectorAll("main section")].map((x) => x.dataset.col).join(",") }; })()`);
    check(v.cols == "queued,working,needs-agent,ready-to-merge,merging,branches", `the board has a Needs agent column, after Working (${v.cols})`);
    check(v.inCol && v.chip == "agent agent-3" && v.err == "conflicts merging origin/main: notes.txt" && v.off && v.n == "1", `the card is in it, with its agent, why, and Merge off (${JSON.stringify(v)})`);
    if (process.env.TQ_SHOTS) await page.screenshot(join(process.env.TQ_SHOTS, "needs-agent-board.png"));
    await page.eval(`document.querySelector('.card[data-open="${t3.id}"] .title').click(), true`);
    await page.settle();
    const d = await page.eval(`({ status: document.querySelector("#dlg .status")?.textContent, reason: document.querySelector("#dlg .stop .reason")?.textContent, files: [...document.querySelectorAll("#dlg .stop .files li")].map((l) => l.textContent).join(), next: document.querySelector("#dlg .stop .next")?.textContent ?? "", out: document.querySelector("#dlg .stop .out")?.textContent ?? "" })`);
    check(d.status == "Needs agent" && d.reason == "conflicts merging origin/main: notes.txt" && d.files == "notes.txt" && d.next.includes(`tq continue ${t3.id}`) && d.next.includes("agent-3") && /CONFLICT/.test(d.out), `the detail view says why, the files, what comes next, and git's output (${JSON.stringify(d).slice(0, 200)})`);
    if (process.env.TQ_SHOTS) await page.screenshot(join(process.env.TQ_SHOTS, "needs-agent-detail.png"));
    await page.eval(`document.querySelector('#dlg [data-act="close"]').click(), true`);
    check(page.errors.length == 0, `no errors on the board (${page.errors})`);
  } finally { browserNA.close(); }

  // The agent merges main itself, resolves, and commits; tq continue then merges it.
  sh(`git merge -q main || true`, t3.worktree);
  check(tq("continue", String(t3.id)).code == 1 && /middle of a merge/.test(tq("continue", String(t3.id)).err), "tq continue refuses an unfinished merge in the worktree");
  sh(resolve, t3.worktree);
  const c3 = tq("continue", String(t3.id), "--wait");
  const m3b = JSON.parse(c3.out || "{}");
  check(c3.code == 0 && m3b.status == "merged", `after the agent resolves and commits, tq continue merges it (${m3b.error ?? m3b.status}${c3.err})`);
  check((await api("GET", `/api/tasks/${t3.id}`)).log.some((l: any) => l.message == "Continued by its agent (agent-3): merging again"), "the log says the agent continued it");
  const notes = sh(`git --git-dir=${origin} show main:notes.txt`);
  check(notes.includes("b two") && notes.includes("b three"), "both sides are in origin/main");
  for (let i = 0; i < 30 && !watchLines.includes(`#${t3.id} merged: Line b, another`); i++) await Bun.sleep(100);
  check(watchLines.slice(watchLines.indexOf(`#${t3.id} needs agent: Line b, another: conflicts merging origin/main: notes.txt (agent agent-3)`)).join("|").includes(`#${t3.id} merging: Line b, another|#${t3.id} merged: Line b, another`), "tq watch: needs agent, then merging, then merged");

  // Uncommitted changes: the agent's too.
  const t4 = await api("POST", "/api/tasks", { title: "Dirty" });
  writeFileSync(join(t4.worktree, "notes.txt"), "dirty\n");
  await api("PATCH", `/api/tasks/${t4.id}`, { status: "complete" });
  const w4 = tq("merge", String(t4.id), "--wait");
  check(w4.code == 1 && /needs agent: uncommitted changes in the worktree: notes.txt/.test(w4.err), `tq merge --wait waits, and exits 1 when the merge needs the agent (${w4.err.trim()})`);
  const m4 = await api("GET", `/api/tasks/${t4.id}`);
  check(m4.status == "needs-agent" && readFileSync(join(t4.worktree, "notes.txt"), "utf8") == "dirty\n", "uncommitted changes stop a merge, for the agent, and stay as they were");
  for (let i = 0; i < 30 && !watchLines.some((l) => l.startsWith(`#${t4.id} needs agent`)); i++) await Bun.sleep(100);
  check(watchLines.includes(`#${t4.id} needs agent: Dirty: uncommitted changes in the worktree: notes.txt (no agent recorded)`), "tq watch says when no agent is recorded");
  check(tq("continue", String(t4.id)).code == 1, "tq continue refuses while the worktree has uncommitted changes");

  // A merge that fails for a reason outside the worktree goes back to Ready to merge.
  sh(`git -C ${t4.worktree} commit -qam dirty && git checkout -q -b elsewhere`);
  const w4b = tq("continue", String(t4.id), "--wait");
  const m4b = await api("GET", `/api/tasks/${t4.id}`);
  check(w4b.code == 1 && /merge failed: .* is on elsewhere, not main/.test(w4b.err) && m4b.status == "complete", `the main checkout off main: back to complete, saying why (${m4b.status}: ${m4b.error})`);
  sh("git checkout -q main && git branch -q -D elsewhere");

  // A merge cut off by the queue stopping goes back to Ready to merge when it starts again.
  server.kill(); await server.exited;
  const saved = JSON.parse(readFileSync(join(data, "tasks.json"), "utf8"));
  saved.tasks.find((t: any) => t.id == t4.id).status = "merging";
  writeFileSync(join(data, "tasks.json"), JSON.stringify(saved));
  server = startServer(); await waitUp();
  const r4 = await api("GET", `/api/tasks/${t4.id}`);
  check(r4.status == "complete" && /stopped while this was merging/.test(r4.error), "a merge interrupted by a restart is back at complete, saying why");
  check(watchLines.includes(`#${t4.id} merge failed, back to ready to merge: Dirty: ${m4b.error.replace(/\s+/g, " ")}`), "tq watch says when a merge failed, with why");
  const d4 = await api("POST", `/api/tasks/${t4.id}/discard`);
  check(d4.status == "discarded" && !existsSync(t4.worktree) && !sh("git branch --list task/4-*"), "discard removes worktree and branch");
  for (let i = 0; i < 50 && watchLines.at(-1) != `#${t4.id} discarded: Dirty`; i++) await Bun.sleep(100);
  check(watchLines.at(-1) == `#${t4.id} discarded: Dirty`, `tq watch reconnects after the server restarts (${watchLines.at(-1)})`);
  check(!watchLines.some((l) => !/^#\d+ [a-z ,]+: /.test(l)), "tq watch prints nothing but status lines");

  // A step that hangs: the check (and what it started) runs out of time, is killed whole, and the task goes to its agent.
  const th = await api("POST", "/api/tasks", { title: "Hangs" });
  const grandchild = join(tmp, "grandchild.pid");
  writeFileSync(join(th.worktree, "check.sh"), `sleep 301 &\necho $! > ${grandchild}\nsleep 302\n`);
  sh(`git add check.sh && git commit -qm "A check that hangs"`, th.worktree);
  sh(`echo more >> notes.txt && git commit -qam "main moves on"`); // so the queue makes a merge commit on the branch before the check
  const headH = sh("git rev-parse HEAD", th.worktree);
  tq("agent", String(th.id), "agent-h");
  await api("PATCH", `/api/tasks/${th.id}`, { status: "complete" });
  const t0 = Date.now();
  await api("POST", `/api/tasks/${th.id}/merge`);
  const mh = await until(th.id, (t) => t.status != "merging");
  const gpid = Number(readFileSync(grandchild, "utf8"));
  check(mh.status == "needs-agent" && mh.error == "the check (if [ -f check.sh ]; then bash check.sh; fi) timed out after 3s" && mh.needsAgent?.step == "the check (if [ -f check.sh ]; then bash check.sh; fi)" && Date.now() - t0 < 9000,
    `a hung check times out after 3s and goes to the agent (${mh.status}: ${mh.error}, ${Date.now() - t0}ms)`);
  await Bun.sleep(3500); // SIGTERM, then SIGKILL 3s later for what's left
  check(!(() => { try { process.kill(gpid, 0); return true; } catch { return false; } })(), `the check's whole process tree is killed, the process it started too (pid ${gpid})`);
  check(sh("git rev-parse HEAD", th.worktree) == headH, "the worktree is back on the branch's last commit (the queue's merge of main undone)");
  for (let i = 0; i < 30 && !watchLines.some((l) => l.startsWith(`#${th.id} needs agent`)); i++) await Bun.sleep(100);
  check(watchLines.includes(`#${th.id} needs agent: Hangs: the check (if [ -f check.sh ]; then bash check.sh; fi) timed out after 3s (agent agent-h)`), "tq watch says which step timed out, and after how long");
  sh(`git rm -q check.sh && git commit -qm "No hang" && git merge -q --no-edit main`, th.worktree);
  const ch = JSON.parse(tq("continue", String(th.id), "--wait").out || "{}");
  check(ch.status == "merged", `fixed by the agent, it merges (${ch.error ?? ch.status})`);

  // A watch started again (re-armed) reports what changed while none was running.
  watcher.kill(); await watcher.exited;
  const t5 = await api("POST", "/api/tasks", { title: "While unwatched" });
  await api("PATCH", `/api/tasks/${t5.id}`, { status: "failed", error: "it broke\nbadly" });
  const again: string[] = [];
  watcher = Bun.spawn([join(import.meta.dir, "tq"), "watch", "--state", watchState], { env, stdout: "pipe", stderr: "pipe" });
  follow(watcher, again);
  await Bun.sleep(1000);
  check(again.length == 1 && again[0] == `#${t5.id} failed: While unwatched: it broke badly`, `tq watch --state catches up on changes made between watches (${JSON.stringify(again)})`);
  watcher.kill();
  await api("POST", `/api/tasks/${t5.id}/discard`);

  check(JSON.parse(readFileSync(join(data, "tasks.json"), "utf8")).tasks.length == 6, "tasks are saved to disk");

  // Main's history: the Branches column.
  const histories: any[] = [];
  const hs = await fetch(base + "/api/events");
  (async () => {
    try {
      const reader = hs.body!.getReader(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += new TextDecoder().decode(value);
        let i; while ((i = buf.indexOf("\n\n")) >= 0) {
          const lines = buf.slice(0, i).split("\n"); buf = buf.slice(i + 2);
          const d = lines.find((l) => l.startsWith("data: "));
          if (lines.includes("event: history") && d) histories.push(JSON.parse(d.slice(6)));
        }
      }
    } catch {}
  })();
  const seen = async (pred: (h: any) => boolean) => { for (let i = 0; i < 100; i++) { if (histories.length && pred(histories.at(-1))) return histories.at(-1); await Bun.sleep(100); } return histories.at(-1) ?? {}; };
  const h0 = await api("GET", "/api/history");
  check(h0.commits.map((c: any) => c.task ?? c.subject).join(",") == `${th.id},main moves on,3,2,1,init`, `history is main's first-parent line, newest first, merges matched to tasks (${h0.commits.map((c: any) => c.task ?? c.subject)})`);
  check(h0.commits.every((c: any) => c.remote) && h0.unpushed == 0 && h0.behind == 0 && h0.origin, "everything merged is on origin/main");
  check(h0.tasks[1]?.sha.startsWith(m1.commit) && h0.tasks[th.id]?.index == 0 && h0.tasks[3]?.index == 2 && h0.tasks[2]?.index == 3 && !h0.tasks[4], "done tasks map to their merge commits and places; a discarded one has none");
  check((await seen((h) => h.commits?.length == 6)).commits?.length == 6, "the event stream sends the history on connect");

  sh(`echo local >> notes.txt && git commit -qam "A local commit"`);
  const h1 = await seen((h) => h.commits[0].subject == "A local commit");
  check(h1.commits?.[0].subject == "A local commit" && !h1.commits[0].remote && h1.commits.slice(1).every((c: any) => c.remote) && h1.unpushed == 1, "a new commit on main arrives live, local only (not on origin)");
  sh("git push -q origin main");
  const h2 = await seen((h) => h.unpushed == 0);
  check(h2.unpushed == 0 && h2.commits?.[0].remote, "after a push it's on origin/main, live");

  // Someone else pushes: origin/main gets ahead, seen at the next periodic fetch.
  const other = join(tmp, "other");
  sh(`git clone -q ${origin} ${other} && cd ${other} && git config user.email o@o && git config user.name o && git commit -q --allow-empty -m elsewhere && git push -q origin main`, tmp);
  const h3 = await seen((h) => h.behind == 1);
  check(h3.behind == 1 && h3.unpushed == 0, "the periodic fetch sees origin/main ahead of main");
  sh("git pull -q --ff-only origin main");

  // Only the latest 25 show; older merges still match their tasks.
  sh(`for i in $(seq 1 26); do git commit -q --allow-empty -m "filler $i"; done`);
  const h4 = await seen((h) => h.commits[0].subject == "filler 26");
  check(h4.commits?.length == 25 && h4.unpushed == 26 && h4.tasks?.[1]?.index == 32 && h4.tasks[1].remote, `25 commits shown, the 26 unpushed counted, older task merges still matched (${h4.commits?.length}, ${h4.unpushed}, ${h4.tasks?.[1]?.index})`);

  // The board: no Done column; Branches after Merging, a row per commit, live, a task's row opening it.
  const browser = await Browser.launch();
  try {
    const page = await browser.page();
    for (const dark of [false, true]) {
      await page.open(base + "/", { width: 1600, height: 900, dark, clear: false });
      await Bun.sleep(500);
      const b = await page.eval(`({ rows: document.querySelectorAll("#graph li").length, unpushed: document.querySelectorAll("#graph .lane.o.no").length,
        cols: [...document.querySelectorAll("main section")].map((c) => c.dataset.col).join(","), n: document.getElementById("branches-n").textContent })`);
      check(b.cols == "queued,working,needs-agent,ready-to-merge,merging,branches", `${dark ? "dark" : "light"}: no Done column; Branches comes after Merging (${b.cols})`);
      check(b.rows == 25 && b.unpushed == 25 && b.n.startsWith("26 not pushed"), `${dark ? "dark" : "light"}: Branches shows 25 commits, all 25 hollow on origin (${b.rows}, ${b.unpushed}, ${b.n})`);
    }
    sh("git push -q origin main");
    await Bun.sleep(2500);
    check(await page.eval(`document.querySelectorAll("#graph .lane.o.no").length == 0 && document.getElementById("branches-n").textContent == "pushed"`), "after a push the board fills in origin's dots, live");
    // Bring the task merges back into the 25, then open task 3 from its commit.
    sh(`git reset -q --hard HEAD~26 && git push -q -f origin main`);
    await Bun.sleep(2500);
    const pt = await page.eval(`(() => { const r = document.querySelector('#graph li[data-open="3"]').getBoundingClientRect(); return { x: r.left + 60, y: r.top + r.height / 2 }; })()`);
    await page.click(pt.x, pt.y);
    await page.settle();
    check(await page.eval(`document.getElementById("dlg").open && document.querySelector("#dlg h3").textContent.includes("#3")`), "clicking a task's commit opens the task");
    await page.eval(`document.querySelector('#dlg [data-act="close"]').click(), true`); // as the user does: dlg.close() alone lets a task update reopen it

    // The detail view's ×: shown on hover, removes that one screenshot, no confirmation.
    const ts = await api("POST", "/api/tasks", { title: "Shots", worktree: false });
    for (const caption of ["old", "new"]) await fetch(`${base}/api/tasks/${ts.id}/screenshots?caption=${caption}`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
    await page.settle();
    await Bun.sleep(500);
    const card = await page.eval(`(() => { const c = document.querySelector('.card[data-open="${ts.id}"]'); c.scrollIntoView({ block: "center" }); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 14 }; })()`);
    await page.click(card.x, card.y);
    await page.settle();
    check(await page.eval(`document.getElementById("dlg").open && document.querySelectorAll("#dlg .shots figure").length == 2`), "the task's detail view shows its two screenshots");
    const fig = await page.eval(`(() => { const r = document.querySelector("#dlg .shots figure").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 40 }; })()`);
    const hidden = await page.eval(`getComputedStyle(document.querySelector("#dlg .unshot")).opacity`);
    await page.mouse("mouseMoved", fig.x, fig.y);
    await Bun.sleep(300);
    const x = await page.eval(`(() => { const b = document.querySelector("#dlg .unshot"), r = b.getBoundingClientRect(); return { o: getComputedStyle(b).opacity, n: document.querySelectorAll("#dlg .unshot").length, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    check(hidden == "0" && x.o == "1" && x.n == 2, `each screenshot has a ×, hidden until hover (${hidden} → ${x.o}, ${x.n})`);
    const oldFile = (await api("GET", `/api/tasks/${ts.id}`)).screenshots[0].file;
    await page.click(x.x, x.y);
    await until(ts.id, (t) => t.screenshots.length == 1);
    await page.settle();
    const left = await page.eval(`({ open: document.getElementById("dlg").open, caps: [...document.querySelectorAll("#dlg .shots figcaption")].map((c) => c.textContent).join(",") })`);
    const tsAfter = await api("GET", `/api/tasks/${ts.id}`);
    check(left.open && left.caps == "new" && tsAfter.screenshots.length == 1 && !existsSync(join(data, "screenshots", oldFile)), `clicking × removes that screenshot at once, file too, and the view stays open (${left.caps})`);
    await page.eval(`document.querySelector('#dlg [data-act="close"]').click(), true`);
    await api("POST", `/api/tasks/${ts.id}/discard`);

    // A task merging now shows on top as soon as it's merged.
    const t6 = await api("POST", "/api/tasks", { title: "Fresh merge" });
    sh(`echo fresh > fresh.txt && git add . && git commit -qm fresh`, t6.worktree);
    await api("PATCH", `/api/tasks/${t6.id}`, { status: "complete" });
    await api("POST", `/api/tasks/${t6.id}/merge`);
    const m6 = await until(t6.id, (t) => t.status != "merging");
    check(m6.status == "merged" && (await api("GET", "/api/history")).commits[0].task == t6.id, "a just-merged task's commit is already at the top of the history");
    await page.settle();
    check(await page.eval(`document.querySelector("#graph li:not(.leave) b")?.textContent`) == `#${t6.id}`, "and at the top of the board's Branches");

    sh(`git commit -q --allow-empty -m "One more"`);
    await Bun.sleep(2500);
    const top = await page.eval(`[...document.querySelectorAll("#graph li:not(.leave)")].slice(0, 2).map((li) => li.textContent + (li.querySelector(".lane.o.no") ? " (local)" : ""))`);
    check(top[0] == "One more (local)" && top[1] == `#${t6.id}Fresh merge`, `a new commit appears at the top of the board, live (${top})`);
    check(page.errors.length == 0, `no errors on the board (${page.errors})`);
  } finally { browser.close(); }

  await dependencies();
  await originPart();

  // ---- Live mode -------------------------------------------------------------
  const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const gone = async (pid: number) => { for (let i = 0; i < 100 && running(pid); i++) await Bun.sleep(100); return !running(pid); };
  // A stand-in dev server: the page is page.html in the worktree, read on every request.
  const devServer = `bun -e 'Bun.serve({port: Number(process.env.PORT), fetch: async () => new Response(await Bun.file("page.html").text(), {headers: {"content-type": "text/html"}})})'`;
  const added = tq("add", "--live", "Tweak the docs list", "Live: tighten the spacing");
  const l1 = JSON.parse(added.out);
  check(added.code == 0 && l1.live === true && l1.status == "queued" && l1.worktree, `tq add --live registers a live task (${added.err})`);
  check((await api("PATCH", `/api/tasks/${l1.id}`, { live: false })).live === undefined && (await api("PATCH", `/api/tasks/${l1.id}`, { live: true })).live === true, "PATCH sets and clears live");
  check((await api("POST", "/api/tasks", { title: "Not live" })).live === undefined, "tasks aren't live unless asked");
  writeFileSync(join(l1.worktree, "page.html"), "<title>Docs</title><h1>The docs list</h1>");
  const went = tq("live", String(l1.id), "/docs", "--cmd", devServer);
  const l2 = JSON.parse(went.out || "{}");
  leftovers.push(l2.chrome?.pid, -l2.preview?.pid);
  check(went.code == 0 && l2.status == "working" && l2.previewUp && l2.preview?.command == devServer && l2.url == `http://localhost:${l1.port}/docs`, `tq live starts it, runs the dev server and waits for it (${went.err})`);
  check(l2.chrome?.pid && l2.chrome.port && l2.chrome.profile?.startsWith(join(data, "chrome")) && l2.chrome.target && l2.chromeUp, "and opens a Chrome window of its own, recorded on the task");
  const tabs = await (await fetch(`http://127.0.0.1:${l2.chrome.port}/json/list`)).json();
  check(tabs.some((t: any) => t.id == l2.chrome.target && t.url == `http://localhost:${l1.port}/docs`), "the window shows the dev server's page");
  // The user selects something, and the page logs an error.
  const tab = new Page(tabs.find((t: any) => t.id == l2.chrome.target).webSocketDebuggerUrl);
  await tab.ready;
  for (let i = 0; i < 100 && !(await tab.eval(`!!document.querySelector("h1")`)); i++) await Bun.sleep(100);
  await tab.eval(`getSelection().selectAllChildren(document.querySelector("h1")), console.error("boom"), console.log("hello"), true`);
  const shotFile = join(tmp, "look.png");
  const looked = tq("look", String(l1.id), "--shot", shotFile);
  const lk = JSON.parse(looked.out || "{}");
  check(looked.code == 0 && lk.url == `http://localhost:${l1.port}/docs` && lk.title == "Docs" && lk.target == l2.chrome.target && lk.tabs?.length == 1, `tq look says what the window shows (${looked.err || JSON.stringify(lk)})`);
  check(lk.selection == "The docs list", `and what's selected in it (${lk.selection})`);
  check(lk.console?.some((m: string) => m == "error: boom") && !lk.console.some((m: string) => m.includes("hello")), `and its console errors (${lk.console})`);
  check(lk.screenshot == shotFile && existsSync(shotFile) && readFileSync(shotFile).subarray(1, 4).toString() == "PNG", "--shot saves a screenshot");
  const all = JSON.parse(tq("look", String(l1.id), "--console").out || "{}");
  check(all.console?.some((m: string) => m == "log: hello") && !all.screenshot, "--console has every message");
  tab.close?.();
  // An edit in the worktree shows on the next load.
  writeFileSync(join(l1.worktree, "page.html"), "<title>Docs, tighter</title><h1>The docs list</h1>");
  const again1 = JSON.parse(tq("live", String(l1.id), "/docs", "--cmd", devServer).out || "{}");
  check(again1.chrome?.pid == l2.chrome.pid && again1.preview?.pid == l2.preview.pid && again1.log.at(-1).message.startsWith("Chrome window brought back"), "tq live again reattaches to the same window and dev server");
  // Every tab closed: tq live opens one again, in the same window.
  for (const t of await (await fetch(`http://127.0.0.1:${l2.chrome.port}/json/list`)).json()) if (t.type == "page") await fetch(`http://127.0.0.1:${l2.chrome.port}/json/close/${t.id}`);
  await Bun.sleep(300);
  const again2 = JSON.parse(tq("live", String(l1.id), "/docs", "--cmd", devServer).out || "{}");
  const tabs2 = await (await fetch(`http://127.0.0.1:${l2.chrome.port}/json/list`)).json().catch(() => []);
  check(again2.chrome?.pid == l2.chrome.pid && tabs2.some((t: any) => t.id == again2.chrome.target && t.url.startsWith(`http://localhost:${l1.port}/`)), "with its tabs closed, tq live opens the page again in the same window");
  check(JSON.parse(tq("look", String(l1.id)).out || "{}").title == "Docs, tighter", "showing the worktree's latest");
  // The window closed (by the user, say): the board sees it, and tq live opens a new one.
  process.kill(l2.chrome.pid, "SIGKILL");
  await gone(l2.chrome.pid);
  check(!(await until(l1.id, (t) => !t.chromeUp)).chromeUp, "the board sees the window closed");
  check(tq("look", String(l1.id)).code != 0, "tq look says when there's no window");
  const l3 = JSON.parse(tq("live", String(l1.id), "/docs", "--cmd", devServer).out || "{}");
  leftovers.push(l3.chrome?.pid);
  check(l3.chrome?.pid && l3.chrome.pid != l2.chrome.pid && l3.chromeUp && (await fetch(`http://127.0.0.1:${l3.chrome.port}/json/version`)).ok, "tq live opens a new window when the old one is gone");

  // The board: a live badge on the card and in the detail view, and the window in the detail view.
  const browser3 = await Browser.launch();
  try {
    const page = await browser3.page();
    await page.open(base + "/", { width: 1400, height: 900, clear: false });
    await Bun.sleep(600);
    const b = await page.eval(`(() => { const card = document.querySelector('.card[data-open="${l1.id}"]'); return { badge: !!card?.querySelector(".badge-live"), on: !!card?.querySelector(".badge-live.on"), live: card?.classList.contains("is-live"), others: document.querySelectorAll(".card .badge-live").length }; })()`);
    check(b.badge && b.on && b.live && b.others == 1, `the live task's card has a live badge, and no other card does (${JSON.stringify(b)})`);
    await page.eval(`document.querySelector('.card[data-open="${l1.id}"] .title').click(), true`);
    await page.settle();
    const d = await page.eval(`({ badge: !!document.querySelector("#dlg h3 .badge-live"), chrome: document.querySelector("#dlg .links")?.textContent ?? "" })`);
    check(d.badge && d.chrome.includes(`Chrome window open · DevTools port ${l3.chrome.port}`), `the detail view shows the badge and the window (${d.chrome})`);
    await page.screenshot(join(tmp, "board-live.png"));
    check(page.errors.length == 0, `no errors on the board (${page.errors})`);
  } finally { browser3.close(); }

  // Discarded: the dev server stops and the window closes.
  await api("POST", `/api/tasks/${l1.id}/discard`);
  check(await gone(l3.chrome.pid), "discarding a live task closes its Chrome window");
  await Bun.sleep(5500);
  check(!(await fetch(`http://localhost:${l1.port}/`).then(() => true, () => false)), "and stops its dev server");

  // Merged: the same.
  const lm = JSON.parse(tq("add", "--live", "Live and merged").out);
  writeFileSync(join(lm.worktree, "page.html"), "<h1>merged</h1>");
  sh(`git add page.html && git commit -qm "Live page"`, lm.worktree);
  const lm2 = JSON.parse(tq("live", String(lm.id), "--cmd", devServer).out || "{}");
  leftovers.push(lm2.chrome?.pid, -lm2.preview?.pid);
  check(lm2.chromeUp && running(lm2.chrome.pid), "a second live task has its window");
  tq("done", String(lm.id), "Live work done");
  const merged = JSON.parse(tq("merge", String(lm.id), "--wait").out || "{}");
  check(merged.status == "merged", `a live task merges like any other (${merged.error ?? merged.status})`);
  check(await gone(lm2.chrome.pid), "and merging it closes its Chrome window");
  await Bun.sleep(5500);
  check(!(await fetch(`http://localhost:${lm.port}/`).then(() => true, () => false)), "and stops its dev server");

  // ---- Restarting itself after a merge of its own code ----------------------
  // A second throwaway repo carrying the queue's code, run from there, as the real one runs from the main checkout.
  const repo2 = join(tmp, "repo2"), origin2 = join(tmp, "origin2.git"), data2 = join(tmp, "data2"), code2 = join(repo2, "development/task-queue");
  sh(`git init -q --bare -b main ${origin2}`, tmp);
  sh(`git init -q -b main ${repo2} && cd ${repo2} && git config user.email t@t && git config user.name t && mkdir -p ${code2} && cp ${join(import.meta.dir, "server.ts")} ${join(import.meta.dir, "chrome.ts")} ${join(import.meta.dir, "deps.ts")} ${join(import.meta.dir, "index.html")} ${join(import.meta.dir, "tq")} ${join(import.meta.dir, "README.md")} ${code2}/ && echo app > app.txt && git add . && git commit -qm init && git remote add origin ${origin2} && git push -q origin main`, tmp);
  const port2 = port == 4798 ? 4790 : port + 1, base2 = `http://127.0.0.1:${port2}`;
  const env2 = { ...env, TASK_QUEUE_PORT: String(port2), TASK_QUEUE_REPO: repo2, TASK_QUEUE_DATA: data2 };
  const api2 = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base2 + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { ...(await r.json()), code: r.status };
  };
  const until2 = async (id: number, pred: (t: any) => boolean, tries = 100) => {
    for (let i = 0; i < tries; i++) { try { const t = await api2("GET", `/api/tasks/${id}`); if (pred(t)) return t; } catch {} await Bun.sleep(100); }
    return api2("GET", `/api/tasks/${id}`);
  };
  const pidNow = async () => { try { return (await api2("GET", "/api")).pid; } catch { return 0; } };
  mkdirSync(data2, { recursive: true });
  const log2fd = openSync(join(data2, "server.log"), "a"); // as tq starts it
  Bun.spawn(["bun", join(code2, "server.ts")], { env: env2, stdout: log2fd, stderr: log2fd });
  for (let i = 0; i < 50 && !(selfPid = await pidNow()); i++) await Bun.sleep(100);
  const pid0 = selfPid;
  check(pid0 > 0, "a queue runs from the throwaway repo's own copy of its code");
  const preview2 = (text: string) => `bun -e 'Bun.serve({port: Number(process.env.PORT), fetch: () => new Response("${text}")})'`;
  const mergeAndWait = async (id: number) => { await api2("PATCH", `/api/tasks/${id}`, { status: "complete" }); await api2("POST", `/api/tasks/${id}/merge`); return until2(id, (t) => t.status != "merging", 200); };

  // A task still being worked on, with its preview running: it must carry on through the restart.
  const k = await api2("POST", "/api/tasks", { title: "Keeps working" });
  await api2("POST", `/api/tasks/${k.id}/preview`, { command: preview2("still here") });
  const kUp = await until2(k.id, (t) => t.previewUp);
  check(kUp.previewUp, "the working task's preview is up");

  // Merging other code, and the queue's docs, doesn't restart it.
  const a = await api2("POST", "/api/tasks", { title: "Docs and app" });
  sh(`echo more >> app.txt && echo "More docs." >> development/task-queue/README.md && git commit -qam docs`, a.worktree);
  check((await mergeAndWait(a.id)).status == "merged", "a change to the app and the queue's docs merges");
  await Bun.sleep(1500);
  check((await pidNow()) == pid0, "and the queue doesn't restart for it");

  // A board, connected.
  const browser2 = await Browser.launch();
  try {
    const page = await browser2.page();
    await page.open(base2 + "/", { width: 1400, height: 800, clear: false });
    await Bun.sleep(500);
    check(await page.eval(`document.getElementById("live").textContent == "live" && !document.body.dataset.v2`), "the board is connected");

    // Two merges: one changes the server and the board, the other (queued behind it) only the app.
    const b = await api2("POST", "/api/tasks", { title: "New server code" });
    sh(`sed -i '' 's/Local task queue for agents/Local task queue (v2) for agents/' development/task-queue/server.ts && sed -i '' 's/^connect();$/document.body.dataset.v2 = "yes"; connect();/' development/task-queue/index.html && git commit -qam v2`, b.worktree);
    const c = await api2("POST", "/api/tasks", { title: "Behind it" });
    sh(`echo behind > behind.txt && git add . && git commit -qm behind`, c.worktree);
    for (const id of [b.id, c.id]) await api2("PATCH", `/api/tasks/${id}`, { status: "complete" });
    await api2("POST", `/api/tasks/${b.id}/merge`);
    await api2("POST", `/api/tasks/${c.id}/merge`);
    let pid1 = 0;
    for (let i = 0; i < 300; i++) { pid1 = await pidNow(); if (pid1 && pid1 != pid0) break; await Bun.sleep(100); }
    check(pid1 && pid1 != pid0, `merging a change to the queue's code restarts it (pid ${pid0} → ${pid1})`);
    selfPid = pid1 || selfPid;
    const about2 = await api2("GET", "/api");
    check(about2.about.includes("(v2)"), "the restarted queue runs the new code");
    const [mb, mc] = [await api2("GET", `/api/tasks/${b.id}`), await api2("GET", `/api/tasks/${c.id}`)];
    check(mb.status == "merged" && mc.status == "merged", `both merges finished before the restart (${mb.status}, ${mc.status})`);
    check(mb.log.some((l: any) => /Branch .* deleted/.test(l.message)) && mc.log.some((l: any) => /Branch .* deleted/.test(l.message)) && !existsSync(b.worktree) && !existsSync(c.worktree), "and each merge's clean-up was done first");
    check(sh(`git --git-dir=${origin2} log --oneline main`).includes(`Merge task/${c.id}-`), "and pushed");
    const log2 = readFileSync(join(data2, "server.log"), "utf8");
    check((log2.match(/^restarting with the new code/gm) ?? []).length == 1 && log2.indexOf(`#${b.id} changed the queue's code`) < log2.indexOf(`#${c.id} merged`) && log2.indexOf(`#${c.id} merged`) < log2.indexOf("restarting with the new code"), "it restarted once, after the merge queued behind");
    const tasks2 = await api2("GET", "/api/tasks");
    check(Object.keys(tasks2).filter((x) => x != "code").length == 4, "the restarted queue has every task");
    const k2 = await api2("GET", `/api/tasks/${k.id}`);
    check(k2.status == "queued" && k2.preview?.pid == kUp.preview.pid && (await (await fetch(`http://localhost:${k.port}/`)).text()) == "still here", "the working task's preview carried on through the restart");
    check((await until2(k.id, (t) => t.previewUp)).previewUp, "and the new queue sees it up");
    for (let i = 0; i < 50 && !(await page.eval(`document.body.dataset.v2 == "yes" && document.getElementById("live").textContent == "live"`)); i++) await Bun.sleep(100);
    check(await page.eval(`document.body.dataset.v2 == "yes" && document.getElementById("live").textContent == "live"`), "the board reconnected, and loaded the new board");
    const n = await api2("POST", "/api/tasks", { title: "After the restart" });
    await Bun.sleep(500);
    check(await page.eval(`document.body.textContent.includes("After the restart")`), "and follows changes live again");
    await api2("POST", `/api/tasks/${n.id}/discard`);

    // The restarted queue merges a non-queue change without restarting again.
    const e = await api2("POST", "/api/tasks", { title: "Plain change" });
    sh(`echo plain > plain.txt && git add . && git commit -qm plain`, e.worktree);
    check((await mergeAndWait(e.id)).status == "merged", "the restarted queue merges");
    await Bun.sleep(1500);
    check((await pidNow()) == pid1, "and a merge that leaves its code alone doesn't restart it");
    check(page.errors.length == 0, `no errors on the board (${page.errors})`);

    // The code changed on disk without a merge (a commit in the main checkout, say): it restarts all the same.
    const serverLog2 = () => readFileSync(join(data2, "server.log"), "utf8");
    sh(`echo "// changed by hand" >> development/task-queue/tq && git commit -qam "tq, by hand"`, repo2);
    let pid2 = 0;
    for (let i = 0; i < 150; i++) { pid2 = await pidNow(); if (pid2 && pid2 != pid1) break; await Bun.sleep(100); }
    check(pid2 && pid2 != pid1 && /the queue's code changed \(tq\): restarting/.test(serverLog2()), `a change to its code on disk, without a merge, restarts it too (pid ${pid1} → ${pid2})`);
    selfPid = pid2 || selfPid;
    const about3 = await api2("GET", "/api");
    check(about3.running?.version && about3.running.stale?.length == 0, `GET /api says which code runs, and that it's what's on disk (${JSON.stringify(about3.running)})`);
    // New code that doesn't build: it keeps running the old code, and says why.
    const srv = join(code2, "server.ts"), good = readFileSync(srv, "utf8");
    writeFileSync(srv, good + "\nthis is not ( code\n");
    for (let i = 0; i < 100 && !serverLog2().includes("not restarting: the new code doesn't build"); i++) await Bun.sleep(100);
    const about4 = await api2("GET", "/api");
    check(serverLog2().includes("not restarting: the new code doesn't build") && about4.pid == pid2 && about4.running?.stale?.join() == "server.ts", `code that doesn't build doesn't restart it; GET /api says what changed (${about4.running?.stale})`);
    writeFileSync(srv, good);
    await Bun.sleep(4000);
    check((await pidNow()) == pid2, "the change undone: nothing to restart for");
    // tq restart asks for one.
    const asked = Bun.spawnSync([join(import.meta.dir, "tq"), "restart"], { env: env2, stdout: "pipe", stderr: "pipe" });
    let pid3 = 0;
    for (let i = 0; i < 150; i++) { pid3 = await pidNow(); if (pid3 && pid3 != pid2) break; await Bun.sleep(100); }
    check(asked.exitCode == 0 && pid3 && pid3 != pid2, `tq restart restarts it (pid ${pid2} → ${pid3})`);
    selfPid = pid3 || selfPid;
  } finally { browser2.close(); }
  await api2("POST", `/api/tasks/${k.id}/discard`);
} catch (e) {
  if (e !== "done") throw e;
} finally {
  server.kill();
  for (const pid of leftovers) if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
  if (selfPid) try { process.kill(selfPid); } catch {}
  try { watcher?.kill(); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passing");
process.exit(failures ? 1 : 0);

/** Dependencies between tasks, on the first queue. */
async function dependencies() {
  const lines: string[] = [];
  const w = Bun.spawn([join(import.meta.dir, "tq"), "watch"], { env, stdout: "pipe", stderr: "pipe" });
  (async () => {
    const reader = (w.stdout as ReadableStream<Uint8Array>).getReader(); let buf = "";
    for (;;) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } }
  })();
  const line = async (want: string) => { for (let i = 0; i < 60 && !lines.includes(want); i++) await Bun.sleep(100); return lines.includes(want); };
  const commit = (t: any, file: string) => sh(`echo ${file} > ${file}.txt && git add . && git commit -qm ${file}`, t.worktree);
  try {
    await Bun.sleep(800); // the watch's baseline
    const about = await api("GET", "/api");
    check(about.dependencies?.startAfter && about.dependencies.mergeAfter && about.dependencies.blockedBy && /startAfter/.test(Object.keys(about.endpoints).join(" ")), "GET /api documents dependencies");

    const a = await api("POST", "/api/tasks", { title: "Dep A: the API" });
    const b = await api("POST", "/api/tasks", { title: "Dep B: uses the API", startAfter: [a.id] });
    const c = await api("POST", "/api/tasks", { title: "Dep C: lands after A", mergeAfter: [a.id] });
    check(b.code == 201 && b.startAfter?.[0] == a.id && b.blockedBy?.start?.[0] == a.id && b.blockedBy.reason == `waiting for #${a.id} to merge`, `POST takes startAfter, and blockedBy says what it waits for (${b.blockedBy?.reason})`);
    check(c.mergeAfter?.[0] == a.id && c.blockedBy?.start.length == 0 && c.blockedBy.merge[0] == a.id && c.blockedBy.reason == `can't merge until #${a.id} merges`, `POST takes mergeAfter (${c.blockedBy?.reason})`);
    check(!a.blockedBy && (await api("GET", `/api/tasks/${a.id}`)).blockedBy === undefined, "a task without dependencies has no blockedBy");
    check(await line(`#${b.id} queued: Dep B: uses the API: waiting for #${a.id} to merge`), "tq watch says what a new task waits for");
    const saved = JSON.parse(readFileSync(join(data, "tasks.json"), "utf8")).tasks.find((t: any) => t.id == b.id);
    check(saved.startAfter?.[0] == a.id && !("blockedBy" in saved), "dependencies are saved in tasks.json; blockedBy isn't (it's computed)");

    // Ids checked, cycles refused.
    const bad = await api("POST", "/api/tasks", { title: "Bad", startAfter: [9999] });
    check(bad.code == 400 && /no task 9999/.test(bad.error), `an unknown id is refused (${bad.error})`);
    check((await api("PATCH", `/api/tasks/${a.id}`, { startAfter: [a.id] })).code == 400, "a task can't depend on itself");
    const cyc = await api("PATCH", `/api/tasks/${a.id}`, { mergeAfter: [b.id] });
    check(cyc.code == 400 && cyc.error.includes(`cycle: #${a.id} waits for #${b.id} waits for #${a.id}`), `a cycle is refused (${cyc.error})`);
    const d = await api("POST", "/api/tasks", { title: "Dep D", mergeAfter: [c.id], worktree: false });
    const cyc2 = await api("PATCH", `/api/tasks/${a.id}`, { startAfter: [d.id] });
    check(cyc2.code == 400 && cyc2.error.includes(`#${a.id} waits for #${d.id} waits for #${c.id} waits for #${a.id}`), `a longer cycle is refused (${cyc2.error})`);
    check((await api("GET", `/api/tasks/${a.id}`)).startAfter === undefined, "and nothing changed");
    check((await api("PATCH", `/api/tasks/${d.id}`, { mergeAfter: null })).mergeAfter === undefined, "PATCH with null clears a dependency list");

    // Start refused until A merges.
    const s1 = await api("PATCH", `/api/tasks/${b.id}`, { status: "working" });
    check(s1.code == 409 && s1.error.includes(`waiting for #${a.id} to merge`), `PATCH status working is refused while a startAfter task isn't merged (${s1.error})`);
    const s2 = tq("start", String(b.id));
    check(s2.code == 1 && s2.err.includes(`waiting for #${a.id}`), "tq start says why");
    check((await api("POST", `/api/tasks/${b.id}/live`)).code == 409, "and live mode can't start it either");
    check((await api("GET", `/api/tasks/${b.id}`)).status == "queued", "it stays queued");

    // Merge refused until A merges.
    commit(c, "c");
    await api("PATCH", `/api/tasks/${c.id}`, { status: "working" });
    await api("PATCH", `/api/tasks/${c.id}`, { status: "complete", summary: "C" });
    const m1 = await api("POST", `/api/tasks/${c.id}/merge`);
    check(m1.code == 409 && m1.error.includes(`can't merge until #${a.id} merges`), `POST merge is refused while a mergeAfter task isn't merged (${m1.error})`);
    check(tq("merge", String(c.id)).code == 1 && (await api("GET", `/api/tasks/${c.id}`)).status == "complete", "tq merge too, and it stays ready to merge");

    // The CLI.
    const x = JSON.parse(tq("add", "Dep X", "ask", "--after", `${a.id},${b.id}`, "--merge-after", String(c.id)).out || "{}");
    check(x.startAfter?.join() == `${a.id},${b.id}` && x.mergeAfter?.join() == String(c.id) && x.description == "ask", `tq add --after --merge-after (${JSON.stringify([x.startAfter, x.mergeAfter])})`);
    const shown = JSON.parse(tq("deps", String(x.id)).out || "{}");
    check(shown.startAfter?.length == 2 && shown.blockedBy?.reason == `waiting for #${a.id} and #${b.id} to merge`, `tq deps shows them (${shown.blockedBy?.reason})`);
    const x2 = JSON.parse(tq("deps", String(x.id), "--after", "none").out || "{}");
    check(x2.startAfter?.length == 0 && x2.mergeAfter?.[0] == c.id && x2.blockedBy?.reason == `can't merge until #${c.id} merges`, "tq deps --after none clears startAfter");
    const x3 = JSON.parse(tq("deps", String(x.id), "--clear", "--merge-after", String(a.id)).out || "{}");
    check(x3.startAfter?.length == 0 && x3.mergeAfter?.join() == String(a.id), "tq deps --clear --merge-after replaces both");
    check(tq("deps", String(x.id), "--after", String(x.id)).code == 1, "tq deps refuses a bad dependency");
    const listed = JSON.parse(tq("list", "queued").out || "[]").find((t: any) => t.id == b.id);
    check(listed?.startAfter?.[0] == a.id && listed.blockedBy == `waiting for #${a.id} to merge`, "tq list shows dependencies and what blocks a task");
    check(/tq deps ID/.test(tq("help").out) && /--merge-after/.test(tq("help").out) && /unblocked/.test(tq("help").out), "tq help documents them");
    await api("POST", `/api/tasks/${x.id}/discard`);

    // The board: B's chip, C's Merge off with the reason, and C's dependencies in its detail view.
    const browser = await Browser.launch();
    try {
      const page = await browser.page();
      await page.open(base + "/", { width: 1500, height: 900, clear: false });
      await Bun.sleep(600);
      const v = await page.eval(`(() => { const card = (id) => document.querySelector('.card[data-open="' + id + '"]');
        const m = card(${c.id})?.querySelector(".actions button.primary");
        return { chip: card(${b.id})?.querySelector(".chip")?.textContent, blocked: card(${b.id})?.classList.contains("blocked"), aChip: !!card(${a.id})?.querySelector(".chip"),
          cChip: card(${c.id})?.querySelector(".chip")?.textContent, mergeOff: m?.disabled, mergeTitle: m?.title, why: card(${c.id})?.querySelector(".why")?.textContent,
          queued: [...document.querySelectorAll('[data-col="queued"] .card')].map((c) => Number(c.dataset.open)) }; })()`);
      check(v.chip == `waiting for #${a.id}` && v.blocked && !v.aChip, `a card waiting to start has a "waiting for" chip and sits back (${JSON.stringify(v)})`);
      check(v.queued.indexOf(a.id) < v.queued.indexOf(b.id), "in Queued, the tasks that can start come first");
      check(v.cChip == `merges after #${a.id}` && v.mergeOff && v.mergeTitle == `Can't merge until #${a.id} merges` && v.why == v.mergeTitle, `Merge is disabled with the reason (${v.why})`);
      await page.eval(`document.querySelector('.card[data-open="${c.id}"] .title').click(), true`);
      await page.settle();
      const dv = await page.eval(`({ rows: [...document.querySelectorAll("#dlg .dep")].map((r) => r.querySelector(".kind").textContent + ": " + r.querySelector("a").textContent + " (" + r.querySelector(".status").textContent + ")"), link: document.querySelector("#dlg .dep a")?.dataset.open, merge: document.querySelector("#dlg .actions button.primary")?.disabled })`);
      check(dv.rows.length == 1 && dv.rows[0] == `Merges after: #${a.id} Dep A: the API (Queued)` && dv.link == String(a.id) && dv.merge, `the detail view lists the dependency, with a link (${JSON.stringify(dv)})`);
      // Add one (merge after D), then remove it with its ×.
      await page.eval(`document.getElementById("dep-kind").value = "mergeAfter", document.getElementById("dep-id").value = "${d.id}", document.querySelector('#dlg [data-act="dep"]').click(), true`);
      const added = await until(c.id, (t) => t.mergeAfter?.includes(d.id));
      await page.settle(); await Bun.sleep(200);
      check(added.mergeAfter?.join() == `${a.id},${d.id}` && (await page.eval(`document.querySelectorAll("#dlg .dep").length`)) == 2, "the detail view adds a dependency");
      await page.screenshot(join(tmp, "deps-detail.png"));
      await page.eval(`document.querySelector('#dlg [data-act="undep"][data-dep="${d.id}"]').click(), true`);
      const removed = await until(c.id, (t) => !t.mergeAfter?.includes(d.id));
      check(removed.mergeAfter?.join() == String(a.id), "and its × removes it");
      // A cycle from the board: the error shows in the detail view.
      await page.eval(`document.querySelector('.card[data-open="${a.id}"] .title').click(), true`);
      await page.settle();
      await page.eval(`document.getElementById("dep-kind").value = "startAfter", document.getElementById("dep-id").value = "${b.id}", document.querySelector('#dlg [data-act="dep"]').click(), true`);
      await Bun.sleep(500);
      check((await page.eval(`document.querySelector("#dlg .err")?.textContent ?? ""`)).includes("cycle"), "a cycle added on the board is refused, and the detail view says why");
      await page.eval(`document.querySelector('#dlg [data-act="close"]').click(), true`);
      await page.screenshot(join(tmp, "deps-board.png"));
      check(page.errors.length == 0, `no errors on the board (${page.errors})`);
    } finally { browser.close(); }
    await api("POST", `/api/tasks/${d.id}/discard`);

    // A merges: B can start, C can merge.
    commit(a, "a");
    await api("PATCH", `/api/tasks/${a.id}`, { status: "complete" });
    const ma = JSON.parse(tq("merge", String(a.id), "--wait").out || "{}");
    check(ma.status == "merged", `A merges (${ma.error ?? ma.status})`);
    const [b2, c2] = [await api("GET", `/api/tasks/${b.id}`), await api("GET", `/api/tasks/${c.id}`)];
    check(!b2.blockedBy && !c2.blockedBy, "its dependents aren't blocked any more");
    check(b2.log.at(-1).message == `#${a.id} merged: unblocked: it can start now` && c2.log.at(-1).message == `#${a.id} merged: unblocked: it can merge now`, `their logs say so (${b2.log.at(-1).message})`);
    check(await line(`#${b.id} unblocked: Dep B: uses the API (#${a.id} merged)`), `tq watch: "#${b.id} unblocked: ... (#${a.id} merged)" (${JSON.stringify(lines.slice(-4))})`);
    check(await line(`#${c.id} unblocked for merge: Dep C: lands after A (#${a.id} merged)`), "and C unblocked for merge");
    check(tq("start", String(b.id)).code == 0, "B starts now");
    check((await api("POST", `/api/tasks/${c.id}/merge`)).code == 202 && (await until(c.id, (t) => t.status != "merging")).status == "merged", "C merges now");

    // The race: F asks to merge while E, its dependency, waits to merge (behind G); E's merge fails, so F's must too.
    const g = await api("POST", "/api/tasks", { title: "Dep G: slow" });
    const e = await api("POST", "/api/tasks", { title: "Dep E: dirty" });
    const f = await api("POST", "/api/tasks", { title: "Dep F: after E", mergeAfter: [e.id] });
    sh(`echo "sleep 1" > check.sh && git add check.sh && git commit -qm g`, g.worktree); // so G's merge takes a second (its check)
    commit(e, "e"); writeFileSync(join(e.worktree, "notes.txt"), "dirty\n");
    commit(f, "f");
    for (const t of [g, e, f]) await api("PATCH", `/api/tasks/${t.id}`, { status: "complete" });
    await api("POST", `/api/tasks/${g.id}/merge`);
    await api("POST", `/api/tasks/${e.id}/merge`);
    const qf = await api("POST", `/api/tasks/${f.id}/merge`);
    check(qf.code == 202 && qf.log.at(-1).message.includes(`#${e.id}`), "a merge may be asked for while its dependency is merging (queued ahead of it)");
    const f2 = await until(f.id, (t) => t.status != "merging");
    const e2 = await api("GET", `/api/tasks/${e.id}`);
    check((await api("GET", `/api/tasks/${g.id}`)).status == "merged" && e2.status == "needs-agent", `G merges, E's merge stops for its agent (${e2.status})`);
    check(f2.status == "complete" && f2.error?.includes(`Can't merge until #${e.id} merges`), `when F's turn comes, E isn't merged: F's merge fails back to ready to merge, saying why (${f2.error})`);

    // E discarded: F is blocked for good, until its dependency changes.
    await api("POST", `/api/tasks/${e.id}/discard`);
    const f3 = await api("GET", `/api/tasks/${f.id}`);
    check(f3.blockedBy?.stuck?.[0] == e.id && f3.blockedBy.reason == `blocked: #${e.id} was discarded; remove or change the dependency`, `a discarded dependency blocks it, with the reason (${f3.blockedBy?.reason})`);
    check(f3.log.at(-1).message.startsWith(`#${e.id} was discarded: this task is blocked`), "its log says so");
    check(await line(`#${f.id} blocked: Dep F: after E: blocked: #${e.id} was discarded; remove or change the dependency`), "tq watch says it's blocked");
    check((await api("POST", `/api/tasks/${f.id}/merge`)).code == 409, "its merge is refused");
    check((await api("POST", "/api/tasks", { title: "On a discarded one", startAfter: [e.id] })).code == 400, "a discarded task can't become a dependency");
    tq("deps", String(f.id), "--clear");
    check((await api("POST", `/api/tasks/${f.id}/merge`)).code == 202 && (await until(f.id, (t) => t.status != "merging")).status == "merged", "with the dependency removed, it merges");

    // A failed dependency blocks too, and stops blocking when it's back at work.
    const h = await api("POST", "/api/tasks", { title: "Dep H", worktree: false });
    const i = await api("POST", "/api/tasks", { title: "Dep I", startAfter: [h.id], worktree: false });
    await api("PATCH", `/api/tasks/${h.id}`, { status: "failed", error: "broke" });
    const i2 = await api("GET", `/api/tasks/${i.id}`);
    check(i2.blockedBy?.stuck?.[0] == h.id && /#\d+ failed; remove or change the dependency \(or fix and merge it\)/.test(i2.blockedBy.reason), `a failed dependency blocks it (${i2.blockedBy?.reason})`);
    await api("PATCH", `/api/tasks/${h.id}`, { status: "working" });
    check((await api("GET", `/api/tasks/${i.id}`)).blockedBy?.reason == `waiting for #${h.id} to merge`, "back at work, it's only waited for");
    for (const t of [h, i, b]) await api("POST", `/api/tasks/${t.id}/discard`);
    check(!lines.some((l) => !/^#\d+ [a-z ,]+: /.test(l)), `tq watch prints nothing but its lines (${lines.filter((l) => !/^#\d+ [a-z ,]+: /.test(l))})`);
  } finally { w.kill(); }
}

/** Origin as Erga has it (TASK_QUEUE_ORIGIN, TASK_QUEUE_LOGIN), on a queue of its own over a third throwaway repo. */
async function originPart() {
  const repo3 = join(tmp, "repo3"), gh = join(tmp, "gh.git"), erga = join(tmp, "erga.git"), data3 = join(tmp, "data3");
  const approved = join(tmp, "approved"), logins = join(tmp, "logins.txt"), refuse = join(tmp, "refuse");
  sh(`git init -q --bare -b main ${gh}`, tmp);
  sh(`git init -q -b main ${repo3} && cd ${repo3} && git config user.email t@t && git config user.name t && echo app > app.txt && git add . && git commit -qm init && git remote add origin ${gh} && git push -q origin main`, tmp);
  // Erga's repository: staging and main, at main's commit; it refuses pushes while the file `refuse` is there.
  sh(`git clone -q --bare ${gh} ${erga} && git --git-dir=${erga} branch staging main`, tmp);
  writeFileSync(join(erga, "hooks/pre-receive"), `#!/bin/bash\nif [ -e ${refuse} ]; then echo "Erga: not now"; exit 1; fi\nwhile read old new ref; do echo "Erga: \${ref#refs/heads/} is now \${new:0:7}"; done\n`, { mode: 0o755 });
  // The stand-in for `bun source/git-credential.ts login`: the first time, it says where to approve and waits for it.
  const login = join(tmp, "login.sh");
  writeFileSync(login, `#!/bin/bash\necho login >> ${logins}\n[ -e ${approved} ] && exit 0\necho '{"approve_url":"https://erga.example/tokens/approve?code=WXYZ","user_code":"WXYZ"}' > "$ERGA_LOGIN_NOTICE"\nfor i in $(seq 200); do [ -e ${approved} ] && echo "approved" && exit 0; sleep 0.1; done\necho "nobody approved it"; exit 1\n`, { mode: 0o755 });
  sh("echo dirty >> app.txt", repo3); // a dirty checkout: origin is left alone until it's clean
  const port3 = port == 4790 ? 4798 : port - 1, base3 = `http://127.0.0.1:${port3}`;
  const env3 = { ...env, TASK_QUEUE_PORT: String(port3), TASK_QUEUE_REPO: repo3, TASK_QUEUE_DATA: data3, TASK_QUEUE_ORIGIN: erga, TASK_QUEUE_LOGIN: login, TASK_QUEUE_ORIGIN_HELPER: "!true" };
  const api3 = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base3 + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { ...(await r.json()), code: r.status };
  };
  const head = (b: string) => Bun.spawnSync(["git", "rev-parse", "-q", "--verify", `refs/heads/${b}`], { cwd: erga }).stdout.toString().trim();
  const cfg = (k: string) => Bun.spawnSync(["git", "config", "--get-all", k], { cwd: repo3 }).stdout.toString().trim();
  const q = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], { env: env3, stdout: "ignore", stderr: "ignore" });
  const w = Bun.spawn([join(import.meta.dir, "tq"), "watch"], { env: env3, stdout: "pipe", stderr: "ignore" });
  const lines: string[] = [];
  (async () => { const dec = new TextDecoder(); for await (const c of w.stdout as ReadableStream<Uint8Array>) lines.push(...dec.decode(c).split("\n").filter(Boolean)); })();
  const merged = async (id: number) => { let t: any; for (let i = 0; i < 300; i++) { t = await api3("GET", `/api/tasks/${id}`); if (t.status != "merging") break; await Bun.sleep(100); } return t; };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base3 + "/api"); break; } catch { await Bun.sleep(100); } }
    await Bun.sleep(2500);
    check(cfg("remote.origin.url") == gh, "while the main checkout has uncommitted changes, origin is left alone");
    sh("git checkout -q app.txt", repo3);
    for (let i = 0; i < 60 && cfg("remote.origin.url") != erga; i++) await Bun.sleep(100);
    check(cfg("remote.origin.url") == erga && cfg("remote.github.url") == gh, `once it's clean, origin is Erga's and the old origin is github (${cfg("remote.origin.url")}, ${cfg("remote.github.url")})`);
    check(cfg("remote.origin.push") == "refs/heads/main:refs/heads/staging", "main pushes to origin's staging");
    check(cfg(`credential.${erga}.helper`) == "", "a path origin gets no credential helper (only an https one does)");
    check(sh("git rev-parse -q --verify refs/remotes/github/main", repo3) == sh("git rev-parse main", repo3), "the old origin's refs are github's now");

    // Signing in waits for an approval: the board, GET /api/history and tq watch say where.
    let h: any;
    for (let i = 0; i < 50 && !(h = await api3("GET", "/api/history")).login; i++) await Bun.sleep(100);
    check(h.login?.approve_url == "https://erga.example/tokens/approve?code=WXYZ" && h.login.user_code == "WXYZ", "GET /api/history says where to approve this machine");
    const browser = await Browser.launch();
    try {
      const page = await browser.page();
      await page.open(base3 + "/", { width: 1400, height: 800 });
      await Bun.sleep(500);
      const b = await page.eval(`({ shown: !document.getElementById("login").hidden, text: document.getElementById("login").textContent, link: document.querySelector("#login a")?.href, legend: document.getElementById("origin-branch").textContent })`);
      check(b.shown && b.link == "https://erga.example/tokens/approve?code=WXYZ" && b.text.includes("WXYZ"), `the board shows the link to approve, with its code (${b.text})`);
      check(b.legend == "origin/staging", `the board's Branches column compares main with origin/staging (${b.legend})`);
      if (process.env.TQ_SHOTS) await page.screenshot(join(process.env.TQ_SHOTS, "origin-login.png"));
      for (let i = 0; i < 30 && !lines.some((l) => l.startsWith("origin sign-in:")); i++) await Bun.sleep(100);
      check(lines.includes("origin sign-in: open https://erga.example/tokens/approve?code=WXYZ and approve it (code WXYZ), so the queue can fetch and push"), `tq watch says so, once (${lines})`);
      writeFileSync(approved, "");
      for (let i = 0; i < 50 && ((h = await api3("GET", "/api/history")).login || cfg("branch.main.merge") != "refs/heads/staging"); i++) await Bun.sleep(100);
      check(!h.login && cfg("branch.main.remote") == "origin" && cfg("branch.main.merge") == "refs/heads/staging", "approved: the notice goes, origin is fetched and main tracks origin/staging");
      await Bun.sleep(300);
      check(await page.eval(`document.getElementById("login").hidden`), "and the board's notice goes, live");
    } finally { browser.close(); }

    // A commit made in Erga (a factory task): merged into the task's branch, and main goes to staging only.
    const other = join(tmp, "erga-clone");
    sh(`git clone -q -b staging ${erga} ${other} && cd ${other} && git config user.email t@t && git config user.name t && echo factory > factory.txt && git add . && git commit -qm "Made in Erga" && git push -q origin HEAD:staging`, tmp);
    const main0 = head("main");
    const t = await api3("POST", "/api/tasks", { title: "Origin task" });
    sh(`echo task > task.txt && git add . && git commit -qm "The task"`, t.worktree);
    await api3("PATCH", `/api/tasks/${t.id}`, { status: "complete" });
    await api3("POST", `/api/tasks/${t.id}/merge`);
    let done = await merged(t.id);
    const main3 = sh("git rev-parse main", repo3);
    check(done.status == "merged", `the task merges (${done.status}: ${done.error ?? ""})`);
    check(existsSync(join(repo3, "factory.txt")) && existsSync(join(repo3, "task.txt")), "main has the task and Erga's commit");
    check(head("staging") == main3 && head("main") == main0, "origin's staging is main; origin's main didn't move");
    check(/pushed to origin's staging: .*Erga: staging is now/.test(done.log.find((l: any) => l.message.startsWith("Merged into"))?.message ?? ""), `the task's log says where it went, with what origin said (${done.log.at(-1).message})`);
    h = await api3("GET", "/api/history");
    check(h.originBranch == "staging" && h.unpushed == 0 && h.unreleased == 4 && h.pushed?.ok, `GET /api/history: pushed to staging, 4 commits not on origin's main (${h.originBranch}, ${h.unpushed}, ${h.unreleased})`);

    // Production is a deliberate step: tq release.
    const r = Bun.spawnSync([join(import.meta.dir, "tq"), "release"], { env: env3, stdout: "pipe", stderr: "pipe" });
    check(r.exitCode == 0 && head("main") == main3 && r.stdout.toString().includes("Erga: main is now"), `tq release moves origin's main to staging (${(r.stdout.toString() + r.stderr.toString()).trim()})`);
    check((await api3("GET", "/api/history")).unreleased == 0, "and nothing is left to release");
    const again = Bun.spawnSync([join(import.meta.dir, "tq"), "release"], { env: env3, stdout: "pipe" });
    check(again.exitCode == 0 && again.stdout.toString().includes("has"), `releasing again: nothing to do (${again.stdout.toString().trim()})`);

    // Origin refuses the push: merged all the same, the log says why, and it's pushed by itself once origin takes it.
    writeFileSync(refuse, "");
    const t2 = await api3("POST", "/api/tasks", { title: "Refused by origin" });
    sh(`echo two > two.txt && git add . && git commit -qm "Second task"`, t2.worktree);
    await api3("PATCH", `/api/tasks/${t2.id}`, { status: "complete" });
    await api3("POST", `/api/tasks/${t2.id}/merge`);
    done = await merged(t2.id);
    const msg = done.log.find((l: any) => l.message.startsWith("Merged into"))?.message ?? "";
    check(done.status == "merged" && head("staging") != sh("git rev-parse main", repo3) && /didn't take it: .*Erga: not now/.test(msg), `a refused push doesn't undo the merge, and the log says why (${msg})`);
    rmSync(refuse);
    for (let i = 0; i < 200 && head("staging") != sh("git rev-parse main", repo3); i++) await Bun.sleep(100);
    check(head("staging") == sh("git rev-parse main", repo3) && head("main") == main3, "once origin takes it, the merge goes to staging by itself (and still not to main)");
    check(readFileSync(logins, "utf8").split("\n").filter(Boolean).length >= 3, "it signed in before talking to origin");
  } finally { q.kill(); w.kill(); }
}
