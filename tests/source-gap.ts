#!/usr/bin/env bun
// The Source page's break: when staging is far ahead of main, the list shows
// staging's head and the 10 commits before it, then "… N more commits only on
// staging …", then the 5 commits just after main's head (the server's
// afterMain), then main's head and the 5 before it. The break shows only when
// it leaves commits out (17 or more ahead); else the list is as always. On a
// dev server of its own (tests/host.ts), in headless Chrome; screenshots land
// in SHOTS.
//
//   bun tests/source-gap.ts                 the test
//   bun tests/source-gap.ts --seed <url>    only seed a running dev server (main 10 commits, staging 40 ahead), for a preview

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, ROOT, SHOTS, type Page } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } as Record<string, string>;
const must = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  expect(r.status == 0, `git ${args.join(" ")}`, r.stderr);
  return (r.stdout ?? "").trim();
};
const commits = (dir: string, from: number, to: number) => { for (let i = from; i <= to; i++) must(dir, "commit", "-q", "--allow-empty", "-m", `Commit ${i}`); };

/** Seeds `root`: main at ten commits (Commit 1 to 10), staging `ahead` past it. Returns the clone and how to push and merge. */
async function seed(root: string, ahead: number) {
  const r = await fetch(`${root}/auth/github?next=/docs`, { redirect: "manual" });
  const cookie = r.headers.getSetCookie().map((x) => x.split(";")[0]).find((x) => x.startsWith("erga_session="))!;
  const page = await (await fetch(`${root}/tokens/new`, { method: "POST", headers: { Cookie: cookie, Origin: root }, body: new URLSearchParams({ label: "Git" }) })).text();
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1] ?? "";
  expect(token, "an admin's token", page.slice(0, 300));
  const src = mkdtempSync(join(tmpdir(), "erga-gap-"));
  must(src, "init", "-q", "-b", "main");
  commits(src, 1, 10);
  const seeded = spawnSync("bun", [join(ROOT, "source/import.ts"), root, "--from", src], { encoding: "utf8", env: { ...env, ERGA_TOKEN: token } });
  expect(seeded.status == 0, "source/import.ts seeds main and staging", seeded.stdout + seeded.stderr);
  const u = new URL(root);
  must(src, "remote", "add", "erga", `${u.protocol}//erga:${encodeURIComponent(token)}@${u.host}/git/erga.git`);
  commits(src, 11, 10 + ahead);
  must(src, "push", "-q", "erga", "HEAD:staging");
  const merge = async (commit: string) => {
    const m = await fetch(`${root}/api/source/merge`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ commit }) });
    expect(m.status == 200, "main moves forward", await m.text());
  };
  return { src, merge };
}

const at = process.argv.indexOf("--seed");
if (at > 0) {
  await seed(process.argv[at + 1].replace(/\/$/, ""), 40);
  console.log("seeded: main at Commit 10, staging at Commit 50");
  process.exit(0);
}

const host = await startHost(null);
const root = host.root;
let browser: Browser | null = null;
try {
  const { src, merge } = await seed(root, 40);
  browser = await Browser.launch();
  const p: Page = await browser.page(await browser.context());
  const state = () => p.eval<{ rows: string[]; gap: string | null; gapAt: number }>(`(() => {
    const items = [...document.querySelectorAll("#grid .row, #grid .gap")];
    return { rows: [...document.querySelectorAll("#grid .row")].map((r) => r.querySelector(".subj span").textContent + (r.classList.contains("on-main") ? " (main)" : "")),
      gap: document.querySelector("#grid .gap")?.textContent ?? null, gapAt: items.findIndex((x) => x.classList.contains("gap")) };
  })()`);

  const range = (from: number, to: number, main = false) => Array.from({ length: from - to + 1 }, (_, i) => `Commit ${from - i}` + (main ? " (main)" : ""));
  const head = (n: number) => must(src, "rev-parse", `HEAD~${50 - n}`);
  /** Staging's head and the 10 before it, the break, the 5 just after main's head, then main's head and the 5 before it. */
  const broken = async (main: number, hidden: number, shot: string) => {
    const want = [...range(50, 40), ...range(main + 5, main + 1), ...range(main, main - 5, true)];
    const n = hidden + " more commit" + (hidden == 1 ? "" : "s") + " only on staging";
    await until(async () => (await state()).gap?.includes(n) ?? false, 10_000, `${50 - main} ahead: the break says ${n}`, state);
    const s = await state();
    expect(s.rows.join() == want.join() && s.gapAt == 11, `${50 - main} ahead: 11 above the break (staging's head and 10), 5 below it, then main's head and 5 before it`, s);
    await p.screenshot(join(SHOTS, shot));
  };

  // 40 ahead: 24 commits left out.
  await p.open(`${root}/admin/source#source`, { width: 1280, height: 1400, scale: 2, clear: false });
  await until(async () => (await state()).rows.length > 0, 10_000, "the list draws", state);
  await broken(10, 24, "source-gap.png");
  console.log("ok   40 ahead: staging's head and 10, a break with 24 more, the 5 after main, main's head and 5 before it");

  // 17 ahead: just far enough for the break, with one commit left out.
  await merge(head(33));
  await broken(33, 1, "source-gap-1.png");
  console.log("ok   17 ahead: the break, with 1 more commit");

  // 16 ahead: nothing left out, so no break: staging's log as always (its 16 commits, then main's head and 8 before it).
  await merge(head(34));
  await until(async () => (await state()).gap == null, 10_000, "16 ahead: no break", state);
  let s = await state();
  expect(s.rows.join() == [...range(50, 35), ...range(34, 26, true)].join(), "16 ahead: staging's log as always, no break", s);
  // A few ahead: as always.
  await merge(head(47));
  await until(async () => (await state()).rows.includes("Commit 47 (main)"), 10_000, "3 ahead: the log as always", state);
  s = await state();
  expect(s.gap == null && s.rows.join() == [...range(50, 48), ...range(47, 26, true)].join(), "3 ahead: no break; staging's log with main's commits in it", s);
  await p.screenshot(join(SHOTS, "source-no-gap.png"));
  expect(!p.errors.length, "no errors on the page", p.errors);
  console.log("ok   16 or fewer ahead: the log as always, no break");
} finally {
  browser?.close();
  await host.dispose();
}
