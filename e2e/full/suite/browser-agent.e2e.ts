// The multiplayer suite in real tabs: the agent panel is per person, view_page answers
// a picture in its owner's panel, others see its edits as they happen, a message that can't be sent says so.
import { expect } from "./harness";
import { until } from "../../helpers/fixtures";
import { browserTest, marksNow, noErrors, openAs, peerNames, seenMarks, watchMarks } from "./suite";

const FILE = "e2e/full/suite/browser-agent.e2e.ts";

browserTest(FILE, "the agent panel is per person, and the agent sees the page through its owner's tab", { needs: ["scriptedAgent"] }, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada"), b = await openAs(tab, ctx, d, "Bo");
  await a.openAgent();
  const script = JSON.stringify([
    { tool: "edit", args: { path: d.path, edits: [{ oldText: "<h1>Launch notes", newText: "<h1>Launch notes by agent" }] } },
    { tool: "page", args: { op: "view_page", selector: "h1" } },
    { text: "Looked." },
  ]);
  await a.eval(
    `(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify("Check it @script " + script)}; i.dispatchEvent(new Event("input")); })()`
  );
  await a.press("Enter");
  await until(
    async () => a.eval<boolean>(`[...document.querySelectorAll(".msg-assistant")].some((e) => e.textContent == "Looked.")`),
    10_000,
    "Ada's panel shows the reply"
  );
  expect(
    await a.eval<boolean>(
      `[...document.querySelectorAll(".msg-tool")].some((e) => /Looked at the page/.test(e.textContent) && e.querySelector("img.shot")?.naturalWidth > 0)`
    ),
    "view_page answered a picture of the page",
    await a.eval(`[...document.querySelectorAll(".msg-tool")].map((e) => e.textContent).join(" | ")`)
  );
  await until(async () => (await b.textOf("h1")).includes("by agent"), 5000, "Bo's page shows the agent's edit");
  expect(!(await b.eval<boolean>(`[...document.querySelectorAll(".msg-user, .msg-assistant")].length > 0`)), "Bo's panel shows none of it");
  await until(async () => b.eval<boolean>(`[...document.querySelectorAll(":is(#people, #me) .agent-badge")].some((e) => /Ada, via their agent/.test(e.dataset.tip))`), 5000, "the agent's badge shows on Bo's page");
  const idle = async () => !(await peerNames(b)).includes("Ada, via their agent");
  // (Its tools run in the document's host as Ada's agent, which counts it as working until 8 s after its last call:
  // agents/document/session.ts, IDLE_MS.)
  await until(idle, 12_000, "and no caret of its own once it's idle", async () => peerNames(b));
  noErrors(a, "Ada"); noErrors(b, "Bo");
});

/**
 * Bo's page while the agent edits, at each frame and at each change of the page (a busy machine paints few frames): the
 * agent's caret (its name, and where it is in the new paragraph's text), the heading, the new paragraph's text in the
 * page, and how much of it hasn't played yet (the transparent highlight erga-unshown: libs/text/ui/marks.ts).
 */
const RECORD = `(() => {
  const F = document, seen = window.__seen = [];
  const look = () => {
    const c = F.querySelector("erga-peer[data-agent]");
    const news = F.querySelector("p.news");
    const hidden = [...(CSS.highlights.get("erga-unshown") ?? [])].reduce((n, r) => n + r.toString().length, 0);
    if (c || news) seen.push({ name: c ? c.textContent : "", h1: F.querySelector("h1")?.textContent ?? "", t: performance.now(), news: news ? news.textContent : null, tags: news ? news.querySelectorAll("a, b, i").length : 0, hidden });
  };
  const frame = () => { look(); requestAnimationFrame(frame); };
  frame();
  new MutationObserver(look).observe(F.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  return true;
})()`;

/** About 300 characters, with tags and an entity in them. */
const NEWS =
  '<p class="news">The <b>spring release</b> brings three things: faster pages, a new <a href="/docs">guide</a> for teams &amp; their agents, ' +
  "and <i>live</i> carets. Each of them took a season of work, and each shows on every page from today, for every reader and writer.</p>";

const AS_IT_HAPPENS =
  "others see the agent's edit land at once, and their page plays it as typing, with the agent's caret and no highlight";
browserTest(FILE, AS_IT_HAPPENS, { needs: ["scriptedAgent"] }, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada");
  const b = await openAs(tab, ctx, d, "Bo");
  await b.frame(RECORD);
  await watchMarks(b);
  await a.openAgent();
  const script = JSON.stringify([
    { tool: "edit", args: { path: d.path, edits: [{ oldText: "<h1>Launch notes", newText: "<h1>Release notes for the spring" }] } },
    {
      tool: "edit",
      args: { path: d.path, edits: [{ oldText: "<h2>What changed</h2>", newText: `${NEWS}\n\n    <h2>What changed</h2>` }] },
    },
    { text: "Renamed." },
  ]);
  const message = JSON.stringify(`Rename it @script ${script}`);
  await a.eval(`(() => { const i = document.getElementById("agent-input");
  i.value = ${message}; i.dispatchEvent(new Event("input")); })()`);
  await a.press("Enter");
  // Bo watches (a page in the background shows an agent's edit at once: nobody sees it play).
  await b.page.bringToFront();
  const done = () => a.eval<boolean>(`[...document.querySelectorAll(".msg-assistant")].some((e) => e.textContent == "Renamed.")`);
  await until(done, 10_000, "the agent is done");
  expect((await b.textOf("h1")).includes("Release notes for the spring"), "Bo's page shows the agent's edit");
  await until(async () => (await b.frame<{ hidden: number }[]>(`window.__seen`)).at(-1)?.hidden === 0, 5000, "the edit has played");
  type Seen = { name: string; h1: string; t: number; news: string | null; tags: number; hidden: number };
  const seen = await b.frame<Seen[]>(`window.__seen`);
  // The paragraph is in Bo's page whole from its first moment: the edit landed at once, in the room and the page.
  const news = seen.filter((s) => s.news != null);
  const saidNews = JSON.stringify(news.map((s) => [Math.round(s.t - news[0].t), s.news!.length, s.tags, s.hidden]).slice(0, 40));
  expect(
    news.length > 0 && news.every((s) => s.news == news[0].news && s.tags == 3),
    "the new paragraph is whole in the page at once",
    saidNews
  );
  // And plays as typing: what hasn't played yet shrinks, in steps, to nothing, in about half a second.
  const playing = news.filter((s) => s.hidden > 0);
  const steps = new Set(playing.map((s) => s.hidden)).size;
  expect(steps >= 5, `Bo saw it play in many steps (${steps})`, saidNews);
  const took = playing.length ? playing[playing.length - 1].t - news[0].t : 0;
  expect(took > 200 && took < 2500, `in about half a second (${Math.round(took)} ms)`, saidNews);
  expect(news[news.length - 1].hidden == 0, "and all of it shows at the end", saidNews);
  // With the agent's caret, its name on it, while it plays.
  expect(
    playing.some((s) => /Ada, via their agent/.test(s.name)),
    "the agent's caret plays it, with its name",
    saidNews
  );
  // Only the caret shows the edit: the text not typed yet is transparent (erga-unshown), and nothing marks it after.
  const marked = await seenMarks(b);
  expect(
    marked.every((m) => m == "highlight erga-unshown"),
    "nothing but the caret marks the agent's text",
    marked
  );
  expect((await marksNow(b)).length == 0, "and nothing marks it once it has played", await marksNow(b));
  const idle = async () => !(await peerNames(b)).includes("Ada, via their agent");
  await until(idle, 12_000, "the caret goes once the agent is idle", async () => peerNames(b));
  noErrors(a, "Ada");
  noErrors(b, "Bo");
});

browserTest(FILE, "a message that can't be sent says so and can be tried again", { needs: ["scriptedAgent"] }, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada");
  await a.openAgent();
  // The host refuses the agent's endpoint for a moment, with an error that isn't a redeploy's (a network error or a 502-504 is, and the message waits for the host: main.ts, ask).
  await a.eval(`window.__realFetch = window.fetch; window.fetch = (u, o) => String(u).includes("/api/agent?") && o?.method == "POST" ? Promise.resolve(new Response(JSON.stringify({ reason: "the host is down" }), { status: 500 })) : window.__realFetch(u, o)`);
  await a.eval(`(() => { const i = document.getElementById("agent-input"); i.value = "hello there"; i.dispatchEvent(new Event("input")); })()`);
  await a.press("Enter");
  await until(() => a.eval<boolean>(`!!document.querySelector("#agent-log .msg-user.failed .send-failed button")`), 5000, "the message is marked as not sent, with a retry");
  expect(/Not sent/.test(await a.eval<string>(`document.querySelector("#agent-log .msg-user.failed").textContent`)), "and says so");
  await a.eval(`window.fetch = window.__realFetch`);
  await a.eval(`document.querySelector("#agent-log .msg-user.failed .send-failed button").click()`);
  await until(() => a.eval<boolean>(`[...document.querySelectorAll("#agent-log .msg-user")].some((e) => e.textContent == "hello there" && !e.classList.contains("pending") && !e.classList.contains("failed"))`), 5000, "trying again sends it");
  expect(await a.eval<number>(`document.querySelectorAll("#agent-log .msg-user.failed").length`) == 0, "and the failed copy is gone");
});
