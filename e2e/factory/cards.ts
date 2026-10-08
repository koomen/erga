// The board of fixture tasks the card tests share: a card in each state, served by
// fake.ts, on the plain dev server.

import { expect, servers, until, type Page } from "../fixtures";
import { ago, fake, picture, serve, tasks, type Fake } from "./fake";

const shot = (file: string) => ({ file, caption: file, at: ago(3) });

/** A fresh list each time (a test may change its tasks). */
export const cardTasks = () => tasks(
  ["Say hello on the front page", "merged", 300, "merged", { mergedAt: ago(290), mergeCommit: "fedcba9876543210" }],
  ["Builder: concurrent builds don't collide", "merged", 30, "merged", { mergedAt: ago(25), mergeCommit: "fedcba9876543211" }],
  ["Make factory task cards on /admin/factory more compact and easier to scan", "working", 2, "Reading the code"],
  ["Tests run in the factory VM without lsof", "working", 12, "Running tests/factory.ts under a time limit of 180 seconds"],
  ["Dark mode for the outline panel", "failed", 45, "failed", { error: "The build failed: src/page/outline.ts(12,3): Property 'x' does not exist." }],
  ["Show word counts in the document list, with a total for each folder", "complete", 70, "ready to merge", { url: "http://localhost:4400/", screenshots: [shot("a.png"), shot("b.png"), shot("c.png"), shot("d.png")] }],
  ["Faster first paint on the reader page", "complete", 8, "ready to merge", { url: "http://localhost:4401/", blockedBy: { start: [], merge: [3], stuck: [], reason: "can't merge until #3 merges" } }],
  ["Keyboard shortcuts help dialog", "queued", 1, "queued", { starting: true }],
  ["Export a document as EPUB, with the cover image and the table of contents", "queued", 4, "queued", { startAfter: [6], blockedBy: { start: [6], merge: [], stuck: [], reason: "waiting for #6 to merge" } }],
  ["Resolve the merge with staging", "needs agent", 3, "Merging origin/staging into the branch", { error: "conflicts merging origin/staging: README.md" }],
  ["Spell check in the editor", "merging", 1, "Merging origin/staging into the branch", { url: "http://localhost:4402/" }],
);

/** The cards on the board: every task but the merged ones. */
export const CARDS = 9;

/** The board of fixture tasks in the tab, `width` wide, its cards drawn and its fonts in. */
export async function cardBoard(page: Page, opts: { width?: number; dark?: boolean; shots?: boolean; fake?: Partial<Fake> } = {}) {
  const s = await servers.main();
  // The thumbnails' image, and the detail view's screenshots, each its own page so the grid shows which is which.
  const shots: Record<string, Buffer> = {};
  if (opts.shots) {
    for (const [i, f] of ["a", "b", "c", "d"].entries()) shots[f + ".png"] = await picture(page, `background:hsl(${i * 70 + 200},45%,88%)"><h1>Screenshot ${f.toUpperCase()}</h1><p>A page of the task, step ${i + 1}.</p>`, { width: 800, height: 500 });
  }
  const png = await picture(page, `background:linear-gradient(135deg,#dfe9f5,#f7efe3)"><h1>Preview</h1><p>A page of the task.</p>`);
  const f = fake(cardTasks(), { shot: (file) => shots[file] ?? png, ...opts.fake });
  await serve(page, f);
  await page.emulateMedia({ colorScheme: opts.dark ? "dark" : "light" });
  await page.setViewportSize({ width: opts.width ?? 1400, height: 900 });
  await page.goto(`${s.root}/admin/factory`);
  await shown(page);
  return f;
}

/** Waits until the board has drawn its cards, with its fonts. */
export async function shown(page: Page) {
  await until(() => page.evaluate(`document.querySelectorAll("#board .card").length == ${CARDS} && document.fonts.status == "loaded"`), 10_000, "the board draws its cards");
}

/** Each card's buttons, read where the board is: their order, which work, whether they fit one row, their tooltips. */
export const buttonRows = (page: Page) => page.evaluate(`[...document.querySelectorAll("#board .card")].map((c) => {
  const bs = [...c.querySelectorAll(".actions > *")], box = c.getBoundingClientRect(), r = bs.map((e) => e.getBoundingClientRect());
  const pad = parseFloat(getComputedStyle(c).paddingRight), last = bs.at(-1), lr = r.at(-1), spin = c.querySelector(".actions .spin");
  const sr = spin?.getBoundingClientRect();
  return { id: Number(c.dataset.open), keys: bs.map((e) => e.dataset.btn), on: bs.filter((e) => e.dataset.act || e.tagName == "A").map((e) => e.dataset.btn),
    inside: r.every((x) => x.left >= box.left && x.right <= box.right), oneRow: r.every((x) => Math.abs(x.top - r[0].top) < 1),
    overlap: r.some((a, i) => r.some((b, j) => i < j && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5)),
    tips: bs.map((e) => e.title), labels: bs.map((e) => e.getAttribute("aria-label")), text: bs.map((e) => e.textContent.trim()).join(""),
    mergeRight: !!lr && Math.abs(box.right - pad - lr.right) < 6,
    spin: sr ? { w: sr.width, h: sr.height, anim: getComputedStyle(spin).animationName } : null };
})`) as Promise<{ id: number; keys: string[]; on: string[]; inside: boolean; oneRow: boolean; overlap: boolean; tips: string[]; labels: string[]; text: string; mergeRight: boolean; spin: { w: number; h: number; anim: string } | null }[]>;

/** On each card: the four icon buttons in one order, in one row inside the card, apart, each with its tooltip; Merge on the right; a round spinner. */
export async function fits(page: Page) {
  for (const r of await buttonRows(page)) {
    expect(r.keys, `card #${r.id}'s buttons`).toEqual(["discard", "restart", "preview", "merge"]);
    expect(r.inside && r.oneRow && !r.overlap, `card #${r.id}: ${JSON.stringify(r)}`).toBe(true);
    expect(r.text, `card #${r.id}'s buttons are icons, no words`).toBe("");
    expect(r.tips.every((t) => t.length > 10) && r.labels.every(Boolean), `card #${r.id}'s tooltips: ${JSON.stringify(r.tips)}`).toBe(true);
    expect(r.mergeRight, `card #${r.id}'s Merge is on the right`).toBe(true);
    if (r.spin) expect(Math.abs(r.spin.w - r.spin.h) < 0.5 && r.spin.w >= 11 && r.spin.anim != "none", `card #${r.id}'s spinner: ${JSON.stringify(r.spin)}`).toBe(true);
  }
}
