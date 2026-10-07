// The Source pane of the Factory page (source/page.ts) in a test's tab: what it shows, read in one go; and a log of
// commits to seed a server's repository with, for the pane to show.

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv, ROOT } from "../env";
import { expect, type Page, type Server } from "../fixtures";
import { gateGreen, merge } from "./staging";

export interface SourceState {
  rows: { subject: string; sha: string; kind: string; staging: string; live: string[] }[];
  heads: string[]; dots: number; ahead: string; merge: boolean; mergeShown: boolean; headGap: number; mirror: string; title: string; targets: string[];
}

/** Each row (its dot: shape|transform|background|border, and each deploy column's words), the heads, Merge and its count. */
export const sourceState = (page: Page) => page.evaluate(`(() => {
  const dot = (el) => {
    if (!el) return "none";
    const s = getComputedStyle(el);
    return [s.borderRadius == "50%" ? "circle" : "shape:" + s.borderRadius, s.transform == "none" ? "" : "transformed", s.backgroundColor, s.borderTopColor].join("|");
  };
  return {
    rows: [...document.querySelectorAll("#grid .row")].map((r) => ({ subject: r.querySelector(".subj span")?.textContent ?? "", sha: r.dataset.sha, kind: r.className,
      staging: dot(r.querySelector(".rail .dot")),
      live: [...r.querySelectorAll(".deps")].map((c) => [...c.querySelectorAll(".dep .w")].map((w) => w.textContent).join(" ")) })),
    heads: [...document.querySelectorAll("#grid > .head")].map((h) => h.textContent.trim()),
    dots: Math.max(...[...document.querySelectorAll("#grid .row")].map((r) => r.querySelectorAll(".dot").length)),
    ahead: document.getElementById("ahead").textContent, merge: !document.getElementById("merge").disabled,
    mergeShown: getComputedStyle(document.getElementById("merge")).display != "none" && getComputedStyle(document.getElementById("merge-row")).display != "none",
    headGap: (() => { const r = document.getElementById("merge-row").getBoundingClientRect(); return r.width + r.height; })(),
    mirror: document.getElementById("mirror-pill").textContent, title: document.title,
    targets: [...document.querySelectorAll(".target")].map((t) => t.textContent.replace(/\\s+/g, " ").trim()),
  };
})()`) as Promise<SourceState>;

/** /admin/factory at `size`, once the list and both deploy columns have drawn (the columns say "not set up" until their request answers). */
export async function openSource(page: Page, root: string, size = { width: 1280, height: 900 }) {
  await page.setViewportSize(size);
  await page.goto(`${root}/admin/factory`);
  await expect.poll(async () => { const s = await sourceState(page); return s.rows.length > 0 && s.targets.length == 2 && s.targets.every((t) => !t.includes("not set up")); }, { timeout: 10_000 }).toBe(true);
}

/** The open deploy log's lines, or "(closed)". */
export const logText = (page: Page) => page.evaluate(() => (document.getElementById("deploy-log") as HTMLDialogElement).open ? document.getElementById("log-lines")!.textContent! : "(closed)");

let clock = Math.floor(Date.now() / 1000);
/** git in `cwd`, each call a second after the last (so a log's order is fixed), failing the test if git does. */
export function gitAt(cwd: string, ...args: string[]) {
  clock = Math.max(clock + 1, Math.floor(Date.now() / 1000));
  const when = `${clock} +0000`;
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000, env: cleanEnv({ GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }) });
  expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
  return (r.stdout ?? "").trim();
}
/** An empty commit with this subject: its id. */
export const empty = (dir: string, subject: string) => (gitAt(dir, "commit", "-q", "--allow-empty", "-m", subject), gitAt(dir, "rev-parse", "HEAD"));

/**
 * Erga's repository on a server of the file's own (no other test's commits): main and staging at `n` commits ("Commit 1"
 * to n), seeded by source/import.ts through the Git endpoint. Run once, before the file's tests (beforeTests).
 */
export async function seedLog(s: Server, token: string, n: number) {
  const src = mkdtempSync(join(s.scratch, "seed-"));
  gitAt(src, "init", "-q", "-b", "main");
  for (let i = 1; i <= n; i++) empty(src, `Commit ${i}`);
  const r = spawnSync("bun", [join(ROOT, "source/import.ts"), s.root, "--from", src], { encoding: "utf8", env: cleanEnv({ ERGA_TOKEN: token }), timeout: 60_000 });
  if (r.status != 0) throw new Error(`source/import.ts: ${r.stdout}${r.stderr}`);
}

/** Main moved forward to `commit` (its tests run first: main moves only to a commit whose tests passed). */
export async function moveMain(s: Server, who: { token: string; cookie: string }, commit: string) {
  await gateGreen(s, who.token, commit);
  const r = await merge(s, who, "token", { commit });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
