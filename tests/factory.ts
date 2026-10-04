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
// 5. More instructions on a finished task: it works again, on the same branch.
// 6. Tokens: a VM's token reaches its own task only; a task's git token can't push staging.
// 7. The Claude sign-in: stored, never shown, signed out again.
// Screenshots land in tests/cdp.ts's SHOTS (factory-*.png).

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branches, dockerLabel, mintGitToken } from "../dev/factory";
import { Browser, SHOTS, type Page } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const docker = process.argv.includes("--docker");
const ok = (what: string) => console.log(`ok   ${what}`);
const secret = `factory-test-${crypto.randomUUID()}`;
const host = await startHost(null, { processEnv: { ERGA_FACTORY_RUNNER: docker ? "docker" : "sim", ERGA_LINK_SECRET: secret } });
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
  await p.open(`${root}/admin/factory`, { width: 1400, height: 900, scale: 2 });
  await until(() => p.eval(`!!document.querySelector('[data-col="queued"]')`), 15_000, "the board renders");
  expect(await p.eval(`!document.getElementById("notice").hidden`), "the board says the factory is off");
  expect((await api("/tasks", { json: { title: "x" } })).status == 409, "adding a task is refused while it's off");
  const other = await fetch(`${root}/admin/factory?user=bob`);
  expect(other.status == 404, "someone who isn't an admin gets nothing", other.status);
  ok("off by default: the board says so, adding is refused, and non-admins get a 404");

  // ---------------------------------------------------------------- 2. a task, on the board
  expect((await setting("on")).ok, "the factory turns on");
  await p.navigate(`${root}/admin/factory`);
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
  expect((await api("/tasks", { json: { title: "Change me twice", description: "To be revised." } })).status == 201, "a third task");
  await click(p, '[data-open="1"]');
  await until(() => p.eval(`document.getElementById("dlg").open && document.querySelector("#dlg .shots img")?.complete`), 5000, "the detail opens, with the screenshot");
  const detail = (await p.eval<string>(`document.getElementById("dlg").innerText`)).toLowerCase();
  expect(detail.includes("task/1-say-hello-on-the-front-page") && detail.includes("summary") && detail.includes("more instructions") && detail.includes("open preview"), "the detail: branch, summary, instructions, preview", detail.slice(0, 800));
  await p.screenshot(join(SHOTS, "factory-detail.png"));
  await click(p, '[data-act="close"]');
  await until(async () => (await task(2)).status == "complete" && (await task(3)).status == "complete", STEP, "the other two are ready");
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
  await until(async () => (await column(p, "merged")).includes("Say hello"), 5000, "the card moves to Merged");
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
  const fake = `sk-ant-oat01-${"x".repeat(40)}`;
  await fill(p, "#c-token", fake);
  await click(p, "#c-save");
  await until(() => p.eval(`document.getElementById("claude-pill").textContent == "Claude: signed in"`), 3000, "signed in");
  for (const path of ["", "/claude", "/tasks"]) expect(!JSON.stringify((await api(path)).body).includes(fake), `${path || "/"} never shows the token`);
  expect(!(await p.eval<string>(`document.documentElement.outerHTML`)).includes(fake.slice(14)), "the page never shows it");
  expect((await api("/claude", { method: "DELETE" })).body.signedIn == false, "signed out");
  ok("the Claude sign-in: a bad token refused, a good one stored and never shown, then signed out");

  console.log("all factory checks pass");
} finally {
  browser.close();
  // Docker VMs this server started (the label is its state folder's).
  if (docker) for (const id of spawnSync("docker", ["ps", "-aq", "--filter", `label=erga.factory=${dockerLabel(host.state)}`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)) {
    spawnSync("docker", ["rm", "-f", id], { stdio: "ignore" });
  }
  await host.dispose();
}
