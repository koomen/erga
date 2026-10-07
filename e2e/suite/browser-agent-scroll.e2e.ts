// The multiplayer suite in real tabs (tests/suite/suites/browser.ts): the agent pane follows the agent's output
// until you scroll back, like a terminal.
import { settle } from "../fixtures";
import { expect, until } from "../../tests/suite/harness";
import { browserTest, noErrors, openAs } from "./suite";

// Three scripted runs of the agent, the first with a screenshot: 6 s on an idle Mac, inside a browser test's 30 s.
browserTest("e2e/suite/browser-agent-scroll.e2e.ts", "the agent pane follows the agent's output until you scroll back, like a terminal", { needs: ["scriptedAgent"] }, async (ctx, tab) => {
  const d = await ctx.doc();
  const a = await openAs(tab, ctx, d, "Ada");
  const p = a.page;
  await a.openAgent();
  await until(() => a.eval<boolean>(`document.body.classList.contains("agent-open") && !!document.getElementById("agent-model").textContent`), 5000, "the panel opens");
  const pane = () => a.eval<{ top: number; max: number; jump: boolean }>(`(() => { const l = document.getElementById("agent-log"); return { top: l.scrollTop, max: l.scrollHeight - l.clientHeight, jump: !document.getElementById("agent-jump").hidden }; })()`);
  const atBottom = async () => { const s = await pane(); return s.max - s.top <= 8; };
  const send = async (steps: unknown[]) => {
    await a.eval(`(() => { const i = document.getElementById("agent-input"); i.focus(); i.value = ${JSON.stringify("Go @script " + JSON.stringify(steps))}; i.dispatchEvent(new Event("input")); })()`);
    await a.press("Enter");
  };
  const busy = () => a.eval<boolean>(`document.getElementById("agent-send").classList.contains("stop")`);
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long answer.`).join("\n");
  // A long run: tool calls trickling in, a screenshot (which loads after its event), a long reply.
  const reads = Array.from({ length: 6 }, () => ({ tool: "read", args: { path: d.path }, delay: 120 }));
  await send([...reads, { tool: "view_page", args: {} }, { text: long, delay: 200 }]);
  await until(async () => !(await busy()) && await a.eval<boolean>(`!!document.querySelector(".msg-assistant")`), 20_000, "the run finishes");
  await settle(p);
  const s0 = await pane();
  expect(s0.max > 200, "the log overflows the pane", s0);
  await until(atBottom, 5000, "the pane followed the output to the end, screenshot and all", pane);

  // Scroll back to read while another run writes more: the pane stays where you put it.
  await send([...reads, { text: long }]);
  await until(busy, 5000, "the second run starts");
  const box = await a.eval<{ x: number; y: number }>(`(() => { const r = document.getElementById("agent-log").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await p.mouse.move(box.x, box.y);
  await p.mouse.wheel(0, -600);
  await until(async () => { const s = await pane(); return s.max - s.top > 100; }, 2000, "the wheel scrolls the log up");
  await settle(p);
  const reading = (await pane()).top;
  await until(async () => !(await busy()), 20_000, "the second run finishes");
  await settle(p);
  const s1 = await pane();
  expect(Math.abs(s1.top - reading) <= 2 && s1.max - s1.top > 100, "new output didn't pull you down", { reading, ...s1 });
  expect(s1.jump, "a 'Jump to latest' button offers the way back");
  await a.eval(`document.getElementById("agent-jump").click()`);
  await until(async () => await atBottom() && !(await pane()).jump, 5000, "jumping goes to the bottom and hides the button", pane);

  // Following again: the next run's output is followed; so is a new message sent while scrolled back.
  await p.mouse.wheel(0, -600);
  await settle(p);
  await send([{ text: long, delay: 150 }]);
  await until(async () => !(await busy()), 10_000, "the third run finishes");
  await settle(p);
  await until(atBottom, 5000, "sending a message brings the pane back to follow its answer", pane);
  noErrors(a, "Ada");
});
