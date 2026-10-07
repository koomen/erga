// The Source pane of the Factory page (source/page.ts) in a test's tab: what it shows, read in one go.

import { expect, type Page } from "../fixtures";

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
