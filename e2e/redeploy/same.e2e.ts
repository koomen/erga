// Open pages across a redeploy (tests/redeploy.ts, (a)): the server restarts with the same client files. No page
// reloads, each one reconnects, nothing shows an error, and an edit typed in the editor while the server was down
// reaches the server once it's back.
import { expect, test, until, withoutOutage } from "../fixtures";
import { checked, openPages } from "./pages";

// Its own server, started and restarted (a few seconds each, more on a busy machine), and three pages to set up.
test("a restart with the same client files: every page reconnects and none reloads; an edit made while the server was down reaches it", { timeout: 60_000 }, async ({ tab }) => {
  tab.strict = true;
  const s = await tab.own();
  const p = await openPages(tab, s);
  const { ed, fa } = p;
  await p.mark();

  await s.halt();
  // Typed while the server is down: it waits in the tab.
  await until(() => ed.eval<boolean>("!ergaPage.collab.provider.wsconnected"), 5000, "the editor notices the server is gone");
  await ed.type(" Typed while down.");
  await s.start();
  const since = p.counts();
  await p.edReady(20_000);
  await until(() => ed.eval<boolean>(`ergaPage.collab.provider.wsconnected && ergaPage.collab.provider.synced`), 20_000, "the editor's room is synced again");
  await until(() => p.doc.disk().includes("Typed while down."), 20_000, "the edit made while the server was down reaches the server (and the file on disk)");
  await until(() => fa.page.evaluate(`document.getElementById("live").textContent == "live"`), 20_000, "the board's live updates are back");
  // Every page has asked the new server about its code, and found nothing to reload for.
  await checked(p.all, since, 2);
  expect(p.all.map((x) => x.stale)).toEqual([0, 0, 0]);
  expect(await p.kept()).toEqual({ editor: true, factory: true, docs: true });
  expect(await ed.eval<boolean>(`document.getElementById("status").classList.contains("error")`)).toBe(false);
  await until(async () => !(await Promise.all(p.all.map((x) => x.page.evaluate(`!!document.querySelector(".erga-live-note")`)))).some(Boolean), 10_000, "no page still says it's reconnecting");
  expect(await fa.page.evaluate(`document.getElementById("dlg").open && window.ergaBoard.openTask() == 2`)).toBe(true);
  expect(await ed.eval<string>(`document.getElementById("agent-input").value`)).toBe("Make the title bigger");
  expect(await ed.eval<number>(`document.querySelectorAll(".agent-attachments .file-chip").length`)).toBe(1);
  for (const x of p.all) expect(withoutOutage(x.errors)).toEqual([]);
});
