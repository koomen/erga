// The Source page's task cards (source/page.ts): a factory task's commit on staging shows as a long, thin card with
// the task's name. Now each merge is one squash commit, which the server finds by the board's mergeCommit: its card
// has no commits under it and doesn't fold (the last test). A merge from before squash merges ("Merge
// task/<id>-<slug>: title") still shows as its card, and the commits that came in with it (its second parent's side,
// "Merge staging into task/…" included) follow it, their dots on the same rail, their subjects indented. Other commits
// show as always. A card folds its commits away, "Collapse all" folds every card, and the browser remembers it. A server of the file's own, main at 120 commits (more than the list's 100); each test pushes
// two tasks of its own, among plain commits, on top of staging.
import { beforeTests, expect, servers, test, type Page, type Server } from "../fixtures";
import { empty, gitAt, moveMain, seedLog } from "./source-page";
import { admin, clone, commit as commitFile, heads, must } from "./staging";

const own = () => servers.of("source-tasks");
await beforeTests(async () => { const s = await own(); await seedLog(s, (await admin(s)).token, 120); });

/**
 * Main moved to staging's head (so only this test's commits are ahead: more would show the break, source-gap.e2e.ts),
 * then on staging: plain commit A, task a (with staging merged into it on the way), plain B, task b, plain C. Their names.
 */
async function tasks(s: Server) {
  const who = await admin(s);
  const dir = clone(s, who.token);
  const head = must(dir, "rev-parse", "HEAD");
  if (heads(s, who.token).main != head) await moveMain(s, who, head);
  const tag = crypto.randomUUID().slice(0, 4);
  // Five digits each, so no task's number is the start of another's.
  const [a, b] = [10000 + Math.floor(Math.random() * 45000), 55000 + Math.floor(Math.random() * 44000)];
  const ta = `task/${a}-add-a-pricing-page`, tb = `task/${b}-let-readers-print-a-document`;
  const names = { tag, a, b, plainA: `Plain commit A ${tag}`, plainB: `Plain commit B ${tag}`, plainC: `Plain commit C ${tag}`, titleA: `Add a pricing page ${tag}`, titleB: `Let readers print a document ${tag}` };
  empty(dir, names.plainA);
  gitAt(dir, "checkout", "-q", "-b", ta);
  empty(dir, `Add the pricing page ${tag}`);
  empty(dir, `Test the pricing page ${tag}`);
  gitAt(dir, "checkout", "-q", "staging");
  empty(dir, names.plainB);
  gitAt(dir, "checkout", "-q", ta);
  gitAt(dir, "merge", "-q", "--no-ff", "-m", `Merge staging into ${ta}`, "staging");
  gitAt(dir, "checkout", "-q", "staging");
  gitAt(dir, "merge", "-q", "--no-ff", "-m", `Merge ${ta}: ${names.titleA}`, ta);
  gitAt(dir, "checkout", "-q", "-b", tb);
  empty(dir, `Print styles for documents ${tag}`);
  empty(dir, `A Print button in the viewer ${tag}`);
  empty(dir, `Describe printing in the README ${tag}`);
  gitAt(dir, "checkout", "-q", "staging");
  gitAt(dir, "merge", "-q", "--no-ff", "-m", `Merge ${tb}: ${names.titleB}`, tb);
  empty(dir, names.plainC);
  must(dir, "push", "-q", "origin", "HEAD:staging");
  return names;
}

type Row = { text: string; kind: string; shown: boolean; dot: number; textX: number };
const state = (page: Page) => page.evaluate(() => ({
  rows: [...document.querySelectorAll("#grid .row")].map((r) => {
    const card = r.querySelector(".task-card"), t = card ? card.querySelector(".name")! : r.querySelector(".subj span")!;
    return { text: card ? "#" + card.querySelector(".num")!.textContent!.slice(1) + " " + t.textContent + (card.querySelector(".n") ? " (" + card.querySelector(".n")!.textContent + ")" : "") : t.textContent!,
      kind: card ? "card" : r.classList.contains("in-task") ? "in-task" : "plain", shown: r.querySelector(".rail")!.getClientRects().length > 0,
      dot: Math.round(r.querySelector(".dot")!.getBoundingClientRect().x), textX: Math.round(t.getBoundingClientRect().x) };
  }) as Row[],
  foldAll: document.getElementById("fold-all")!.hidden ? "" : document.getElementById("fold-all")!.textContent!,
}));
const shown = async (page: Page) => (await state(page)).rows.filter((r) => r.shown).map((r) => r.text);

/** /admin/factory's Source pane, once the list has drawn with the test's newest commit at the top. */
async function openList(page: Page, root: string, top: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${root}/admin/factory#source`);
  await expect.poll(async () => (await state(page)).rows[0]?.text, { timeout: 10_000 }).toBe(top);
}
const card = (n: { a: number; b: number; titleA: string; titleB: string }, which: "a" | "b") => which == "a" ? `#${n.a} ${n.titleA} (3 commits)` : `#${n.b} ${n.titleB} (3 commits)`;
const clickFoldAll = (page: Page) => page.locator("#fold-all").click();

test("tasks start collapsed: only the tasks and the commits outside them; Expand all sits right after the git log heading", async ({ tab }) => {
  tab.strict = true;
  const s = await own(), page = tab.page, n = await tasks(s);
  await openList(page, s.root, n.plainC);
  expect((await state(page)).foldAll).toBe("Expand all");
  expect(await page.evaluate(() => document.getElementById("fold-all")!.previousElementSibling?.textContent)).toBe("git log");
  expect((await shown(page)).slice(0, 5)).toEqual([n.plainC, card(n, "b"), card(n, "a"), n.plainB, n.plainA]);
});

test("expanded: each task a card, then its commits indented a little, dots on one rail; other commits in their place; staging's last 100 commits; kept after a reload", async ({ tab }) => {
  tab.strict = true;
  const s = await own(), page = tab.page, n = await tasks(s);
  await openList(page, s.root, n.plainC);
  await clickFoldAll(page);
  await expect.poll(async () => (await state(page)).rows.every((r) => r.shown)).toBe(true);
  await page.reload();
  await expect.poll(async () => (await state(page)).rows[0]?.text, { timeout: 10_000 }).toBe(n.plainC);
  const st = await state(page);
  expect(st.rows.every((r) => r.shown)).toBe(true);
  expect(st.rows.length).toBe(100);
  const want = [
    [n.plainC, "plain"],
    [card(n, "b"), "card"],
    [`Describe printing in the README ${n.tag}`, "in-task"], [`A Print button in the viewer ${n.tag}`, "in-task"], [`Print styles for documents ${n.tag}`, "in-task"],
    [card(n, "a"), "card"],
    [`Merge staging into task/${n.a}-add-a-pricing-page`, "in-task"], [`Test the pricing page ${n.tag}`, "in-task"], [`Add the pricing page ${n.tag}`, "in-task"],
    [n.plainB, "plain"], [n.plainA, "plain"],
  ];
  expect(st.rows.slice(0, want.length).map((r) => [r.text, r.kind])).toEqual(want);
  expect(new Set(st.rows.map((r) => r.dot)).size, "every dot on the same rail").toBe(1);
  const plainX = st.rows.find((r) => r.kind == "plain")!.textX, memberX = st.rows.find((r) => r.kind == "in-task")!.textX;
  expect(memberX - plainX).toBeGreaterThanOrEqual(12);
  expect(memberX - plainX).toBeLessThanOrEqual(30);
  expect(st.foldAll).toBe("Collapse all");
});

test("a card folds its commits away and unfolds them", async ({ tab }) => {
  tab.strict = true;
  const s = await own(), page = tab.page, n = await tasks(s);
  await openList(page, s.root, n.plainC);
  await clickFoldAll(page);
  await expect.poll(async () => (await state(page)).rows.every((r) => r.shown)).toBe(true);
  const all = (await state(page)).rows.length;
  const fold = page.locator(`.task-card .fold[aria-label$="task ${n.b}"]`);
  await fold.click();
  await expect.poll(async () => (await shown(page)).length).toBe(all - 3);
  expect((await shown(page)).some((t) => t.startsWith("Print styles") && t.endsWith(n.tag))).toBe(false);
  await fold.click();
  await expect.poll(async () => (await shown(page)).length).toBe(all);
});

test("Collapse all folds every card, kept after a reload; Expand all unfolds them again", async ({ tab }) => {
  tab.strict = true;
  const s = await own(), page = tab.page, n = await tasks(s);
  await openList(page, s.root, n.plainC);
  const folded = (await shown(page)).length;
  await clickFoldAll(page);
  await expect.poll(async () => (await state(page)).foldAll).toBe("Collapse all");
  const all = (await state(page)).rows.length;
  expect(all).toBeGreaterThan(folded);
  await clickFoldAll(page);
  await expect.poll(async () => (await state(page)).foldAll).toBe("Expand all");
  expect((await shown(page)).length).toBe(folded);
  await page.reload();
  await expect.poll(async () => (await state(page)).rows[0]?.text, { timeout: 10_000 }).toBe(n.plainC);
  expect((await shown(page)).length).toBe(folded);
  await clickFoldAll(page);
  await expect.poll(async () => (await shown(page)).length).toBe(all);
});

test("a squash merge (one commit, the board's mergeCommit) is a card with no commits under it: no fold, no count", async ({ tab }) => {
  tab.strict = true;
  const s = await own(), page = tab.page, who = await admin(s);
  const dir = clone(s, who.token);
  const head = must(dir, "rev-parse", "HEAD");
  if (heads(s, who.token).main != head) await moveMain(s, who, head);
  const tag = crypto.randomUUID().slice(0, 4), id = 10000 + Math.floor(Math.random() * 89000);
  // The commit the factory's merge makes: the task's title, then its summary.
  const squash = commitFile(dir, `squash-${tag}.txt`, `${tag}\n`, `Add a pricing page ${tag}\n\nThis task adds a pricing page.`);
  const plain = empty(dir, `Plain commit ${tag}`);
  must(dir, "push", "-q", "origin", "HEAD:staging");
  // The board's merged task, as the server adds it to the view (worker/source.ts, mergedTasks): this server's factory
  // merges into a repository of its own (dev/factory.ts), so the test gives the view its task.
  await page.route("**/api/source/branches", async (route) => {
    const r = await route.fetch(), body = await r.json();
    for (const b of body.branches) for (const x of b.commits) if (x.sha == squash) x.task = { id, branch: `task/${id}-add-a-pricing-page`, title: `Add a pricing page ${tag}`, commits: [] };
    await route.fulfill({ response: r, json: body });
  });
  await openList(page, s.root, `Plain commit ${tag}`);
  const rows = (await state(page)).rows;
  expect(rows.slice(0, 2).map((r) => [r.text, r.kind])).toEqual([[`Plain commit ${tag}`, "plain"], [`#${id} Add a pricing page ${tag}`, "card"]]);
  expect(await page.locator(`.row[data-sha="${squash}"] .fold`).count()).toBe(0);
  expect(await page.locator(`.row[data-sha="${squash}"] .n`).count()).toBe(0);
  expect(plain).not.toBe(squash);
  // The page asks again on each event: a request still in the route when the test ends is dropped, not an error.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
