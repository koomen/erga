// Dependencies on the board: added in a task's detail, and asked for by the New task form.
import { expect, test, until } from "../fixtures";
import { board, factory, servers } from "./factory";

await servers.factory();

test("a dependency added in a task's detail (merges after another), and the detail lists it", async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const first = await f.make("Merge me first");
  const id = await f.make("Merge me after");
  const b = await board(tab.page, s.root);
  await until(() => b.eval(`!!document.querySelector('[data-open="${id}"]')`), 10_000, "the card");
  await b.click(`[data-open="${id}"]`);
  await until(() => b.eval(`!!document.getElementById("dep-kind")`), 5000, "the Dependencies section, with Add");
  await b.eval(`(() => { document.getElementById("dep-kind").value = "mergeAfter"; document.getElementById("dep-id").value = "${first}"; return true; })()`);
  await b.click('#dlg [data-act="dep"]');
  await expect.poll(async () => (await f.task(id)).mergeAfter).toEqual([first]);
  await expect.poll(() => b.eval<string>(`document.getElementById("dlg").innerText`)).toContain("Merges after");
});

test("a task that starts after another, from the board's form: queued with no VM, Restart refused, and its card says what it waits for, with no Start", async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  // Waits for a task that never merges here.
  const before = await f.make("Never merged", "A note.");
  const b = await board(tab.page, s.root);
  const id = await f.nextId();
  await b.click("#new");
  await until(() => b.eval(`!!document.getElementById("t-start")`), 3000, "the form asks for dependencies");
  await b.fill("#t-title", "Follow the hello");
  await b.fill("#t-desc", `After #${before}: change the note again.`);
  await b.eval(`(() => { document.getElementById("t-start").value = "${before}"; return true; })()`);
  await b.click("#create");
  await expect.poll(() => f.status(id).catch(() => null)).toBe("queued");
  // Whether it may start is decided when it's added (blockedBy): no VM was started, or will be until #before merges.
  const t = await f.task(id);
  expect(t.startAfter).toEqual([before]);
  expect(t.blockedBy?.start).toEqual([before]);
  expect(t.blockedBy?.reason).toBe(`waiting for #${before} to merge`);
  expect(t.vm).toBeFalsy();
  expect(t.log.some((l) => l.message.includes("Starting a VM"))).toBe(false);
  expect(f.vmsOf(id)).toEqual([]);
  // There is no Start (a task starts by itself); Restart, on a task that never ran, starts it, and is refused the same way.
  const restart = await f.api(`/tasks/${id}/restart`, { method: "POST" });
  expect(restart.status).toBe(409);
  expect(restart.body.error).toContain(`can't start: waiting for #${before}`);
  expect(f.vmsOf(id)).toEqual([]);
  await expect.poll(() => b.eval<boolean>(`(() => { const c = document.querySelector('[data-col="queued"] [data-open="${id}"]'); return !!c && c.classList.contains("blocked") && c.querySelector(".m.waits")?.title == "Waiting for #${before} to merge" && !c.querySelector(".starting"); })()`)).toBe(true);
});
