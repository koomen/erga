// The multiplayer suite in real tabs (e2e/suite/suites/browser.ts): people typing on the page, their carets and
// coloured marks, interleaved typing, ⌘Z undoing only your own, a join undone for all.
import { Participant } from "./client";
import { expect, until } from "./harness";
import { browserTest, caretIn, noErrors, openAs, peerNames } from "./suite";

const FILE = "e2e/full/suite/browser-typing.e2e.ts";

browserTest(FILE, "two people typing on the page see each other's edits and carets", {}, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada"), b = await openAs(tab, ctx, d, "Bo");
  const tips = (t: typeof a) => t.eval<string[]>(`[...document.querySelectorAll(":is(#me, #people) .avatar")].map((e) => e.dataset.tip)`);
  await until(async () => (await tips(a)).some((t) => t.startsWith("Bo")) && (await tips(b)).some((t) => t.startsWith("Ada")), 5000, "each sees the other at the top", async () => [await tips(a), await tips(b)]);
  await b.frame(`${b.W}.__marker = 1`);
  await a.clickEnd("h1");
  await a.type(" (draft)");
  await until(async () => (await b.textOf("h1")) == (await a.textOf("h1")), 5000, "Bo's page shows Ada's typing");
  expect(await b.frame<boolean>(`${b.W}.__marker == 1`), "without a reload");
  const m = await b.marks();
  expect(m.added.join("").includes("(draft)") && m.names.every((n) => /^erga-a\d+-/.test(n)), "marked in Ada's colour", m);
  await until(async () => (await peerNames(b)) == "Ada", 5000, "Ada's caret shows on Bo's page");
  noErrors(a, "Ada"); noErrors(b, "Bo");
});

browserTest(FILE, "your other tabs' carets aren't drawn, and someone with several tabs shows one caret, from the tab they used last", {}, async (ctx, tab) => {
  const d = await ctx.doc();
  const a1 = await openAs(tab, ctx, d, "Ada"), a2 = await openAs(tab, ctx, d, "Ada"), b = await openAs(tab, ctx, d, "Bo");
  await b.clickEnd("li:first-child");
  await a1.clickEnd("h1");
  await a2.clickEnd("figcaption");
  await until(async () => (await peerNames(b)) == "Ada" && (await caretIn(b, "figcaption")), 5000, "Bo sees one Ada caret, from the tab she used last", async () => peerNames(b));
  for (const [t, who] of [[a1, "Ada's first tab"], [a2, "Ada's second tab"]] as const) {
    await until(async () => (await peerNames(t)) == "Bo", 5000, `${who} shows Bo's caret and not her own other tab's`, async () => peerNames(t));
  }
  await a1.type("!");
  await until(async () => (await b.textOf("h1")).endsWith("!"), 5000, "Bo has Ada's typing in her first tab");
  await until(async () => (await peerNames(b)) == "Ada" && (await caretIn(b, "h1")) && !(await caretIn(b, "figcaption")), 5000, "her caret moves to the tab she's using now", async () => peerNames(b));
  noErrors(a1, "Ada 1"); noErrors(a2, "Ada 2"); noErrors(b, "Bo");
});

browserTest(FILE, "interleaved typing converges and is stored; ⌘Z undoes only your own", {}, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada"), b = await openAs(tab, ctx, d, "Bo");
  await a.clickEnd("figcaption");
  await b.clickEnd("li:first-child");
  for (const [x, y] of [["1", "4"], ["2", "5"], ["3", "6"]]) { await a.type(x); await b.type(y); }
  // A keystroke reaches the room a moment after it shows (bridge.ts: one offered against an older version goes round again), so wait for all of it.
  const both = (t: string) => t.includes("go.123</figcaption>") && /<li>[^<]*456<\/li>/.test(t);
  await until(async () => { const t = await a.source(); return both(t) && t == (await b.source()); }, 5000, "the tabs converge, with both people's typing", async () => (await a.source()).match(/<figcaption>.*?<\/figcaption>|<li>.*?<\/li>/g));
  const s = await a.source();
  await until(async () => (await d.stored(d.path))?.text == s, 5000, "and stored");
  await b.press("ControlOrMeta+z");
  await until(async () => !(await a.source()).includes("456"), 5000, "Bo's ⌘Z takes his typing back, for Ada too");
  expect((await a.source()).includes("go.123") && (await b.source()) == (await a.source()), "Ada's typing stays");
  noErrors(a, "Ada"); noErrors(b, "Bo");
});

browserTest(FILE, "Backspace at the start of a list item joins it to the paragraph before, for others too, and one ⌘Z undoes it for all", {}, async (ctx, tab) => {
  const d = await ctx.doc("join");
  const a = await openAs(tab, ctx, d, "Ada"), b = await openAs(tab, ctx, d, "Bo");
  const original = await a.source();
  await a.clickEnd("#one");
  await a.press("Home");
  await a.press("Backspace");
  const joined = `<p id="gamma">keeps its own type.Item one</p>`;
  await until(async () => (await a.source()).includes(joined) && (await b.source()) == (await a.source()), 5000, "both tabs have the join", async () => (await b.source()).match(/<p id="gamma">[\s\S]*?<\/ul>/)?.[0]);
  await until(async () => (await b.count("li")) == 1 && (await b.textOf("#gamma")) == "keeps its own type.Item one", 5000, "Bo's page shows it");
  const s = await a.source();
  await until(async () => (await d.stored(d.path))?.text == s, 5000, "and stored");
  await a.idle();
  await a.press("ControlOrMeta+z");
  await until(async () => (await b.source()) == original && (await b.count("li")) == 2, 5000, "Ada's one ⌘Z brings both blocks back, for Bo too");
  noErrors(a, "Ada"); noErrors(b, "Bo");
});

browserTest(FILE, "a headless participant's edit shows on the page like anyone's", {}, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada");
  const x = await Participant.join(d, "Xavier");
  ctx.defer(() => x.destroy());
  x.insertAfter("Where the leads ", "really ");
  await until(async () => (await a.textOf("figcaption")).includes("really"), 5000, "Ada's page shows Xavier's edit");
  x.setCursor(x.str().indexOf("really"));
  await until(async () => (await peerNames(a)) == "Xavier", 5000, "and his caret");
});
