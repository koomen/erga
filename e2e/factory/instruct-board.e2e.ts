// Instructions sent to a task while it works, on the board (tests/factory-instruct.ts, 1): the stand-in gets them
// when its current command ends (none stopped), and works them into its change.
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

test.beforeAll(async () => { await servers.factory(); });

// A task, with a command of 15 s in it.
test("a working task's detail view takes instructions (empty ones refused); the log shows them; Claude Code gets them when its command ends, and the change has them", { timeout: TASK_MS + 30_000 }, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const a = await f.make("Note while it works", "Put a note on the front page. [factory-test: long command 15]");
  await f.until(a, "working", TASK_MS, (t) => t.log.some((l) => l.message.includes("The stand-in runs a long command")));
  // The old address of the board leads to it.
  expect((await fetch(`${s.root}/admin/source`, { redirect: "manual" })).headers.get("location")).toMatch(/\/admin\/factory$/);
  const b = await board(tab.page, s.root);
  await until(() => b.eval(`!!document.querySelector('[data-open="${a}"]')`), 5000, "the card");
  await b.click(`[data-open="${a}"]`);
  await until(() => b.eval(`!!document.getElementById("instructions")`), 5000, "a box for instructions");
  expect(await b.eval<string>(`document.getElementById("dlg").innerText`)).toContain("when its current step ends");
  expect((await f.api(`/tasks/${a}/revise`, { json: { instructions: " " } })).status).toBe(409);
  await b.fill("#instructions", "Make it blue.");
  await b.click('[data-act="revise"]');
  await expect.poll(() => b.eval<string>(`document.getElementById("revise-why")?.textContent || ""`)).toMatch(/^Sent/);
  const t = await f.task(a) as any;
  expect([t.status, t.waiting]).toEqual(["working", 1]);
  expect(await f.logged(a, "tester asked, while it works: Make it blue.")).toBe(true);
  await expect.poll(() => b.eval<string>(`document.getElementById("dlg").innerText`)).toContain("1 instruction waits");
  await f.until(a, "complete");
  const done = await f.task(a) as any, msgs = done.log.map((l: { message: string }) => l.message) as string[];
  expect(msgs.some((m) => /Claude Code got the instructions from tester after a step \(Bash\)/.test(m))).toBe(true);
  expect(msgs.some((m) => m.includes("The stand-in got the instructions: Make it blue."))).toBe(true);
  expect(msgs.some((m) => m.includes("stopped, so they reach"))).toBe(false);
  expect(msgs.some((m) => m.includes("sleep 15: 0"))).toBe(true);
  expect(done.waiting).toBeFalsy();
  const note = await (await fetch(done.url.replace("//localhost:", "//127.0.0.1:"))).text();
  expect(note).toContain("instructed task #");
  expect(note).toContain("asked while it worked: Make it blue.");
});
