// The Source page's break (source/page.ts; tests/source-gap.ts): when staging is far ahead of main, the list shows
// staging's head and the 10 commits before it, "… N more commits only on staging …", the 5 commits just after main's
// head (afterMain), then main's head and the 5 before it. The break shows only when it leaves commits out (17 or more
// ahead); else the list is as always. And each move of main (a production deploy) is in the change log.
// A server of the file's own, its repository seeded once; each test first moves main to staging's head, then pushes
// commits of its own, so none depends on another.
import { beforeTests, expect, servers, test, type Page, type Server } from "../fixtures";
import { empty, gitAt, moveMain, seedLog } from "./source-page";
import { admin, clone, heads, must } from "./staging";

const own = () => servers.of("source-gap");
await beforeTests(async () => { const s = await own(); await seedLog(s, (await admin(s)).token, 30); });

/** Main at staging's head, then `n` new commits on staging ("<tag> 1" to n): the clone, the tag, and the commits' ids, oldest first. */
async function ahead(s: Server, n: number) {
  const who = await admin(s);
  const dir = clone(s, who.token);
  const head = must(dir, "rev-parse", "HEAD");
  if (heads(s, who.token).main != head) await moveMain(s, who, head);
  const tag = `T${crypto.randomUUID().slice(0, 6)}`;
  const ids = Array.from({ length: n }, (_, i) => empty(dir, `${tag} ${i + 1}`));
  must(dir, "push", "-q", "origin", "HEAD:staging");
  return { who, dir, tag, ids, base: head };
}

const state = (page: Page) => page.evaluate(() => {
  const items = [...document.querySelectorAll("#grid .row, #grid .gap")];
  return { rows: [...document.querySelectorAll("#grid .row")].map((r) => r.querySelector(".subj span")!.textContent + (r.classList.contains("on-main") ? " (main)" : "")),
    gap: document.querySelector("#grid .gap")?.textContent ?? null, gapAt: items.findIndex((x) => x.classList.contains("gap")) };
});
/** The subjects of `ref`'s last `n` commits, newest first (with " (main)" when asked). */
const log = (dir: string, ref: string, n: number, main = false) => gitAt(dir, "log", "--format=%s", `-${n}`, ref).split("\n").map((x) => x + (main ? " (main)" : ""));
const subjects = (tag: string, from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => `${tag} ${from - i}`);

async function openList(page: Page, root: string) {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto(`${root}/admin/factory#source`);
  await expect.poll(async () => (await state(page)).rows.length, { timeout: 10_000 }).toBeGreaterThan(0);
}

/** n ahead, `hidden` left out: staging's head and 10 before it, the break, the 5 just after main's head, then main's head and the 5 before it. */
async function broken(page: Page, s: Server, n: number, hidden: number) {
  const { dir, tag, base } = await ahead(s, n);
  await openList(page, s.root);
  const says = `${hidden} more commit${hidden == 1 ? "" : "s"} only on staging`;
  await expect.poll(async () => (await state(page)).gap ?? "", { timeout: 10_000 }).toContain(says);
  const want = [...subjects(tag, n, n - 10), ...subjects(tag, 5, 1), ...log(dir, base, 6, true)];
  const st = await state(page);
  expect(st.rows).toEqual(want);
  expect(st.gapAt).toBe(11);
}

test("40 ahead: staging's head and 10, a break with 24 more, the 5 after main, main's head and 5 before it", async ({ tab }) => {
  tab.strict = true;
  await broken(tab.page, await own(), 40, 24);
});

test("17 ahead, just far enough for the break: it says 1 more commit", async ({ tab }) => {
  tab.strict = true;
  await broken(tab.page, await own(), 17, 1);
});

test("16 ahead, nothing left out: no break, staging's log as always with main's commits marked", async ({ tab }) => {
  tab.strict = true;
  const s = await own(), page = tab.page;
  const { dir, tag, base } = await ahead(s, 16);
  await openList(page, s.root);
  await expect.poll(async () => (await state(page)).rows[0]).toBe(`${tag} 16`);
  const st = await state(page);
  expect(st.gap).toBe(null);
  expect(st.rows.length).toBeGreaterThan(16 + 6);
  expect(st.rows).toEqual([...subjects(tag, 16, 1), ...log(dir, base, st.rows.length - 16, true)]);
});

test("a few ahead: no break; staging's log with main's commits in it", async ({ tab }) => {
  tab.strict = true;
  const s = await own(), page = tab.page;
  const { who, dir, tag, ids } = await ahead(s, 6);
  await moveMain(s, who, ids[2]);
  await openList(page, s.root);
  await expect.poll(async () => (await state(page)).rows.slice(0, 4)).toEqual([`${tag} 6`, `${tag} 5`, `${tag} 4`, `${tag} 3 (main)`]);
  const st = await state(page);
  expect(st.gap).toBe(null);
  expect(st.rows).toEqual([...subjects(tag, 6, 4), ...log(dir, ids[2], st.rows.length - 3, true)]);
});

test("each move of main is a production deploy in the change log: who, main's old and new head, and the commits it brought, newest first", async ({ tab }) => {
  tab.strict = true;
  const s = await own(), page = tab.page;
  const { who, tag, ids, base } = await ahead(s, 13);
  await moveMain(s, who, ids[0]);
  await moveMain(s, who, ids[12]);
  const deploys = () => page.evaluate(() => [...document.querySelectorAll("li.change")].filter((li) => li.querySelector(".what .key")?.textContent == "main").map((li) => ({
    by: li.querySelector(".by")!.textContent, what: li.querySelector(".what")!.textContent!.replace(/\s+/g, " ").trim(), commits: [...li.querySelectorAll(".commits li")].map((c) => c.textContent!.trim()) })));
  const short = (id: string) => id.slice(0, 7);
  await page.goto(`${s.root}/admin/changes`);
  await expect.poll(async () => (await deploys())[0]?.what ?? (await page.reload(), ""), { timeout: 10_000 }).toContain(`main ${short(ids[0])} → ${short(ids[12])} `);
  const [last, before] = await deploys();
  expect(last.by).toBe("tester");
  expect(last.what).toContain("12 commits");
  expect(last.commits).toEqual(subjects(tag, 13, 2).map((c, i) => `${short(ids[12 - i])} ${c}`));
  expect(before.what.startsWith(`main ${short(base)} → ${short(ids[0])} `), before.what).toBe(true);
  expect(before.commits).toEqual([`${short(ids[0])} ${tag} 1`]);
});
