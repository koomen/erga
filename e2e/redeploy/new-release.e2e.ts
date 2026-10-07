// Open pages across a redeploy ((b)): the server restarts with changed client files (page.js,
// factory-agent.js and live.js, in a copy of .site: ERGA_SITE_DIR). Every page reloads by itself, and the editor's
// caret, scroll, card, draft and file, the open task and the agent's draft on the Factory page are all back.
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, until, withoutOutage } from "../fixtures";
import { ROOT } from "../env";
import { checked, openPages } from "./pages";

// Its own server, started and restarted (a few seconds each, more on a busy machine), three pages to set up, and three to reload.
test("a restart with new client files: every page reloads by itself, with its state, and only once", { timeout: 60_000 }, async ({ tab }) => {
  tab.strict = true;
  const site = mkdtempSync(join(realpathSync(tmpdir()), "erga-redeploy-site-"));
  try {
    cpSync(join(ROOT, ".site"), site, { recursive: true });
    const s = await tab.own({ processEnv: { ERGA_SITE_DIR: site } });
    const p = await openPages(tab, s);
    const { ed, fa, dl } = p;
    await ed.type(" Typed before the release.");
    await until(() => p.doc.disk().includes("Typed before the release."), 10_000, "the edit is stored");
    // Back in the page, quiet, scrolled, the selection where the typing left it.
    await ed.frame(`document.getElementById("page").contentWindow.scrollTo(0, 1500)`);
    await until(async () => Math.abs((await ed.eval<number>(`ergaPage.page.scrollY`)) - 1500) < 3, 5000, "the page is scrolled");
    const scroll = await ed.eval<number>(`ergaPage.page.scrollY`);
    const sel = await p.selection();
    await p.mark();

    await s.halt();
    // A new release of three client files: page.js (the editor), factory-agent.js (every admin page), live.js (every page).
    const files = JSON.parse(readFileSync(join(site, "build.json"), "utf8")) as Record<string, string>;
    for (const f of ["page.js", "factory-agent.js", "live.js"]) {
      const fresh = (files[f].slice(0, 8) + "feedbeef").slice(0, 16);
      writeFileSync(join(site, f), readFileSync(join(site, f), "utf8").replace(`["${f}"]="${files[f]}"`, `["${f}"]="${fresh}"`) + "\n/* the next release */\n");
      files[f] = fresh;
    }
    writeFileSync(join(site, "build.json"), JSON.stringify(files));
    await s.start();

    await until(async () => Object.values(await p.kept()).every((v) => !v), 40_000, "every page reloads by itself", p.kept);
    await p.edReady(20_000);
    expect(await ed.eval<string>(`self.ergaBuilt["page.js"]`)).toBe(files["page.js"]);
    expect(await p.selection()).toEqual(sel);
    await until(async () => Math.abs((await ed.eval<number>(`ergaPage.page.scrollY`)) - scroll) < 4, 8000, "the page is scrolled where it was");
    await until(() => ed.eval<boolean>(`!document.getElementById("help").hidden`), 5000, "the help card is open again");
    await until(() => ed.eval<boolean>(`document.getElementById("agent-input").value == "Make the title bigger" && document.querySelectorAll(".agent-attachments .file-chip").length == 1`), 5000, "the agent's draft and its attached file are back");
    expect(p.doc.disk()).toContain("Typed before the release.");
    await until(() => fa.page.evaluate(`document.getElementById("dlg").open && window.ergaBoard?.openTask() == 2`), 10_000, "task 2's detail is open again on the Factory page");
    expect(await fa.page.evaluate(`document.getElementById("agent-input").value`) as string).toBe("What is task 2 doing?");
    expect(await dl.page.evaluate(`document.title`) as string).toMatch(/^Documents/);

    // And it settles: the reloaded pages check twice more, find nothing new, and stay.
    await p.mark();
    const stale = p.all.map((x) => x.stale);
    await checked(p.all, p.counts(), 2);
    expect(p.all.map((x) => x.stale)).toEqual(stale);
    expect(await p.kept()).toEqual({ editor: true, factory: true, docs: true });
    for (const x of p.all) expect(withoutOutage(x.errors)).toEqual([]);
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});
