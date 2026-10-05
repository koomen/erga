#!/usr/bin/env bun
// The factory (experimental) end to end, against a dev server of its own,
// with the board in headless Chrome. The VMs are simulated by default (fast,
// no Docker: test.sh); --docker runs real containers of the factory's image
// (built on first use). No Claude plan is signed in, so the scripted
// stand-in does each task. Nothing leaves this machine: the repository is
// the dev server's own (dev/factory.ts), made from this checkout.
//
//   bun tests/factory.ts [--docker]
//
// 1. Off by default: the board says so, and adding a task is refused.
// 2. On: a task added on the board gets its branch from staging and a VM; the stand-in
//    changes a file, previews, screenshots, pushes, and the card is ready to merge.
// 3. Merge: the branch is merged into staging (a merge commit) and deleted.
// 4. Discard: the branch is deleted, nothing reaches staging.
// 5. More instructions on a finished task: it works again, on the same branch. Restart: again, in a fresh VM.
// 6. Tokens: a VM's token reaches its own task only; a task's git token can't push staging.
// 7. The Claude sign-in: stored, never shown, signed out again.
// 8. Dependencies (development/task-queue/deps.ts): bad ids and cycles refused; one added on the
//    board; a task that starts after another stays queued with no VM, and Start is refused; a blocked
//    merge is refused and Merge is off on the board; a merge queued behind a dependency's merge that
//    fails is refused when its turn comes; a discarded dependency blocks; when a dependency merges,
//    the task waiting for it starts by itself, and the board hears it.
// 9. One page: /admin/source has the board, the source dashboard and the agent; /admin/factory, /source and
//    /admin/deploys redirect there; tabs on a phone, with no sideways scrolling.
// 10. The factory's agent (the scripted model): it reads the board, queues a task with a dependency, reads it,
//    looks at its screenshot, sends it instructions and changes its dependencies; it has no merge or discard
//    tool; the conversation survives a reload.
// 11. Share with agent: a factory token in the editor's card (New token revokes the old one); with it an outside agent reads the guide and the
//    tasks, queues a task (its name has a curly apostrophe and an emoji: the task's VM starts and pushes), changes dependencies and sends instructions, and nothing else (merge, discard, start,
//    the Claude sign-in, the agent, tokens: 403); a bad token 401; Revoke ends it.
// 12. Merges that need the task's own Claude Code (the stand-in, fake-claude.ts): a task that conflicts with staging
//    goes to "needs agent" (Merge off, the reason on the card, the preview stopped), the same VM's stand-in resolves
//    it, and the merge goes on by itself to merged; a merge step that hangs (a test hook) is killed at its time
//    limit, with its whole process tree, and the same happens; an install that hangs wakes the stand-in with the log.
// Screenshots land in tests/cdp.ts's SHOTS (factory-*.png).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branches, dockerLabel, mintGitToken } from "../dev/factory";
import { Browser, SHOTS, type Page } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const docker = process.argv.includes("--docker");
const ok = (what: string) => console.log(`ok   ${what}`);
const secret = `factory-test-${crypto.randomUUID()}`;
const host = await startHost(null, { env: { ERGA_AGENT_MODEL: "script" }, processEnv: { ERGA_FACTORY_RUNNER: docker ? "docker" : "sim", ERGA_LINK_SECRET: secret, ERGA_FACTORY_SIM_NO_SCRIPTS: "1" } });
const browser = await Browser.launch();
const root = host.root;
const origin = { Origin: root };
const api = async (path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) => {
  const r = await fetch(`${root}/api/factory${path}`, { method: init.method ?? (init.json ? "POST" : "GET"), headers: { ...origin, ...(init.json ? { "Content-Type": "application/json" } : {}), ...init.headers }, body: init.json ? JSON.stringify(init.json) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const task = async (id: number) => (await api(`/tasks/${id}`)).body;
const setting = (value: string) => fetch(`${root}/admin/settings`, { method: "POST", headers: origin, body: new URLSearchParams({ key: "factory", value: JSON.stringify(value) }) });
const click = (p: Page, selector: string) => p.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no " + ${JSON.stringify(selector)}); el.click(); return true; })()`);
const fill = (p: Page, selector: string, value: string) => p.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const column = (p: Page, col: string) => p.eval<string>(`document.querySelector('[data-col="${col}"]')?.innerText ?? ""`);
const STEP = docker ? 300_000 : 60_000;

try {
  // ---------------------------------------------------------------- 1. off
  const p = await browser.page(await browser.context());
  await p.open(`${root}/admin/source`, { width: 1400, height: 900, scale: 2 });
  await until(() => p.eval(`!!document.querySelector('[data-col="queued"]')`), 15_000, "the board renders");
  expect(await p.eval(`!document.getElementById("notice").hidden`), "the board says the factory is off");
  expect((await api("/tasks", { json: { title: "x" } })).status == 409, "adding a task is refused while it's off");
  const other = await fetch(`${root}/admin/source?user=bob`);
  expect(other.status == 404, "someone who isn't an admin gets nothing", other.status);
  ok("off by default: the board says so, adding is refused, and non-admins get a 404");

  // ---------------------------------------------------------------- 2. a task, on the board
  expect((await setting("on")).ok, "the factory turns on");
  await p.navigate(`${root}/admin/source`);
  await until(() => p.eval(`!!document.getElementById("new")`), 15_000, "a New task button");
  const info = (await api("")).body;
  expect(info.enabled && info.vms.runner == (docker ? "docker" : "sim") && !info.claude.signedIn, "the factory's state", info);
  await click(p, "#new");
  await fill(p, "#t-title", "Say hello on the front page");
  await fill(p, "#t-desc", "Put a short hello under the front page's heading.");
  await p.screenshot(join(SHOTS, "factory-new.png"));
  await click(p, "#create");
  await until(async () => (await column(p, "queued")).includes("Say hello") || (await column(p, "working")).includes("Say hello"), 10_000, "the card shows up");
  await until(async () => (await task(1)).status == "complete", STEP, "the task is ready to merge", async () => JSON.stringify(await task(1), null, 1).slice(0, 3000));
  const t1 = await task(1);
  expect(t1.branch == "task/1-say-hello-on-the-front-page", "the branch is named after the task", t1.branch);
  expect(t1.screenshots.length == 1 && t1.summary.includes("note on the front page") && t1.url, "a screenshot, a summary and a preview", t1);
  const b1 = branches(host.state);
  expect(b1[t1.branch] && b1[t1.branch] == t1.commit && t1.base == b1.staging, "the branch is pushed, from staging", { b1, t1 });
  const preview = await (await fetch(t1.url.replace("//localhost:", "//127.0.0.1:"))).text();
  expect(preview.includes("Made by the factory, task #1"), "the preview shows the change", preview.slice(0, 300));
  const shot = await fetch(`${root}/api/factory/shots/${t1.screenshots[0].file}`);
  expect(shot.ok && shot.headers.get("content-type") == "image/png" && (await shot.arrayBuffer()).byteLength > 5000, "the screenshot is served");
  await until(async () => (await column(p, "ready-to-merge")).includes("Say hello"), 5000, "the card moves to Ready to merge, live");
  await until(() => p.eval(`[...document.querySelectorAll('[data-col="ready-to-merge"] .thumbs img')].every((i) => i.complete && i.naturalWidth > 0) && !!document.querySelector('[data-col="ready-to-merge"] .thumbs img')`), 5000, "its thumbnail loads");
  ok(`a task added on the board: branch from staging, ${docker ? "a Docker VM" : "a simulated VM"}, change, preview, screenshot, push, ready to merge`);

  // A second and third task, by the API, while we look at the first.
  expect((await api("/tasks", { json: { title: "Drop me", description: "To be discarded." } })).status == 201, "a second task");
  expect((await api("/tasks", { json: { title: "Change me twice", description: "To be revised. [factory-test: can't resolve]" } })).status == 201, "a third task");
  await click(p, '[data-open="1"]');
  await until(() => p.eval(`document.getElementById("dlg").open && document.querySelector("#dlg .shots img")?.complete`), 5000, "the detail opens, with the screenshot");
  const detail = (await p.eval<string>(`document.getElementById("dlg").innerText`)).toLowerCase();
  expect(detail.includes("task/1-say-hello-on-the-front-page") && detail.includes("summary") && detail.includes("more instructions") && detail.includes("open preview"), "the detail: branch, summary, instructions, preview", detail.slice(0, 800));
  await p.screenshot(join(SHOTS, "factory-detail.png"));
  // The detail's buttons: the cards' order, Merge on the right; the ones that don't apply (Start, for a task that ran) off, with why.
  const dlgButtons = await p.eval<{ keys: string[]; on: string[]; offWhy: string[] }>(`(() => { const bs = [...document.querySelectorAll("#dlg .actions > *")];
    return { keys: bs.map((b) => b.dataset.btn), on: bs.filter((b) => !b.disabled && b.dataset.act).map((b) => b.dataset.btn), offWhy: bs.filter((b) => b.disabled).map((b) => b.title) }; })()`);
  expect(dlgButtons.keys.join() == "preview,start,restart,discard,merge" && dlgButtons.on.join() == "restart,discard,merge" && dlgButtons.offWhy.length == 1 && dlgButtons.offWhy[0] == "The task has started already",
    "the detail: Preview, Start (off, with why), Restart, Discard, Merge", dlgButtons);
  await click(p, '[data-act="close"]');
  await until(async () => (await task(2)).status == "complete" && (await task(3)).status == "complete", STEP, "the other two are ready", async () => [await task(2), await task(3)].map((t) => ({ status: t.status, error: t.error, log: t.log.slice(-5).map((l: any) => l.message) })));
  const t2model = await task(2);
  expect(t2model.log.some((l: any) => l.message.includes("--model opus")), "the job passes Claude Code the factory_model setting (opus)", t2model.log.map((l: any) => l.message));
  await p.settle();
  await p.screenshot(join(SHOTS, "factory-board.png"));

  // ---------------------------------------------------------------- 3. merge
  await click(p, '[data-col="ready-to-merge"] [data-open="1"] [data-act="merge"]');
  await until(async () => (await task(1)).status == "merged", STEP, "task 1 is merged", async () => JSON.stringify((await task(1)).log.slice(-4)));
  const merged = await task(1);
  const b2 = branches(host.state);
  expect(!b2[t1.branch], "the branch is deleted", b2);
  expect(b2.staging == merged.mergeCommit, "staging is the merge commit", { b2, merged: merged.mergeCommit });
  const repo = join(host.state, "factory", "erga.git");
  const subject = spawnSync("git", ["-C", repo, "log", "-1", "--format=%s %P", "staging"], { encoding: "utf8" }).stdout.trim();
  expect(subject.startsWith("Merge task/1-say-hello-on-the-front-page: Say hello on the front page") && subject.split(" ").length > 3, "a --no-ff merge commit named after the task", subject);
  expect(!merged.vm && !merged.url, "the VM is stopped, and the preview gone", merged);
  await until(async () => !(await p.eval<string>(`document.getElementById("board")?.innerText ?? ""`)).includes("Say hello"), 15_000, "the card leaves the board (no Merged column)");
  expect(!(await p.eval<boolean>(`!!document.querySelector('[data-col="merged"]')`)) && (await p.eval<number>(`document.querySelectorAll("#board .col").length`)) == 4, "the board has four columns, and no Merged one");
  ok("merge: into staging as a merge commit, the branch deleted, the VM stopped");

  // ---------------------------------------------------------------- 4. discard
  const t2 = await task(2);
  expect(branches(host.state)[t2.branch], "task 2's branch is there");
  await click(p, '[data-open="2"] [data-act="arm"]');
  await until(() => p.eval(`!!document.querySelector('[data-open="2"] [data-act="discard"]')`), 2000, "Discard asks again");
  await click(p, '[data-open="2"] [data-act="discard"]');
  await until(async () => !branches(host.state)[t2.branch] && (await task(2)).log.at(-1).message.includes("deleted"), STEP, "task 2's branch is deleted");
  expect((await task(2)).status == "discarded" && branches(host.state).staging == merged.mergeCommit, "discarded, and staging didn't move");
  expect(!(await p.eval<string>(`document.getElementById("board").innerText`)).includes("Drop me"), "a discarded task leaves the board");
  ok("discard: two clicks, the branch deleted, staging untouched");

  // ---------------------------------------------------------------- 5. more instructions
  const t3 = await task(3);
  const r = await api("/tasks/3/revise", { json: { instructions: "Say it again." } });
  expect(r.status == 200 && r.body.status == "working", "the instructions are taken", r);
  await until(async () => (await task(3)).status == "complete" && (await task(3)).commit != t3.commit, STEP, "task 3 is ready again, with a new commit");
  const t3b = await task(3);
  const log3 = spawnSync("git", ["-C", repo, "log", "--format=%s", `staging..${t3b.branch}`], { encoding: "utf8" }).stdout;
  expect(log3.includes("Revise task #3") && log3.includes("Factory task #3"), "both commits are on the branch", log3);
  expect(t3b.log.some((l: any) => l.message.includes("asked: Say it again.")), "the log says what was asked");
  ok("more instructions: the task works again on its branch, and is ready to merge again");

  // Restart, on the board: the same branch, a fresh VM, no new instructions.
  await until(() => p.eval(`!!document.querySelector('[data-open="3"] [data-act="restart"]')`), 5000, "task 3's card has Restart");
  await click(p, '[data-open="3"] [data-act="restart"]');
  await until(async () => { const t = await task(3); return t.status == "complete" && t.commit != t3b.commit && !!t.vm && t.vm != t3b.vm; }, STEP, "task 3 is ready again, from a fresh VM", async () => JSON.stringify((await task(3)).log.slice(-6)));
  const t3c = await task(3);
  const log3c = spawnSync("git", ["-C", repo, "log", "--format=%s", `staging..${t3c.branch}`], { encoding: "utf8" }).stdout;
  expect(log3c.includes("Revise task #3") && log3c.split("\n").filter((l) => l.startsWith("Factory task #3")).length == 2, "the restart worked on the same branch", log3c);
  expect(t3c.log.some((l: any) => l.message.startsWith("Restarted by")) && t3c.log.some((l: any) => l.message.includes("checked out at")), "the log says it restarted, on the branch", t3c.log.slice(-12));
  expect((await api("/tasks/2/restart", { method: "POST" })).status == 409, "a discarded task doesn't restart");
  ok("restart: the task runs again on its branch, in a fresh VM, and is ready to merge again");

  // ---------------------------------------------------------------- 6. tokens
  const brief = await fetch(`${root}/api/factory/tasks/3/brief`, { headers: { Authorization: "Bearer fct.1.9999999999." + "0".repeat(64) } });
  expect(brief.status == 403, "a made-up VM token is refused", brief.status);
  const clone = mkdtempSync(join(tmpdir(), "factory-clone-"));
  const token = mintGitToken(secret, { scope: "task", branch: t3b.branch, exp: Math.floor(Date.now() / 1000) + 600 });
  const git = (...args: string[]) => spawnSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${token}`, ...args], { cwd: clone, encoding: "utf8" });
  expect(git("clone", "-q", `${root}/__factory/git/erga.git`, ".").status == 0, "a task's token clones");
  const toStaging = git("push", "--force", "origin", `origin/${t3b.branch}:refs/heads/staging`);
  expect(toStaging.status != 0 && toStaging.stderr.includes("403"), "a task's token can't push staging", toStaging.stderr);
  const noToken = spawnSync("git", ["ls-remote", `${root}/__factory/git/erga.git`], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  expect(noToken.status != 0, "no token, no repository");
  ok("tokens: a VM's reaches its own task only; a task's git token can't push staging; none, no access");

  // ---------------------------------------------------------------- 7. the Claude sign-in
  await click(p, "#claude-pill");
  await until(() => p.eval(`!!document.getElementById("c-token")`), 3000, "the sign-in dialog");
  await p.screenshot(join(SHOTS, "factory-claude.png"));
  await fill(p, "#c-token", "not a token");
  await click(p, "#c-save");
  await until(async () => (await p.eval<string>(`document.getElementById("c-why").textContent`)).includes("isn't a Claude Code token"), 3000, "a bad token is refused");
  await fill(p, "#c-token", "sk-ant-oat01-abc$def!0123456789012345");
  await click(p, "#c-save");
  await until(async () => (await p.eval<string>(`document.getElementById("c-why").textContent`)).includes("characters other than letters"), 3000, "the refusal says what is wrong");
  const fake = `sk-ant-oat01-${"x".repeat(40)}`;
  await fill(p, "#c-token", `${fake.slice(0, 25)}  ${fake.slice(25)} `); // as the terminal wraps it
  await click(p, "#c-save");
  await until(() => p.eval(`document.getElementById("claude-pill").textContent == "Claude: signed in"`), 3000, "signed in with a wrapped token");
  const wrapped = await api("/claude", { method: "PUT", json: { token: `${fake.slice(0, 30)}\n${fake.slice(30)}` } });
  expect(wrapped.status == 200 && wrapped.body.signedIn, "the server takes a token with a line break in it", wrapped);
  expect((await api("/claude", { method: "DELETE" })).body.signedIn == false, "signed out, to sign in again");
  await click(p, "#claude-pill");
  await until(() => p.eval(`!!document.getElementById("c-token")`), 3000, "the sign-in dialog, again");
  await fill(p, "#c-token", fake);
  await click(p, "#c-save");
  await until(() => p.eval(`document.getElementById("claude-pill").textContent == "Claude: signed in"`), 3000, "signed in");
  for (const path of ["", "/claude", "/tasks"]) expect(!JSON.stringify((await api(path)).body).includes(fake), `${path || "/"} never shows the token`);
  expect(!(await p.eval<string>(`document.documentElement.outerHTML`)).includes(fake.slice(14)), "the page never shows it");
  expect((await api("/claude", { method: "DELETE" })).body.signedIn == false, "signed out");
  ok("the Claude sign-in: a bad token refused with the reason, a wrapped one accepted, a good one stored and never shown, then signed out");

  // ---------------------------------------------------------------- 8. dependencies
  // Now: #1 merged, #2 discarded, #3 ready to merge (made from staging before #1 merged, so it conflicts with it).
  const vmsOf = (id: number) => { const dir = join(host.state, "factory", "vms"); return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(`task-${id}-`)) : []; };
  const add = (json: Record<string, unknown>) => api("/tasks", { json });
  for (const [deps, why] of [[{ startAfter: [999] }, "no task 999"], [{ startAfter: [2] }, "task 2 is discarded"], [{ mergeAfter: "abc" }, "isn't a task id"]] as const) {
    const r = await add({ title: "Bad dependency", ...deps });
    expect(r.status == 400 && r.body.error.includes(why), `a dependency on ${JSON.stringify(deps)} is refused`, r);
  }
  const t4 = await add({ title: "Build on the hello", description: "Change the hello note." });
  expect(t4.status == 201 && !t4.body.blockedBy, "#4, with no dependencies, starts", t4);
  // A dependency added in the detail view: #4 merges after #3.
  await p.navigate(`${root}/admin/source`);
  await until(() => p.eval(`!!document.querySelector('[data-open="4"]')`), 10_000, "#4's card");
  await click(p, '[data-open="4"]');
  await until(() => p.eval(`!!document.getElementById("dep-kind")`), 5000, "the Dependencies section, with Add");
  await p.eval(`(() => { document.getElementById("dep-kind").value = "mergeAfter"; document.getElementById("dep-id").value = "3"; return true; })()`);
  await click(p, '#dlg [data-act="dep"]');
  await until(async () => JSON.stringify((await task(4)).mergeAfter) == "[3]", 5000, "#4 merges after #3");
  await until(async () => (await p.eval<string>(`document.getElementById("dlg").innerText`)).includes("Merges after"), 5000, "the detail lists the dependency");
  await click(p, '[data-act="close"]');
  const self = await api("/tasks/3", { method: "PATCH", json: { startAfter: [3] } });
  expect(self.status == 400 && self.body.error.includes("can't depend on itself"), "a task can't depend on itself", self);
  const loop = await api("/tasks/3", { method: "PATCH", json: { mergeAfter: [4] } });
  expect(loop.status == 400 && loop.body.error.includes("cycle") && loop.body.error.includes("#3 waits for #4 waits for #3"), "a cycle is refused", loop);
  ok("dependencies: unknown, discarded and malformed ids, a task on itself and a cycle are refused; one added on the board");

  // #5 starts after #4, added on the board's form: queued, no VM, Start refused.
  await click(p, "#new");
  await until(() => p.eval(`!!document.getElementById("t-start")`), 3000, "the form asks for dependencies");
  await fill(p, "#t-title", "Follow the hello");
  await fill(p, "#t-desc", "After #4: change the note again.");
  await p.eval(`(() => { document.getElementById("t-start").value = "4"; return true; })()`);
  await click(p, "#create");
  await until(async () => (await task(5))?.status == "queued", 5000, "#5 is queued");
  await new Promise((r) => setTimeout(r, 1500));
  const t5 = await task(5);
  expect(JSON.stringify(t5.startAfter) == "[4]" && JSON.stringify(t5.blockedBy?.start) == "[4]" && t5.blockedBy.reason == "waiting for #4 to merge", "#5 waits for #4", t5);
  expect(t5.status == "queued" && !t5.vm && !t5.log.some((l: any) => l.message.includes("Starting a VM")) && !vmsOf(5).length, "no VM started for #5", { t5, vms: vmsOf(5) });
  const start5 = await api("/tasks/5/start", { method: "POST" });
  expect(start5.status == 409 && start5.body.error.includes("can't start: waiting for #4"), "Start is refused while #4 isn't merged", start5);
  expect(!vmsOf(5).length && !(await task(5)).vm, "still no VM for #5");
  await until(() => p.eval(`(() => { const c = document.querySelector('[data-col="queued"] [data-open="5"]'); return !!c && c.classList.contains("blocked") && c.innerText.includes("waiting for #4") && !!c.querySelector("button[disabled]"); })()`), 5000, "#5's card: blocked, 'waiting for #4', Start off");
  ok("a task that starts after another: queued with no VM, Start refused (409), the card says what it waits for");

  // A blocked merge: #4 is ready, but #3 isn't merged.
  await until(async () => (await task(4)).status == "complete", STEP, "#4 is ready to merge");
  const merge4 = await api("/tasks/4/merge", { method: "POST" });
  expect(merge4.status == 409 && merge4.body.error.includes("can't merge until #3 merges"), "merging #4 is refused while #3 isn't merged", merge4);
  await until(() => p.eval(`(() => { const c = document.querySelector('[data-col="ready-to-merge"] [data-open="4"]'); const b = c && [...c.querySelectorAll("button")].find((x) => x.textContent == "Merge"); return !!b && b.disabled && b.title == "Can't merge until #3 merges" && c.innerText.includes("merges after #3"); })()`), 5000, "#4's Merge is off, with the reason");
  await p.settle();
  await p.screenshot(join(SHOTS, "factory-deps-board.png"));
  ok("a blocked merge: refused (409), and Merge is off on the board with the reason");

  // The race: #4's merge is asked for while #3 merges ahead of it; #3's fails (it conflicts with #1), so #4's is refused when its turn comes.
  expect((await api("/tasks/3/merge", { method: "POST" })).status == 202, "#3's merge starts");
  const queued4 = await api("/tasks/4/merge", { method: "POST" });
  expect(queued4.status == 202 && queued4.body.status == "merging", "#4's merge may be asked for while #3 merges ahead of it", queued4);
  await until(async () => (await task(3)).status == "complete" && (await task(4)).status == "complete", STEP, "both merges end", async () => [await task(3), await task(4)].map((t) => ({ s: t.status, e: t.error })));
  const [r3, r4] = [await task(3), await task(4)];
  expect(r3.error?.includes("Claude Code couldn't finish the merge") && r3.error.includes("conflicts with staging in landing/index.html"), "#3's merge failed (a conflict its stand-in gave up on)", r3.error);
  expect(r3.log.some((l: any) => l.message.startsWith("Needs agent: The branch conflicts with staging")), "#3 needed its agent first", r3.log.slice(-8));
  expect(r4.error?.includes("Can't merge until #3 merges") && /#3 is (complete|needs agent)/.test(r4.error), "#4's merge was refused when its turn came", r4.error);
  expect(!branches(host.state).staging || branches(host.state).staging == merged.mergeCommit, "staging didn't move");
  ok("a merge queued behind its dependency's: checked again when it runs, and refused when the dependency didn't merge");

  // A discarded dependency blocks: #6 starts after #3; #3 is discarded.
  const t6 = await add({ title: "After the conflict", startAfter: [3] });
  expect(t6.status == 201 && t6.body.status == "queued" && t6.body.blockedBy?.start[0] == 3, "#6 waits for #3", t6);
  expect((await api("/tasks/3/discard", { method: "POST" })).status == 200, "#3 is discarded");
  const [s4, s6] = [await task(4), await task(6)];
  expect(JSON.stringify(s6.blockedBy?.stuck) == "[3]" && s6.blockedBy.reason.startsWith("blocked: #3 was discarded"), "#6 is blocked by the discarded #3", s6.blockedBy);
  expect(JSON.stringify(s4.blockedBy?.stuck) == "[3]", "#4 too (it merges after #3)", s4.blockedBy);
  expect(s6.log.some((l: any) => l.message.includes("#3 was discarded: this task is blocked")), "#6's log says so");
  expect((await api("/tasks/6/start", { method: "POST" })).status == 409 && !vmsOf(6).length, "#6 can't start, and has no VM");
  expect((await add({ title: "After a discarded one", startAfter: [3] })).status == 400, "a new dependency on a discarded task is refused");
  await until(() => p.eval(`(() => { const c = document.querySelector('[data-open="6"]'); return !!c && c.innerText.includes("blocked by #3"); })()`), 5000, "#6's card: 'blocked by #3'");
  ok("a discarded dependency blocks its dependents (start and merge) until it's removed");

  // Unblocking: the dependency removed on the board, #4 merges, and #5 (waiting for #4) starts by itself.
  await p.eval(`(() => { window.__toasts = []; const t = document.getElementById("toast"); new MutationObserver(() => window.__toasts.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true }); return true; })()`);
  await click(p, '[data-open="4"]');
  await until(() => p.eval(`!!document.querySelector('#dlg [data-act="undep"][data-dep="3"]')`), 5000, "#4's dependency has a ×");
  await click(p, '#dlg [data-act="undep"][data-dep="3"]');
  await until(async () => !(await task(4)).mergeAfter.length && !(await task(4)).blockedBy, 5000, "#4's dependency is removed");
  await click(p, '[data-act="close"]');
  expect((await api("/tasks/4/merge", { method: "POST" })).status == 202, "#4 merges now");
  await until(async () => (await task(4)).status == "merged", STEP, "#4 is merged", async () => (await task(4)).log.slice(-4));
  await until(async () => ["working", "complete"].includes((await task(5)).status) && !!(await task(5)).vm, 15_000, "#5 starts by itself", async () => task(5));
  const u5 = await task(5);
  expect(u5.log.some((l: any) => l.message == "#4 merged: unblocked: it can start now") && !u5.blockedBy, "#5's log says why it started", u5.log);
  await until(() => p.eval(`window.__toasts.some((t) => t.includes("#5 unblocked: Follow the hello"))`), 5000, "the board hears #5 is unblocked", () => p.eval(`window.__toasts`));
  // And #6, once its discarded dependency is removed.
  const clear6 = await api("/tasks/6", { method: "PATCH", json: { startAfter: null } });
  expect(clear6.status == 200 && !clear6.body.blockedBy, "#6's dependency is removed", clear6);
  await until(async () => !!(await task(6)).vm, 15_000, "#6 starts by itself");
  await until(async () => (await task(5)).status == "complete" && (await task(6)).status == "complete", STEP, "#5 and #6 are ready");
  ok("unblocking: a dependency removed on the board; when one merges, the task waiting for it starts by itself, and the board hears it");

  // ---------------------------------------------------------------- 9. one page: /admin/source
  for (const old of ["/admin/factory", "/source", "/admin/deploys"]) {
    const r = await fetch(`${root}${old}`, { redirect: "manual" });
    expect(r.status == 302 && r.headers.get("location") == "/admin/source", `${old} redirects to /admin/source`, r.status);
  }
  await p.navigate(`${root}/admin/source`);
  await until(() => p.eval(`!!document.querySelector('#tasks [data-col="queued"]') && !!document.querySelector("#source-pane .pane-head") && !!document.querySelector("#agent .agent-log")`), 10_000, "the board, the dashboard and the agent, on one page");
  const box = (sel: string) => p.eval<{ left: number; right: number; top: number; bottom: number; width: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; })()`);
  const [agentBox, tasksBox, sourceBox] = [await box("#agent"), await box("#tasks"), await box("#source-pane")];
  expect(agentBox.right <= tasksBox.left && tasksBox.bottom <= sourceBox.top && agentBox.width >= 300 && agentBox.bottom <= 900, "on a wide window: the agent on the left, the board above the dashboard beside it", { agentBox, tasksBox, sourceBox });
  expect(await p.eval(`getComputedStyle(document.querySelector("#tasks .board")).gridTemplateColumns.split(" ").length == 4`), "the board keeps its four columns beside the agent");
  const phone = await browser.page(await browser.context());
  await phone.open(`${root}/admin/source`, { width: 390, height: 844, scale: 2 });
  await until(() => phone.eval(`!!document.querySelector('#tasks [data-col="queued"]')`), 10_000, "the page on a phone");
  const shown = () => phone.eval<string[]>(`["#tasks", "#source-pane", "#agent"].filter((s) => document.querySelector(s).offsetParent !== null)`);
  expect(JSON.stringify(await shown()) == '["#tasks"]', "a phone shows one pane at a time: the board first", await shown());
  expect(await phone.eval(`document.documentElement.scrollWidth <= innerWidth`), "no sideways scrolling on a phone");
  await phone.screenshot(join(SHOTS, "factory-phone-tasks.png"));
  await click(phone, '.tabs [data-tab="agent"]');
  expect(JSON.stringify(await shown()) == '["#agent"]', "the Agent tab shows the agent", await shown());
  const phoneAgent = await phone.eval<{ bottom: number; input: number }>(`(() => ({ bottom: document.getElementById("agent").getBoundingClientRect().bottom, input: document.getElementById("agent-input").getBoundingClientRect().bottom }))()`);
  expect(phoneAgent.bottom <= 844 && phoneAgent.input <= 844, "its box fits on the screen", phoneAgent);
  await phone.screenshot(join(SHOTS, "factory-phone-agent.png"));
  await click(phone, '.tabs [data-tab="source"]');
  expect(JSON.stringify(await shown()) == '["#source-pane"]', "the Source tab shows the dashboard", await shown());
  expect(await phone.eval(`document.documentElement.scrollWidth <= innerWidth`), "no sideways scrolling there either");
  ok("one page, /admin/source: the agent beside the board and the dashboard; the old pages redirect; tabs on a phone");

  // ---------------------------------------------------------------- 10. the factory's agent
  const sayTo = (text: string) => p.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); document.getElementById("agent-send").click(); return true; })()`);
  const panel = () => p.eval<string>(`document.getElementById("agent-log").innerText`);
  /** What the agent said (its replies only, not the messages sent to it). */
  const replies = () => p.eval<string>(`[...document.querySelectorAll("#agent-log .msg-assistant")].map((e) => e.innerText).join(" | ")`);
  await until(async () => (await p.eval<string>(`document.getElementById("agent-model").textContent`)).includes("script"), 10_000, "the agent panel connects");
  const next = Math.max(...(await api("/tasks")).body.map((t: any) => t.id)) + 1;
  await sayTo("Queue a footer note that merges after #5 @script " + JSON.stringify([
    { tool: "list_tasks", args: {} },
    { tool: "create_task", args: { title: "Add a footer note", description: "Put a short note in the front page's footer.", mergeAfter: [5] } },
    { tool: "get_task", args: { id: next } },
    { text: `Queued #${next}: it merges after #5.` },
  ]));
  await until(async () => (await replies()).includes(`Queued #${next}: it merges after #5.`), 15_000, "the agent answers", panel);
  const queued = await task(next);
  expect(queued.title == "Add a footer note" && JSON.stringify(queued.mergeAfter) == "[5]" && queued.by == "tester’s agent" && queued.log[0].message.startsWith("Added by tester’s agent"), "the agent queued a task, as the admin's agent, with its dependency", { queued, panel: await panel() });
  const said = await panel();
  expect(said.includes("Read the board") && said.includes("Queued Add a footer note") && said.includes(`Read #${next}`), "the panel shows each call, as the editor's does", said);
  await until(async () => (await column(p, "queued")).includes("Add a footer note") || (await column(p, "working")).includes("Add a footer note") || (await column(p, "ready-to-merge")).includes("Add a footer note"), 10_000, "its card shows on the board");
  await until(async () => (await task(next)).status == "complete", STEP, "the task is done", async () => (await task(next)).log.slice(-4));
  // The admin opens the task: the panel tells the agent which one ("this task").
  await click(p, `[data-open="${next}"]`);
  expect(await p.eval(`window.ergaBoard.openTask() == ${next}`), "the board says which task is open, for the agent's context");
  await click(p, '[data-act="close"]');
  await sayTo("Look at it, ask for a shorter note, and drop the dependency @script " + JSON.stringify([
    { tool: "view_screenshot", args: { id: next } },
    { tool: "instruct_task", args: { id: next, instructions: "Make the note shorter." } },
    { tool: "set_dependencies", args: { id: next, mergeAfter: null } },
    { text: "Asked for a shorter note." },
  ]));
  await until(async () => (await replies()).includes("Asked for a shorter note."), 15_000, "the agent answers again", panel);
  const revised = await task(next);
  expect(revised.log.some((l: any) => l.message.startsWith("tester’s agent asked: Make the note shorter.")) && !revised.mergeAfter.length, "it sent instructions and dropped the dependency", revised.log.slice(-6));
  expect(await p.eval(`!!document.querySelector("#agent-log .msg-tool.done img.shot")`), "the screenshot it looked at shows in the panel");
  await until(async () => (await task(next)).status == "complete", STEP, "the task is ready again");
  await sayTo("Merge it @script " + JSON.stringify([{ tool: "merge_task", args: { id: next } }, { tool: "discard_task", args: { id: next } }, { text: "I can't merge: you do." }]));
  await until(async () => (await replies()).includes("I can't merge: you do."), 15_000, "the agent answers", panel);
  expect((await task(next)).status == "complete" && (await panel()).includes("merge_task failed"), "it has no merge or discard tool: the task is still ready to merge, waiting for an admin", await panel());
  await p.navigate(`${root}/admin/source`);
  await until(async () => (await replies()).includes("I can't merge: you do."), 10_000, "a reload keeps the conversation");
  await p.screenshot(join(SHOTS, "factory-agent.png"));
  ok("the factory's agent: reads the board, queues a task with a dependency, reads it, looks at its screenshot, sends instructions, changes dependencies; no merge or discard");

  // ---------------------------------------------------------------- 11. Share with agent: a factory token
  // An icon in the header bar, as the editor's (no button in the board's head); it opens the editor's card (share-agent.ts).
  expect(await p.eval(`!!document.querySelector(".chrome-top > #btn-share.icon-btn[data-tip] svg") && !document.querySelector("#tasks #btn-share, .share-btn")`), "Share with agent is an icon in the header bar");
  await click(p, "#btn-share");
  await until(() => p.eval(`!document.getElementById("share").hidden && document.getElementById("share").matches(".help.share") && document.getElementById("btn-share").getAttribute("aria-expanded") == "true"`), 5000, "Share with agent opens the editor's card");
  await until(async () => (await p.eval<string>(`document.getElementById("share-prompt").value`)).includes("erga_factory_"), 10_000, "a token, in a prompt to paste");
  const sharePrompt = await p.eval<string>(`document.getElementById("share-prompt").value`);
  const first = /erga_factory_\S+/.exec(sharePrompt)![0];
  expect(sharePrompt.includes(`${root}/api/factory/guide`) && sharePrompt.includes("Authorization: Bearer"), "the prompt: the guide, and how to send the token", sharePrompt);
  expect(await p.eval(`!!document.querySelector("#share #share-copy.share-primary") && !!document.querySelector("#share #share-rotate") && !!document.querySelector("#share .share-note")`), "the card's buttons and note are the editor's");
  await p.screenshot(join(SHOTS, "factory-share.png"));
  const as = (path: string, init: { method?: string; json?: unknown; token?: string } = {}) => fetch(`${root}/api/factory${path}`, { method: init.method ?? (init.json ? "POST" : "GET"), headers: { Authorization: `Bearer ${init.token ?? shared}`, ...(init.json ? { "Content-Type": "application/json" } : {}) }, body: init.json ? JSON.stringify(init.json) : undefined });
  expect((await as("/tasks", { token: first })).ok, "the card's token works");
  // New token turns the old one off.
  await click(p, "#share-rotate");
  await until(async () => { const v = await p.eval<string>(`document.getElementById("share-prompt").value`); return v.includes("erga_factory_") && !v.includes(first); }, 10_000, "New token: a new prompt");
  expect((await as("/tasks", { token: first })).status == 401, "New token revokes the old one");
  expect((await as("/tasks", { token: /erga_factory_\S+/.exec(await p.eval<string>(`document.getElementById("share-prompt").value`))![0] })).ok, "the new token works");
  await p.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await until(() => p.eval(`document.getElementById("share").hidden && document.getElementById("btn-share").getAttribute("aria-expanded") == "false"`), 5000, "Escape closes the card");
  // A label with an emoji, beside the agent's curly apostrophe: the task's git token must carry both (it once failed: btoa).
  const minted = await p.eval<{ token: string; id: string }>(`fetch("/api/factory/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Claude Code 🤖", hours: 1 }) }).then((r) => r.json())`);
  const shared = minted.token;
  const guide = await as("/guide");
  expect(guide.ok && (await guide.text()).includes("can't merge"), "the guide, for the outside agent");
  expect((await as("")).ok && (await as("/tasks")).ok && (await as(`/tasks/${next}`)).ok, "it reads the factory and its tasks");
  const byShared = await as("/tasks", { json: { title: "Shared agent's task", description: "From outside.", startAfter: [next] } });
  const sharedTask = await byShared.json() as any;
  expect(byShared.status == 201 && sharedTask.by == "tester’s agent (shared: Claude Code 🤖)" && JSON.stringify(sharedTask.startAfter) == `[${next}]`, "it queues a task, with a dependency, as the admin's shared agent", sharedTask);
  expect((await as(`/tasks/${sharedTask.id}`, { method: "PATCH", json: { startAfter: null, mergeAfter: [next] } })).status == 200, "it changes dependencies");
  // Free of its start dependency, it starts by itself: its VM gets a git token with the agent's name, and the stand-in pushes with it.
  await until(async () => (await task(sharedTask.id)).status == "complete", STEP, "the shared agent's task starts its VM, pushes its branch and is ready to merge", async () => { const t = await task(sharedTask.id); return { status: t.status, error: t.error, log: t.log.slice(-4) }; });
  expect(!!branches(host.state)[(await task(sharedTask.id)).branch], "its branch reached the repository, pushed with its git token", branches(host.state));
  expect((await as(`/tasks/${next}/revise`, { json: { instructions: "One more word." } })).status == 200, "it sends instructions");
  for (const [method, path] of [["POST", `/tasks/${next}/merge`], ["POST", `/tasks/${next}/discard`], ["POST", `/tasks/${sharedTask.id}/start`], ["PUT", "/claude"], ["DELETE", "/claude"], ["POST", "/agent"], ["GET", "/agent"], ["GET", "/events"], ["POST", "/tokens"], ["GET", "/tokens"]] as const) {
    const r = await as(path, { method, json: method == "GET" || method == "DELETE" ? undefined : {} });
    expect(r.status == 403, `a factory token can't ${method} ${path}`, r.status);
  }
  expect((await as("/tasks", { token: shared.slice(0, -2) + "xx" })).status == 401, "a bad token: 401");
  await p.eval(`fetch("/api/factory/tokens/${minted.id}", { method: "DELETE" }).then((r) => r.ok)`);
  await until(async () => (await as("/tasks")).status == 401, 5000, "Revoking it ends it");
  ok("Share with agent: the editor's card, with a factory token that creates, reads and instructs tasks, nothing else; New token and revoking end it");

  // ---------------------------------------------------------------- 12. merges that need the task's Claude Code
  const make = async (title: string, description: string) => { const r = await api("/tasks", { json: { title, description } }); expect(r.status == 201, `a task: ${title}`, r); return r.body.id as number; };
  const statusOf = async (id: number) => (await task(id)).status;
  const vmStarts = (t: any) => t.log.filter((l: any) => /^VM \S+ started/.test(l.message)).length;
  const tA = await make("Note A", "A note on the front page.");
  const tB = await make("Note B, in conflict", "Another note on the front page. [factory-test: resolve after 8]");
  const tD = await make("Note D, install hangs", "A note, with an install that hangs. [factory-test: hang install 2]");
  await until(async () => (await statusOf(tA)) == "complete" && (await statusOf(tB)) == "complete" && (await statusOf(tD)) == "complete", STEP, "A, B and D are ready", () => Promise.all([tA, tB, tD].map(async (id) => (await task(id)).log.slice(-3))));
  const d = await task(tD);
  expect(d.log.some((l: any) => l.message.startsWith("`bun install` timed out after 2s (its processes were killed): Claude Code is told")) && d.log.some((l: any) => l.message.startsWith("The stand-in ran bun install again")), "an install that hangs: killed at its limit, and the stand-in is told and installs again", d.log.map((l: any) => l.message));
  expect((await api(`/tasks/${tA}/merge`, { method: "POST" })).status == 202, "A merges");
  await until(async () => (await statusOf(tA)) == "merged", STEP, "A is merged");
  // B was made from the staging before A: both put a note under the heading, so merging staging into B conflicts.
  const b0 = await task(tB);
  const previewB = b0.url.replace("//localhost:", "//127.0.0.1:");
  expect((await fetch(previewB).catch(() => null))?.ok, "B's preview is up before the merge");
  await p.navigate(`${root}/admin/source`);
  await until(() => p.eval(`!!document.querySelector('[data-col="ready-to-merge"] [data-open="${tB}"] [data-act="merge"]')`), 10_000, "B's Merge button");
  await click(p, `[data-col="ready-to-merge"] [data-open="${tB}"] [data-act="merge"]`);
  await until(async () => (await statusOf(tB)) == "needs agent", STEP, "B needs its agent", async () => (await task(tB)).log.slice(-4));
  const nb1 = await task(tB);
  expect(nb1.error.includes("The branch conflicts with staging in landing/index.html") && !nb1.url, "the reason, and no preview link", nb1);
  expect(!(await fetch(previewB, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false)), "the preview was stopped before the merge work");
  expect((await api(`/tasks/${tB}/merge`, { method: "POST" })).status == 409 && (await api(`/tasks/${tB}/revise`, { json: { instructions: "x" } })).status == 409, "Merge and new instructions are refused while it needs its agent");
  const cardB = `[data-col="merging"] [data-open="${tB}"]`;
  await until(() => p.eval(`(() => { const c = document.querySelector(${JSON.stringify(cardB)}); const b = c && [...c.querySelectorAll("button")].find((x) => x.textContent == "Merge"); return !!b && b.disabled && c.classList.contains("needs-agent") && c.innerText.toLowerCase().includes("needs agent") && c.innerText.includes("conflicts with staging in landing/index.html"); })()`), 5000, "B's card: in Merging, needs agent, the reason, Merge off", () => p.eval(`document.querySelector('[data-col="merging"]')?.innerText`));
  await p.settle();
  await p.screenshot(join(SHOTS, "factory-needs-agent.png"));
  await click(p, `[data-open="${tB}"]`);
  await until(() => p.eval(`document.getElementById("dlg").open && document.querySelector("#dlg .status.needs-agent")?.textContent == "needs agent"`), 5000, "B's detail says needs agent");
  await p.screenshot(join(SHOTS, "factory-needs-agent-detail.png"));
  await click(p, '[data-act="close"]');
  // The agent panel's tools see it too (list_tasks with the status).
  const replyCount = (await replies()).split(" | ").length;
  await sayTo("What needs its agent? @script " + JSON.stringify([{ tool: "list_tasks", args: { status: "needs agent" } }, { tool: "get_task", args: { id: tB, log: 5 } }, { text: "B needs its agent." }]));
  await until(async () => (await replies()).split(" | ").length > replyCount && (await replies()).includes("B needs its agent."), 15_000, "the agent answers", panel);
  expect(!/(list_tasks|get_task) failed/.test(await panel()), "its reads of a needs agent task work", await panel());
  await until(async () => (await statusOf(tB)) == "merged", STEP, "B's merge goes on by itself, and B is merged", async () => (await task(tB)).log.slice(-6));
  const nb2 = await task(tB);
  const msgs = nb2.log.map((l: any) => l.message);
  expect(msgs.some((m: string) => m.startsWith("Claude Code is woken to finish the merge")) && msgs.some((m: string) => m.startsWith("Resolved the conflicts in landing/index.html")) && msgs.includes("The merge goes on"), "the stand-in resolved it, and the merge went on", msgs.slice(-14));
  expect(vmStarts(nb2) == 1, "one VM, from start to merge: the same agent", msgs.filter((m: string) => m.startsWith("VM ")));
  const stagingHtml = spawnSync("git", ["-C", repo, "show", "staging:landing/index.html"], { encoding: "utf8" }).stdout;
  expect(stagingHtml.includes(`task #${tA}: Note A`) && stagingHtml.includes(`task #${tB}: Note B, in conflict`) && !stagingHtml.includes("<<<<<<<"), "staging has both notes, and no conflict markers");
  expect(branches(host.state).staging == nb2.mergeCommit && !branches(host.state)[nb2.branch], "staging is B's merge commit; B's branch is gone");
  ok("a conflict: needs agent (Merge off, the reason, the preview stopped), the same VM's stand-in resolves it, and the merge goes on to merged");

  // C: the merge's push hangs once (a test hook, 3 s limit): killed with its process tree, needs agent, then merged.
  const tC = await make("Note C, push hangs", "A third note. [factory-test: hang merge:push 3]");
  await until(async () => (await statusOf(tC)) == "complete", STEP, "C is ready");
  expect((await api(`/tasks/${tC}/merge`, { method: "POST" })).status == 202, "C merges");
  await until(async () => (await statusOf(tC)) == "needs agent", STEP, "C needs its agent", async () => (await task(tC)).log.slice(-4));
  const c1 = await task(tC);
  expect(c1.error.startsWith("Pushing task/") && c1.error.includes("timed out after 3s (its processes were killed)"), "the reason: the push timed out", c1.error);
  // Its whole process tree was killed (two sleeps: the step's and its child's), in the VM that is still up.
  const hung = `sleep ${3000 + tC}`;
  const left = docker ? spawnSync("docker", ["exec", c1.vm, "pgrep", "-f", hung], { encoding: "utf8" }).stdout.trim() : spawnSync("pgrep", ["-f", hung], { encoding: "utf8" }).stdout.trim();
  expect(!left, "nothing of the hung step is left running", left);
  await until(async () => (await statusOf(tC)) == "merged", STEP, "C is merged", async () => (await task(tC)).log.slice(-6));
  expect(vmStarts(await task(tC)) == 1, "one VM for C too");
  ok("a merge step that hangs: killed at its limit with its process tree, needs agent, the stand-in is woken, and the merge goes on to merged");

  console.log("all factory checks pass");
} catch (e) {
  // What the VMs said (the simulation's logs; Docker's are saved when a VM stops), to see why.
  const vms = join(host.state, "factory", "vms");
  if (existsSync(vms)) for (const n of readdirSync(vms)) {
    const f = join(vms, n, "vm.log");
    if (existsSync(f)) console.error(`--- ${n}/vm.log (tail)\n${readFileSync(f, "utf8").slice(-1500)}`);
  }
  console.error(`--- the dev server (tail)\n${host.output().slice(-3000)}`);
  throw e;
} finally {
  browser.close();
  // Docker VMs this server started (the label is its state folder's).
  if (docker) for (const id of spawnSync("docker", ["ps", "-aq", "--filter", `label=erga.factory=${dockerLabel(host.state)}`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)) {
    spawnSync("docker", ["rm", "-f", id], { stdio: "ignore" });
  }
  // The simulated VMs' previews run detached, as in a VM (task.ts, daemon): stopped by their folder, under this server's state.
  if (!docker) spawnSync("pkill", ["-f", join(host.state, "factory", "vms")], { stdio: "ignore" });
  await host.dispose();
}
