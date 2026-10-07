// One page, /admin/factory: the board, the source dashboard and the agent.
import { expect, test, until } from "../fixtures";
import { board, servers } from "./factory";

await servers.factory();

test("/admin/source, /source and /admin/deploys redirect to /admin/factory", async () => {
  const s = await servers.factory();
  for (const old of ["/admin/source", "/source", "/admin/deploys"]) {
    const r = await fetch(`${s.root}${old}`, { redirect: "manual" });
    expect(r.status, old).toBe(302);
    expect(r.headers.get("location"), old).toBe("/admin/factory");
  }
});

test("on a wide window, with the admin sidebar collapsed: the agent on the left, the board above the dashboard beside it, the board's four columns kept", async ({ tab }) => {
  const s = await servers.factory();
  await tab.page.addInitScript(() => { try { localStorage.setItem("erga:admin-sidebar", "closed"); } catch { /* none */ } });
  const b = await board(tab.page, s.root);
  await until(() => b.eval(`!!document.querySelector('#tasks [data-col="queued"]') && !!document.querySelector("#source-pane .pane-head") && !!document.querySelector("#agent .agent-log")`), 10_000, "the board, the dashboard and the agent, on one page");
  const box = (sel: string) => b.eval<{ left: number; right: number; top: number; bottom: number; width: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; })()`);
  const [agent, tasks, source] = [await box("#agent"), await box("#tasks"), await box("#source-pane")];
  expect(agent.right).toBeLessThanOrEqual(tasks.left);
  expect(tasks.bottom).toBeLessThanOrEqual(source.top);
  expect(agent.width).toBeGreaterThanOrEqual(300);
  expect(agent.bottom).toBeLessThanOrEqual(900);
  expect(await b.eval<number>(`getComputedStyle(document.querySelector("#tasks .board")).gridTemplateColumns.split(" ").length`)).toBe(4);
});

test("on a phone: one pane at a time, the board first, no sideways scrolling; the agent's round button opens it over the board, fitting the screen; the Source tab shows the dashboard", async ({ tab }) => {
  const s = await servers.factory();
  const b = await board(tab.page, s.root, { width: 390, height: 844 });
  const shown = () => b.eval<string[]>(`["#tasks", "#source-pane", "#agent"].filter((s) => { const e = document.querySelector(s); return e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility != "hidden"; })`);
  await expect.poll(shown).toEqual(["#tasks"]);
  expect(await b.eval<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await b.click("#agent-fab");
  await expect.poll(shown).toEqual(["#tasks", "#agent"]);
  const fit = await b.eval<{ bottom: number; input: number }>(`(() => ({ bottom: document.getElementById("agent").getBoundingClientRect().bottom, input: document.getElementById("agent-input").getBoundingClientRect().bottom }))()`);
  expect(fit.bottom).toBeLessThanOrEqual(844);
  expect(fit.input).toBeLessThanOrEqual(844);
  await b.click("#agent-close");
  await expect.poll(shown).toEqual(["#tasks"]);
  await b.click('.tabs [data-tab="source"]');
  await expect.poll(shown).toEqual(["#source-pane"]);
  expect(await b.eval<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
});
