// A merge that conflicts: needs agent, and the task's own Claude Code (the stand-in, fake-claude.ts) resolves it (tests/factory.ts, 12).
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

await servers.factory();

// Two tasks done, a merge, then a merge that waits for its stand-in to resolve the conflict (8 s by its script).
test("a conflict with staging: needs agent (Merge and instructions refused, the reason on the card and in the detail, the preview stopped); the agent panel reads it; the same VM's stand-in resolves it and the merge goes on to merged", { timeout: 3 * TASK_MS }, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  // B is made from the staging before A merges: both put a note under the heading, so merging staging into B conflicts.
  const a = await f.make("Note A");
  const b = await f.make("Note B, in conflict", "Another note on the front page. [factory-test: resolve after 8]");
  await f.until([a, b], "complete");
  expect((await f.api(`/tasks/${a}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(a, "merged");
  const preview = (await f.task(b)).url.replace("//localhost:", "//127.0.0.1:");
  expect((await fetch(preview).catch(() => null))?.ok).toBe(true);
  const page = await board(tab.page, s.root);
  await until(() => page.eval(`!!document.querySelector('[data-col="ready-to-merge"] [data-open="${b}"] [data-act="merge"]')`), 10_000, "B's Merge button");
  await page.click(`[data-col="ready-to-merge"] [data-open="${b}"] [data-act="merge"]`);
  await f.until(b, "needs agent");
  const nb = await f.task(b);
  expect(nb.error).toContain("The branch conflicts with staging in landing/index.html");
  expect(nb.url).toBeFalsy();
  expect(await fetch(preview, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false)).toBe(false);
  expect((await f.api(`/tasks/${b}/merge`, { method: "POST" })).status).toBe(409);
  expect((await f.api(`/tasks/${b}/revise`, { json: { instructions: "x" } })).status).toBe(409);
  const card = `[data-col="merging"] [data-open="${b}"]`;
  await expect.poll(() => page.eval<boolean>(`(() => { const c = document.querySelector(${JSON.stringify(card)}); return !!c && !c.querySelector("[data-btn=merge]") && c.classList.contains("needs-agent") && c.innerText.toLowerCase().includes("needs agent") && c.innerText.includes("conflicts with staging in landing/index.html"); })()`)).toBe(true);
  await page.click(`[data-open="${b}"]`);
  await expect.poll(() => page.eval<boolean>(`document.getElementById("dlg").open && document.querySelector("#dlg .status.needs-agent")?.textContent == "needs agent"`)).toBe(true);
  await page.click('[data-act="close"]');
  // The agent panel's tools see it too (list_tasks with the status).
  await until(async () => (await page.eval<string>(`document.getElementById("agent-model").textContent`)).includes("script"), 10_000, "the agent panel connects");
  await page.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify("What needs its agent? @script " + JSON.stringify([{ tool: "list_tasks", args: { status: "needs agent" } }, { tool: "get_task", args: { id: b, log: 5 } }, { text: `#${b} needs its agent.` }]))}; i.dispatchEvent(new Event("input")); document.getElementById("agent-send").click(); return true; })()`);
  await expect.poll(() => page.eval<string>(`[...document.querySelectorAll("#agent-log .msg-assistant")].map((e) => e.innerText).join(" | ")`), { timeout: 15_000 }).toContain(`#${b} needs its agent.`);
  expect(await page.eval<string>(`document.getElementById("agent-log").innerText`)).not.toMatch(/(list_tasks|get_task) failed/);
  await f.until(b, "merged");
  const done = await f.task(b);
  const msgs = done.log.map((l) => l.message);
  expect(msgs.some((m) => m.startsWith("Claude Code is woken to finish the merge"))).toBe(true);
  expect(msgs.some((m) => m.startsWith("Resolved the conflicts in landing/index.html"))).toBe(true);
  expect(msgs).toContain("The merge goes on");
  expect(msgs.filter((m) => /^VM \S+ started/.test(m)).length).toBe(1);
  const html = f.git("show", "staging:landing/index.html");
  expect(html).toContain(`task #${a}: Note A`);
  expect(html).toContain(`task #${b}: Note B, in conflict`);
  expect(html).not.toContain("<<<<<<<");
  expect(f.branches().staging).toBe(done.mergeCommit);
  expect(f.branches()[done.branch]).toBeUndefined();
});
