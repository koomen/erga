#!/usr/bin/env bun
// The Source page's task cards: a factory task's merge ("Merge task/<id>-<slug>:
// title") shows as a long, thin card with the task's name, and the commits that
// came in with it (its second parent's side, "Merge staging into task/…"
// included) follow it, their dots on the same rail, their subjects indented.
// Other commits show as always, in their place. A card folds its commits away,
// "Collapse all" folds every card (the list shows only tasks), and the
// browser remembers it. On a dev server of its own (tests/host.ts), in headless
// Chrome; screenshots land in SHOTS.
//
//   bun tests/source-tasks.ts                 the test
//   bun tests/source-tasks.ts --seed <url>    only seed a running dev server, for a preview

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, ROOT, SHOTS, type Page } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

let clock = Date.parse("2026-10-01T09:00:00Z") / 1000;
const must = (cwd: string, ...args: string[]) => {
  const when = `${clock++} +0000`; // one second apart, so log's order is fixed
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com", GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  expect(r.status == 0, `git ${args.join(" ")}`, r.stderr);
  return (r.stdout ?? "").trim();
};
const commit = (dir: string, subject: string) => must(dir, "commit", "-q", "--allow-empty", "-m", subject);

/** Seeds `root`: main at 120 commits (more than the list's 100), then on staging two factory tasks (the first with staging merged into it on the way) among plain commits. */
async function seed(root: string) {
  const r = await fetch(`${root}/auth/github?next=/docs`, { redirect: "manual" });
  const cookie = r.headers.getSetCookie().map((x) => x.split(";")[0]).find((x) => x.startsWith("erga_session="))!;
  const page = await (await fetch(`${root}/tokens/new`, { method: "POST", headers: { Cookie: cookie, Origin: root }, body: new URLSearchParams({ label: "Git", scope: "admin" }) })).text();
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1] ?? "";
  expect(token, "an admin's token", page.slice(0, 300));
  const src = mkdtempSync(join(tmpdir(), "erga-tasks-"));
  must(src, "init", "-q", "-b", "main");
  for (let i = 1; i <= 120; i++) commit(src, `Commit ${i}`);
  const env = { ...process.env, ERGA_TOKEN: token };
  const seeded = spawnSync("bun", [join(ROOT, "source/import.ts"), root, "--from", src], { encoding: "utf8", env });
  expect(seeded.status == 0, "source/import.ts seeds main and staging", seeded.stdout + seeded.stderr);
  const u = new URL(root);
  must(src, "remote", "add", "erga", `${u.protocol}//erga:${encodeURIComponent(token)}@${u.host}/git/erga.git`);
  commit(src, "Plain commit A");
  const t7 = "task/7-add-a-pricing-page";
  must(src, "checkout", "-q", "-b", t7);
  commit(src, "Add the pricing page");
  commit(src, "Test the pricing page");
  must(src, "checkout", "-q", "main");
  commit(src, "Plain commit B");
  must(src, "checkout", "-q", t7);
  must(src, "merge", "-q", "--no-ff", "-m", `Merge staging into ${t7}`, "main");
  must(src, "checkout", "-q", "main");
  must(src, "merge", "-q", "--no-ff", "-m", `Merge ${t7}: Add a pricing page`, t7);
  const t8 = "task/8-let-readers-print-a-document";
  must(src, "checkout", "-q", "-b", t8);
  commit(src, "Print styles for documents");
  commit(src, "A Print button in the viewer");
  commit(src, "Describe printing in the README");
  must(src, "checkout", "-q", "main");
  must(src, "merge", "-q", "--no-ff", "-m", `Merge ${t8}: Let readers print a document`, t8);
  commit(src, "Plain commit C");
  must(src, "push", "-q", "erga", "HEAD:staging");
}

const at = process.argv.indexOf("--seed");
if (at > 0) {
  await seed(process.argv[at + 1].replace(/\/$/, ""));
  console.log("seeded: main at Commit 120, staging with tasks #7 and #8");
  process.exit(0);
}

const host = await startHost(null);
const root = host.root;
let browser: Browser | null = null;
try {
  await seed(root);
  browser = await Browser.launch();
  const p: Page = await browser.page(await browser.context());
  type Row = { text: string; kind: string; shown: boolean; dot: number; text_x: number };
  const state = () => p.eval<{ rows: Row[]; foldAll: string }>(`(() => ({
    rows: [...document.querySelectorAll("#grid .row")].map((r) => {
      const card = r.querySelector(".task-card"), t = card ? card.querySelector(".name") : r.querySelector(".subj span");
      return { text: card ? "#" + card.querySelector(".num").textContent.slice(1) + " " + t.textContent + " (" + card.querySelector(".n").textContent + ")" : t.textContent,
        kind: card ? "card" : r.classList.contains("in-task") ? "in-task" : "plain", shown: r.querySelector(".rail").getClientRects().length > 0,
        dot: Math.round(r.querySelector(".dot").getBoundingClientRect().x), text_x: Math.round(t.getBoundingClientRect().x) };
    }),
    foldAll: document.getElementById("fold-all").hidden ? "" : document.getElementById("fold-all").textContent,
  }))()`);
  const shown = async () => (await state()).rows.filter((r) => r.shown);

  await p.open(`${root}/admin/factory#source`, { width: 1280, height: 900, scale: 2, clear: false });
  await until(async () => (await state()).rows.length > 0, 10_000, "the list draws", state);
  // The first visit: every card folded, only tasks and the commits outside them; Expand all right after the heading.
  let s = await state();
  const only = (await shown()).map((r) => r.text);
  expect(s.foldAll == "Expand all", "tasks start collapsed: the header offers to expand them", s.foldAll);
  expect(await p.eval<boolean>(`document.getElementById("fold-all").previousElementSibling?.textContent == "git log"`), "Expand all sits right after the git log heading");
  expect(JSON.stringify(only.slice(0, 5)) == JSON.stringify(["Plain commit C", "#8 Let readers print a document (3 commits)", "#7 Add a pricing page (3 commits)", "Plain commit B", "Plain commit A"]), "folded: the tasks, and the commits outside them", only);
  await p.screenshot(join(SHOTS, "source-tasks-collapsed.png"));
  console.log("ok   tasks start collapsed, Expand all right after the git log heading");

  // Expand all: every commit, kept after a reload.
  await p.eval(`document.getElementById("fold-all").click()`);
  await until(async () => (await shown()).length == s.rows.length, 5_000, "Expand all unfolds every card", state);
  await p.open(`${root}/admin/factory#source`, { width: 1280, height: 900, scale: 2, clear: false });
  await until(async () => (await state()).rows.length > 0, 10_000, "the list draws again", state);
  s = await state();
  expect(s.rows.every((r) => r.shown), "expanded after a reload too", s.rows);
  expect(s.rows.length == 100, "the list shows staging's last 100 commits", s.rows.length);
  const want = [
    ["Plain commit C", "plain"],
    ["#8 Let readers print a document (3 commits)", "card"],
    ["Describe printing in the README", "in-task"], ["A Print button in the viewer", "in-task"], ["Print styles for documents", "in-task"],
    ["#7 Add a pricing page (3 commits)", "card"],
    ["Merge staging into task/7-add-a-pricing-page", "in-task"], ["Test the pricing page", "in-task"], ["Add the pricing page", "in-task"],
    ["Plain commit B", "plain"], ["Plain commit A", "plain"],
    ["Commit 120", "plain"], ["Commit 119", "plain"],
  ];
  expect(JSON.stringify(s.rows.slice(0, want.length).map((r) => [r.text, r.kind])) == JSON.stringify(want), "each task: a card, then its commits; other commits in their place", s.rows);
  expect(new Set(s.rows.map((r) => r.dot)).size == 1, "every dot on the same rail", s.rows.map((r) => r.dot));
  const plainX = s.rows.find((r) => r.kind == "plain")!.text_x, memberX = s.rows.find((r) => r.kind == "in-task")!.text_x;
  expect(memberX - plainX >= 12 && memberX - plainX <= 30, "a task's commits indented a little", { plainX, memberX });
  expect(s.foldAll == "Collapse all", "expanded, the header offers to collapse the tasks", s.foldAll);
  await p.screenshot(join(SHOTS, "source-tasks-expanded.png"));
  console.log("ok   task cards with their commits under them, dots on one rail, subjects indented");

  // One card folds and unfolds.
  await p.eval(`document.querySelector('.task-card .fold[aria-label*="task 8"]').click()`);
  await until(async () => (await shown()).length == s.rows.length - 3, 5_000, "task #8 folds", state);
  expect(!(await shown()).some((r) => r.text.includes("Print")), "task #8's commits hidden", await shown());
  await p.eval(`document.querySelector('.task-card .fold[aria-label*="task 8"]').click()`);
  await until(async () => (await shown()).length == s.rows.length, 5_000, "task #8 unfolds", state);
  console.log("ok   a card folds and unfolds its commits");

  // Collapse all: only tasks, and plain commits; kept after a reload.
  await p.eval(`document.getElementById("fold-all").click()`);
  await until(async () => (await state()).foldAll == "Expand all", 5_000, "Collapse all folds every card", state);
  expect((await shown()).length == only.length, "Collapse all folds every card", await shown());
  await p.open(`${root}/admin/factory#source`, { width: 1280, height: 900, scale: 2, clear: false });
  await until(async () => (await state()).rows.length > 0, 10_000, "the list draws again", state);
  expect((await shown()).length == only.length, "folded after a reload too", await shown());
  await p.eval(`document.getElementById("fold-all").click()`);
  await until(async () => (await shown()).length == s.rows.length, 5_000, "Expand all unfolds every card again", state);
  console.log("ok   Expand all and Collapse all, each kept after a reload");
  expect(!p.errors.length, "no errors on the page", p.errors);
} finally {
  browser?.close();
  await host.dispose();
}
