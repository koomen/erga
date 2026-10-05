#!/usr/bin/env bun
// The Source page's break: when staging is more than 25 commits (its log)
// ahead of main, the list shows staging's newest commits, then "… N more
// commits only on staging …", then main's head and a few behind it. At 25 or
// fewer apart, the list is as always, with no break. On a dev server of its
// own (tests/host.ts), in headless Chrome; screenshots land in SHOTS.
//
//   bun tests/source-gap.ts                 the test
//   bun tests/source-gap.ts --seed <url>    only seed a running dev server (main 3 commits, staging 40 ahead), for a preview

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

/** Seeds `root`: main at three commits, staging `ahead` past it. Returns the clone and how to push and merge. */
async function seed(root: string, ahead: number) {
  const r = await fetch(`${root}/auth/github?next=/docs`, { redirect: "manual" });
  const cookie = r.headers.getSetCookie().map((x) => x.split(";")[0]).find((x) => x.startsWith("erga_session="))!;
  const page = await (await fetch(`${root}/tokens/new`, { method: "POST", headers: { Cookie: cookie, Origin: root }, body: new URLSearchParams({ label: "Git" }) })).text();
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1] ?? "";
  expect(token, "an admin's token", page.slice(0, 300));
  const src = mkdtempSync(join(tmpdir(), "erga-gap-"));
  must(src, "init", "-q", "-b", "main");
  commits(src, 1, 3);
  const seeded = spawnSync("bun", [join(ROOT, "source/import.ts"), root, "--from", src], { encoding: "utf8", env: { ...env, ERGA_TOKEN: token } });
  expect(seeded.status == 0, "source/import.ts seeds main and staging", seeded.stdout + seeded.stderr);
  const u = new URL(root);
  must(src, "remote", "add", "erga", `${u.protocol}//erga:${encodeURIComponent(token)}@${u.host}/git/erga.git`);
  commits(src, 4, 3 + ahead);
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
  console.log("seeded: main at Commit 3, staging at Commit 43");
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

  // 40 ahead: staging's 25 newest, the break with the 15 left out, then main's head and the two behind it.
  await p.open(`${root}/admin/source#source`, { width: 1280, height: 1400, scale: 2, clear: false });
  await until(async () => (await state()).rows.length > 0, 10_000, "the list draws", state);
  let s = await state();
  const want = [...Array.from({ length: 25 }, (_, i) => `Commit ${43 - i}`), "Commit 3 (main)", "Commit 2 (main)", "Commit 1 (main)"];
  expect(s.rows.join() == want.join() && s.gap?.includes("15 more commits only on staging") && s.gapAt == 25, "40 ahead: staging's 25 newest, a break with 15 more, then main's head", s);
  await p.screenshot(join(SHOTS, "source-gap.png"));
  console.log("ok   more than 25 ahead: a break between staging's newest commits and main's head");

  // 26 ahead: one commit left out.
  const head = (n: number) => must(src, "rev-parse", `HEAD~${43 - n}`);
  await merge(head(17));
  await until(async () => (await state()).gap?.includes("1 more commit only") ?? false, 10_000, "26 ahead: the break says 1 more commit", state);
  // 25 ahead: no break, staging's 25 commits as before.
  await merge(head(18));
  await until(async () => (await state()).gap == null, 10_000, "25 ahead: no break", state);
  s = await state();
  expect(s.rows.length == 25 && s.rows[0] == "Commit 43" && !s.rows.some((x) => x.endsWith("(main)")), "25 ahead: staging's log as always", s);
  // A few ahead: as always, main's commits in staging's log.
  await merge(head(40));
  await until(async () => (await state()).rows.includes("Commit 40 (main)"), 10_000, "3 ahead: the log as always", state);
  s = await state();
  expect(s.gap == null && s.rows.length == 25 && s.rows.slice(0, 4).join() == "Commit 43,Commit 42,Commit 41,Commit 40 (main)", "3 ahead: no break; staging's log with main's commits in it", s);
  await p.screenshot(join(SHOTS, "source-no-gap.png"));
  expect(!p.errors.length, "no errors on the page", p.errors);
  console.log("ok   25 or fewer ahead: the log as always, no break");
} finally {
  browser?.close();
  await host.dispose();
}
