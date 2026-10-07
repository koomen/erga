// The Source pane with main at staging ("The Source page"): one list of staging's commits with one dot
// column and no header, nothing to merge so no Merge button and no space for it, a plain page, the deploy columns with
// what each target has live; on a phone too. Admins only; /source redirects here.
import { expect, servers, test } from "../fixtures";
import { openSource, sourceState } from "./source-page";
import { admin, DEPLOY_MS, level, signIn } from "./staging";

await servers.staging();

test("the Source pane is for admins only; /source redirects to /admin/factory", async () => {
  const s = await servers.staging();
  expect((await fetch(`${s.root}/admin/factory`, { headers: { Cookie: await signIn(s.root, `bo${crypto.randomUUID().slice(0, 8)}`) }, redirect: "manual" })).status).toBe(403);
  const r = await fetch(`${s.root}/source`, { redirect: "manual" });
  expect([r.status, r.headers.get("location")]).toEqual([302, "/admin/factory"]);
});

test("main at staging: one list, newest first, one dot column; no Merge, no count and no space for them; plain; each column marks its live commit", { timeout: 2 * DEPLOY_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.staging(), a = await admin(s), page = tab.page;
  const { head } = await level(s, a, "At staging");
  tab.strict = true;
  await openSource(page, s.root);
  const st = await sourceState(page);
  expect(st.rows[0]).toMatchObject({ sha: head, subject: "At staging" });
  expect(st.rows.every((r) => r.kind.includes("on-main"))).toBe(true);
  expect(st.title).toMatch(/^Factory/);
  expect([st.merge, st.mergeShown, st.ahead]).toEqual([false, false, ""]);
  expect(st.headGap).toBeLessThan(1);
  expect([st.heads[0], st.heads[1], st.dots]).toEqual(["", "Commit", 1]);
  const plain = await page.evaluate(() => ({ notes: document.querySelectorAll(".pane-head .sub, .pane-note").length,
    extra: document.querySelectorAll("#grid .older, #moves, .site-foot").length, clone: !!document.getElementById("clone-copy"), heading: document.querySelector("#source-pane .pane-head h2")?.textContent ?? "" }));
  expect(plain, "no notes, summary lines, footer or Clone button; the heading says git log").toEqual({ notes: 0, extra: 0, clone: false, heading: "git log" });
  expect(await page.evaluate(() => [document.querySelector(".crumbs .brand")?.textContent, document.querySelector(".crumbs .here")?.textContent, !!document.querySelector("[data-erga-account]")])).toEqual(["Erga", "Factory", true]);
  expect(st.targets[0]).toMatch(/^staging.*live/);
  expect(st.targets[1]).toMatch(/^production/);
  expect(st.rows[0].live).toEqual(["live", "live"]);
});

test("main at staging, on a phone: no count, no button and no space for them", { timeout: 2 * DEPLOY_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.staging(), a = await admin(s), page = tab.page;
  await level(s, a, "At staging, phone");
  await openSource(page, s.root, { width: 390, height: 844 });
  await page.evaluate(() => (document.querySelector(".tabs [data-tab=source]") as HTMLElement).click());
  const st = await sourceState(page);
  expect([st.mergeShown, st.ahead]).toEqual([false, ""]);
  expect(st.headGap).toBeLessThan(1);
  expect(await page.evaluate(() => document.getElementById("merge-row")!.getBoundingClientRect().height)).toBe(0);
});
