#!/usr/bin/env bun
// A sample board, for working on the board itself: a throwaway repo (with a
// bare "origin") whose main has a history of merged tasks, a few commits not
// pushed yet, and tasks in every state (one of them live), served by this server.ts. Never
// touches this repo or the real queue's data.
//
//   bun development/task-queue/sample.ts [--tick SECONDS]
//
// It serves on $PORT (4507). --tick adds a commit to main every SECONDS and
// pushes every other one, to watch the Branches column update live.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.PORT ?? 4507);
const tickAt = process.argv.indexOf("--tick");
const tick = tickAt > 0 ? Number(process.argv[tickAt + 1] ?? 10) : 0;

const tmp = mkdtempSync(join(tmpdir(), "tq-sample-"));
const repo = join(tmp, "repo"), origin = join(tmp, "origin.git"), data = join(tmp, "data");
mkdirSync(data);
let clock = Date.now() - 40 * 3600_000;
const sh = (cmd: string, cwd = repo) => {
  clock += 37 * 60_000;
  const date = new Date(clock).toISOString();
  const r = Bun.spawnSync(["bash", "-c", cmd], { cwd, stderr: "pipe", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  if (r.exitCode != 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
sh(`git init -q --bare -b main ${origin}`, tmp);
sh(`git init -q -b main ${repo} && cd ${repo} && git config user.email sample@example.com && git config user.name Sample && echo "# Sample" > README.md && git add . && git commit -qm "Initial commit" && git remote add origin ${origin}`, tmp);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");
const now = () => new Date(clock).toISOString();
const tasks: any[] = [];
let id = 0;
const task = (title: string, status: string, extra: Record<string, unknown> = {}) => {
  id++;
  const t = { id, title, description: `Sample task: ${title}.`, status, branch: `task/${id}-${slug(title)}`, screenshots: [], log: [{ at: now(), message: "Registered" }], createdAt: now(), updatedAt: now(), ...extra };
  tasks.push(t);
  return t;
};
/** A task done the queue's way: a branch with a commit, merged into main with --no-ff. */
const merged = (title: string) => {
  const t = task(title, "merged");
  sh(`git checkout -qb ${t.branch} && echo "${title}" > task-${t.id}.txt && git add . && git commit -qm "${title}" && git checkout -q main && git merge -q --no-ff -m "Merge ${t.branch}: ${title}" -m "Task ${t.id} from the task queue." ${t.branch} && git branch -qd ${t.branch}`);
  Object.assign(t, { commit: sh("git rev-parse --short HEAD"), mergedAt: now(), updatedAt: now() });
  t.log.push({ at: now(), message: `Merged into main as ${t.commit}` });
};
const direct = (subject: string) => sh(`echo "${subject}" >> README.md && git commit -qam "${subject}"`);

const pushed = [
  "Sign in with GitHub", "Document titles follow the first heading", "Share a document by link", "Rename from the top bar",
  "Undo across reloads", "Markdown tables", "Source view toggle", "Presence carets", "Admin users page", "Token page",
  "Dark mode", "Paste images", "Search documents", "Keyboard shortcuts help", "Export to Markdown",
];
pushed.forEach((title, i) => { merged(title); if (i % 2 == 1) direct(`README: ${title.toLowerCase()}`); });
task("Try a different editor model", "discarded", { log: [{ at: now(), message: "Discarded" }] });
direct("Fix a flaky presence test");
sh("git push -q origin main");
// Merged and committed since the last push: on local main only.
merged("Comments in the margin");
direct("Tighten the docs list spacing");
merged("Version history panel");

task("Offline editing", "queued");
task("Agent can insert images", "working", { log: [{ at: now(), message: "Registered" }, { at: now(), message: "Wiring the image tool into the agent" }] });
task("Tighten the docs list", "working", { live: true, previewUp: true, chromeUp: true, url: "http://localhost:4502/docs", log: [{ at: now(), message: "Live: worked on in a session with the user" }, { at: now(), message: "Chrome window opened on http://localhost:4502/docs" }] });
task("Print stylesheet", "complete", { summary: "Adds a print stylesheet; checked in headless Chrome's print preview." });
task("Mobile toolbar", "failed", { error: "Tests fail on the toolbar overflow menu." });

writeFileSync(join(data, "tasks.json"), JSON.stringify({ nextId: id + 1, tasks }, null, 2));

const server = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
  env: { ...process.env, TASK_QUEUE_PORT: String(port), TASK_QUEUE_REPO: repo, TASK_QUEUE_DATA: data, TASK_QUEUE_INSTALL: "0", TASK_QUEUE_FETCH: "0" },
  stdout: "inherit", stderr: "inherit",
});
console.log(`sample board on http://localhost:${port} (repo ${repo})`);

if (tick) {
  let n = 0;
  setInterval(() => {
    clock = Date.now();
    n++;
    direct(`Sample commit ${n}`);
    if (n % 2 == 0) sh("git push -q origin main");
  }, tick * 1000);
}

const stop = () => { server.kill(); rmSync(tmp, { recursive: true, force: true }); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await server.exited;
rmSync(tmp, { recursive: true, force: true });
