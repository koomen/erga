// The multiplayer suite in real tabs: the agent panel is per person, view_page goes
// through its owner's tab, others see its edits as they happen, a message that can't be sent says so.
import { expect, until } from "./harness";
import { browserTest, noErrors, openAs, peerNames } from "./suite";

const FILE = "e2e/full/suite/browser-agent.e2e.ts";

browserTest(FILE, "the agent panel is per person, and the agent sees the page through its owner's tab", { needs: ["scriptedAgent"] }, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada"), b = await openAs(tab, ctx, d, "Bo");
  await a.openAgent();
  const script = JSON.stringify([{ tool: "edit", args: { path: d.path, edits: [{ oldText: "<h1>Launch notes", newText: "<h1>Launch notes by agent" }] } }, { tool: "view_page", args: { selector: "h1" } }, { text: "Looked." }]);
  await a.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify("Check it @script " + script)}; i.dispatchEvent(new Event("input")); })()`);
  await a.press("Enter");
  await until(async () => a.eval<boolean>(`[...document.querySelectorAll(".msg-assistant")].some((e) => e.textContent == "Looked.")`), 10_000, "Ada's panel shows the reply");
  expect(await a.eval<boolean>(`[...document.querySelectorAll(".msg-tool")].some((e) => /Looked at the page/.test(e.textContent) && e.querySelector("img.shot")?.naturalWidth > 0)`), "view_page captured the page in Ada's tab", await a.eval(`[...document.querySelectorAll(".msg-tool")].map((e) => e.textContent).join(" | ")`));
  await until(async () => (await b.textOf("h1")).includes("by agent"), 5000, "Bo's page shows the agent's edit");
  expect(!(await b.eval<boolean>(`[...document.querySelectorAll(".msg-user, .msg-assistant")].length > 0`)), "Bo's panel shows none of it");
  await until(async () => b.eval<boolean>(`[...document.querySelectorAll(":is(#people, #me) .agent-badge")].some((e) => /Ada, via their agent/.test(e.dataset.tip))`), 5000, "the agent's badge shows on Bo's page");
  const idle = async () => !(await peerNames(b)).includes("Ada, via their agent");
  await until(idle, 5000, "and no caret of its own once it's idle", async () => peerNames(b));
  noErrors(a, "Ada"); noErrors(b, "Bo");
});

/** Each frame on Bo's page while the agent edits: its selection boxes, its caret's name and whether it's in the first paragraph, the heading. */
const RECORD = `(() => {
  const F = document, seen = window.__seen = [];
  const look = () => {
    const c = F.querySelector("erga-peer[data-agent]"), p = F.querySelector("p.lede")?.getBoundingClientRect();
    if (c) {
      const y = parseFloat(c.style.top) - scrollY;
      seen.push({ sel: F.querySelectorAll("erga-peer-sel").length, name: c.textContent, h1: F.querySelector("h1")?.textContent ?? "", inP: !!p && y >= p.top - 2 && y < p.bottom });
    }
    requestAnimationFrame(look);
  };
  look();
  return true;
})()`;

const AS_IT_HAPPENS = "others see the agent's edit as it happens: its selection on the old text, then its caret as the new text types in";
browserTest(FILE, AS_IT_HAPPENS, { needs: ["scriptedAgent"] }, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada");
  const b = await openAs(tab, ctx, d, "Bo");
  await b.frame(RECORD);
  await a.openAgent();
  const script = JSON.stringify([
    { tool: "edit", args: { path: d.path, edits: [{ oldText: "<h1>Launch notes", newText: "<h1>Release notes for the spring" }] } },
    { tool: "edit", args: { path: d.path, edits: [{ oldText: '<p class="lede">', newText: '<p class="lede big">' }] } },
    { text: "Renamed." },
  ]);
  const message = JSON.stringify(`Rename it @script ${script}`);
  await a.eval(`(() => { const i = document.getElementById("agent-input");
  i.value = ${message}; i.dispatchEvent(new Event("input")); })()`);
  await a.press("Enter");
  const done = () => a.eval<boolean>(`[...document.querySelectorAll(".msg-assistant")].some((e) => e.textContent == "Renamed.")`);
  await until(done, 10_000, "the agent is done");
  expect((await b.textOf("h1")).includes("Release notes for the spring"), "Bo's page shows the agent's edit");
  type Seen = { sel: number; name: string; h1: string; inP: boolean };
  const seen = await b.frame<Seen[]>(`window.__seen`);
  const said = JSON.stringify(seen.slice(0, 40));
  const selected = seen.some((s) => s.sel > 0 && s.h1.includes("Launch notes") && /Ada, via their agent/.test(s.name));
  expect(selected, "Bo saw the agent's selection on the old heading, with its name", said);
  const typing = new Set(seen.filter((s) => s.sel == 0 && !s.h1.includes("Launch")).map((s) => s.h1));
  expect(typing.size >= 3, "and its caret as the new text came in, in a few steps", said);
  const inP = seen.some((s) => s.inP);
  expect(inP, "an edit in a tag puts the caret at the text of its paragraph", said);
  const idle = async () => !(await peerNames(b)).includes("Ada, via their agent");
  await until(idle, 10_000, "the caret goes once the agent is idle", async () => peerNames(b));
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
