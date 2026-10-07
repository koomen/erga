// The multiplayer suite in real tabs (e2e/suite/suites/browser.ts): the agent panel is per person, view_page goes
// through its owner's tab, a message that can't be sent says so.
import { expect, until } from "./harness";
import { browserTest, noErrors, openAs, peerNames } from "./suite";

const FILE = "e2e/suite/browser-agent.e2e.ts";

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
  expect(!(await peerNames(b)).includes("Ada, via their agent"), "but no caret of its own on the page", await peerNames(b));
  noErrors(a, "Ada"); noErrors(b, "Bo");
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
