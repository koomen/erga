#!/usr/bin/env bun
// End-to-end test of the task queue against a throwaway repo (with a bare
// "origin" to push to), never this one:
//
//   bun development/task-queue/test.ts
//
// Registers tasks, commits in their worktrees, runs a preview, attaches
// screenshots (one taken by headless Chrome), removes them (one, all, tq shot
// --replace; not while merging; the board's ×), merges and pushes (through the
// merging status), merges a conflicting task with a stand-in resolver, fails
// a merge back to complete (with tq merge --wait), recovers a merge cut off by
// a restart, and discards one; tq watch follows it all, through the restart.
// Then main's history (the Branches column):
// its order, which commits are only local, done tasks matched to their merge
// commits, live updates on a commit, a push, a fetch and a merge, and the
// board (Branches in place of a Done column) in headless Chrome.
// Last, a queue run from a throwaway repo's own copy of its code: merging a
// change to that code restarts it with the new code (after the merge queued
// behind, once), keeping tasks, previews and a board connected in headless
// Chrome (which loads the new board); other merges don't restart it.
// And live mode: tq add --live, tq live (the dev server, and a Chrome window of
// its own, launched headless here, reattached, relaunched when closed), tq look
// (url, title, selection, console, a screenshot), the board's live badge, and
// the window and dev server stopped on discard and on merge.

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
// The stand-in for claude -p: keeps both sides of every conflict (taking a moment, so the merge is seen merging).
const resolver = `sleep 1; for f in $(git diff --name-only --diff-filter=U); do grep -v -e '^<<<<<<<' -e '^=======' -e '^>>>>>>>' "$f" > "$f.x" && mv "$f.x" "$f" && git add "$f"; done; git commit -q --no-edit`;
const env = { ...process.env, TASK_QUEUE_PORT: String(port), TASK_QUEUE_REPO: repo, TASK_QUEUE_DATA: data, TASK_QUEUE_RESOLVER: resolver, TASK_QUEUE_INSTALL: "0", TASK_QUEUE_FETCH: "2", TASK_QUEUE_CHROME_HEADLESS: "1" };
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

let watcher: ReturnType<typeof Bun.spawn> | undefined;
/** Live mode's windows and dev servers, killed at the end if the test stops before the queue does. */
const leftovers: number[] = [];
let selfPid = 0;
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
  check((await api("DELETE", `/api/tasks/${t3.id}/screenshots`)).code == 409 && tq("unshot", String(t3.id), "1").code == 1, "a merging task's screenshots can't be removed");
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
  check(watchLines.includes(`#${t4.id} merge failed, back to ready to merge: Dirty: ${m4.error.replace(/\s+/g, " ")}`), "tq watch says when a merge failed, with why");
  const d4 = await api("POST", `/api/tasks/${t4.id}/discard`);
  check(d4.status == "discarded" && !existsSync(t4.worktree) && !sh("git branch --list task/4-*"), "discard removes worktree and branch");
  for (let i = 0; i < 50 && watchLines.at(-1) != `#${t4.id} discarded: Dirty`; i++) await Bun.sleep(100);
  check(watchLines.at(-1) == `#${t4.id} discarded: Dirty`, `tq watch reconnects after the server restarts (${watchLines.at(-1)})`);
  check(!watchLines.some((l) => !/^#\d+ [a-z ,]+: /.test(l)), "tq watch prints nothing but status lines");

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

  check(JSON.parse(readFileSync(join(data, "tasks.json"), "utf8")).tasks.length == 5, "tasks are saved to disk");

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
  check(h0.commits.map((c: any) => c.task ?? c.subject).join(",") == "3,2,1,init", `history is main's first-parent line, newest first, merges matched to tasks (${h0.commits.map((c: any) => c.task ?? c.subject)})`);
  check(h0.commits.every((c: any) => c.remote) && h0.unpushed == 0 && h0.behind == 0 && h0.origin, "everything merged is on origin/main");
  check(h0.tasks[1]?.sha.startsWith(m1.commit) && h0.tasks[3]?.index == 0 && h0.tasks[2]?.index == 1 && !h0.tasks[4], "done tasks map to their merge commits and places; a discarded one has none");
  check((await seen((h) => h.commits?.length == 4)).commits?.length == 4, "the event stream sends the history on connect");

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
  check(h4.commits?.length == 25 && h4.unpushed == 26 && h4.tasks?.[1]?.index == 30 && h4.tasks[1].remote, `25 commits shown, the 26 unpushed counted, older task merges still matched (${h4.commits?.length}, ${h4.unpushed}, ${h4.tasks?.[1]?.index})`);

  // The board: no Done column; Branches after Merging, a row per commit, live, a task's row opening it.
  const browser = await Browser.launch();
  try {
    const page = await browser.page();
    for (const dark of [false, true]) {
      await page.open(base + "/", { width: 1600, height: 900, dark, clear: false });
      await Bun.sleep(500);
      const b = await page.eval(`({ rows: document.querySelectorAll("#graph li").length, unpushed: document.querySelectorAll("#graph .lane.o.no").length,
        cols: [...document.querySelectorAll("main section")].map((c) => c.dataset.col).join(","), n: document.getElementById("branches-n").textContent })`);
      check(b.cols == "queued,working,ready-to-merge,merging,branches", `${dark ? "dark" : "light"}: no Done column; Branches comes after Merging (${b.cols})`);
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
  sh(`git init -q -b main ${repo2} && cd ${repo2} && git config user.email t@t && git config user.name t && mkdir -p ${code2} && cp ${join(import.meta.dir, "server.ts")} ${join(import.meta.dir, "chrome.ts")} ${join(import.meta.dir, "index.html")} ${join(import.meta.dir, "tq")} ${join(import.meta.dir, "README.md")} ${code2}/ && echo app > app.txt && git add . && git commit -qm init && git remote add origin ${origin2} && git push -q origin main`, tmp);
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
  } finally { browser2.close(); }
  await api2("POST", `/api/tasks/${k.id}/discard`);
} finally {
  server.kill();
  for (const pid of leftovers) if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
  if (selfPid) try { process.kill(selfPid); } catch {}
  try { watcher?.kill(); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passing");
process.exit(failures ? 1 : 0);
