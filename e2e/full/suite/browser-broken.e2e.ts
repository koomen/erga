// The multiplayer suite in real tabs (e2e/suite/suites/browser.ts): a paragraph broken by bad markup explains
// itself, and its button asks the agent to fix it. (How soon the prompt shows is a bench: browser-broken.bench.e2e.ts.)
import { expect, until } from "./harness";
import { browserTest, noErrors, openAs } from "./suite";

browserTest("e2e/full/suite/browser-broken.e2e.ts", "a paragraph broken by bad markup explains itself and the button asks the agent to fix it", { needs: ["scriptedAgent"] }, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada");
  await a.openAgent();
  await a.eval(`document.getElementById("agent-close").click()`);
  const s = (await d.stored(d.path))!;
  const broken = s.text.replace("Where the leads go.", "Where the</h2> leads go.");
  expect(broken != s.text, "the fixture has the sentence");
  expect((await d.push(d.path, broken, s.etag)).ok, "the broken markup is published");
  await until(() => a.frame<boolean>(`!!${a.F}.querySelector("figcaption.erga-locked")`), 5000, "the paragraph locks");
  const r = await a.rectOf("figcaption", 0.2);
  await a.click(r.x, r.y);
  await until(() => a.eval<boolean>(`!!document.querySelector("#toast.show .toast-fix")`), 5000, "the note offers a fix");
  const note = await a.eval<string>(`document.querySelector("#toast .toast-text").textContent`);
  expect(/stray <\/h2>/.test(note) && !/HTML view|⌘⇧P/.test(note), "it names the stray tag and doesn't send you to the HTML", note);
  expect(!(await a.eval<boolean>(`document.body.classList.contains("agent-open")`)), "the agent panel is closed");
  // Watch the note frame by frame as it goes: it fades as it is, nothing jumps.
  await a.eval(`window.__frames = []; (function tick(n) { const t = document.getElementById("toast"); const r = t.getBoundingClientRect(); __frames.push({ op: +getComputedStyle(t).opacity, btn: !!t.querySelector(".toast-fix"), w: Math.round(r.width), h: Math.round(r.height) }); if (n < 40) requestAnimationFrame(() => tick(n + 1)); })(0)`);
  await a.eval(`document.querySelector("#toast .toast-fix").click()`);
  await until(() => a.eval<boolean>(`document.body.classList.contains("agent-open")`), 5000, "the agent panel opens");
  await until(() => a.eval<boolean>(`[...document.querySelectorAll("#agent-log .msg-user")].some((e) => e.textContent.includes("stray </h2>"))`), 5000, "the prompt shows in the panel");
  await until(async () => {
    const log = (await (await d.fetch("/api/agent?user=Ada", {}, "Ada")).json()) as { log: { items: { kind: string; text?: string }[] } };
    return log.log.items.some((i) => i.kind == "user" && /stray <\/h2>/.test(i.text ?? "") && /Where the leads go/.test(i.text ?? "") && /line \d+/.test(i.text ?? ""));
  }, 5000, "Ada's agent gets a prompt naming the problem, the paragraph and its line");
  await until(() => a.eval<boolean>(`!!document.querySelector("#agent-log .msg-assistant") && !document.querySelector("#agent-log .msg-user.pending")`), 5000, "and its answer streams into the panel, like any message");
  // The 41 frames sampled are done (a frame each, so a second or less, unless the tab is in the background).
  await until(() => a.eval<boolean>(`__frames.length > 40`), 5000, "the note's frames are in");
  const frames = await a.eval<{ op: number; btn: boolean; w: number; h: number }[]>(`__frames`);
  const visible = frames.filter((f) => f.op > 0.01);
  expect(visible.every((f) => f.btn && f.w == visible[0].w && f.h == visible[0].h), "the note keeps its shape and button until it has faded", frames);
  noErrors(a, "Ada");
});
