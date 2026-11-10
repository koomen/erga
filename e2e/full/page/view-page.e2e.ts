// view_page, as an agent calls it: the server's browser renders the page in Erga's viewer, as its person sees it. It
// waits for the fonts and draws them (not a fallback), and says which fonts rendered, at what size and in which mode.
// Several places in one call: one picture each. Other sizes and modes: view-page-modes.e2e.ts.
import { expect, beforeTests, test } from "../../helpers/fixtures";
import { CAPTURES, differ, expectColour, fontSite, fontsServer, openFonts as open, SCRIPT_LIGHT, SLOW_MS, WHITE } from "./view-page";

await beforeTests(fontsServer);

test(
  "the whole screenful, 1280×800 in light mode by default; it waits for the slow web font and says which fonts rendered, where, and which fell back; the page's CSS and script both see light mode",
  CAPTURES,
  async ({ tab }) => {
    const { ed, tool } = await open(tab);
    const t0 = Date.now();
    const all = await tool("view_page", {});
    const took = Date.now() - t0;
    expect(all.images).toHaveLength(1);
    expect(all.text).toContain("Screenshot: 1280×800px, top of the page, of index.html.");
    expect(all.text).toContain("Rendered in a 1280×800px window, in light mode.");
    // It waited for the font (no condition to wait on here: the time it took is what says so), and nothing was left loading.
    expect(took).toBeGreaterThan(SLOW_MS - 50);
    expect(all.text).not.toContain("Still loading");
    expect(all.text).toMatch(/^- Testface: 1 element \(h1\)$/m);
    expect(all.text).toMatch(/^- Localface: 1 element \(h2\)$/m);
    expect(all.text).toMatch(/\(the page asked for Missingface, which didn't load or isn't installed\): 1 element \(p\)/);
    await expectColour(ed, all.images[0], 600, 30, WHITE);
    await expectColour(ed, all.images[0], 1277, 3, SCRIPT_LIGHT);
  }
);

test(
  "a list of selectors gives one picture each, from one render: the other site's web font draws the same as the document's own copy of it, not the fallback",
  CAPTURES,
  async ({ tab }) => {
    const { ed, tool, fails } = await open(tab);
    const v = await tool("view_page", { selector: ["#remote", "#local", "#fallback"] });
    expect(v.images).toHaveLength(3);
    expect(v.text).toMatch(/^#remote, at \d+ ms:$/m);
    expect(v.text).toContain("Screenshots (3) of index.html: #remote, at");
    const [remote, local, fallback] = v.images;
    const same = await differ(ed, remote, local),
      other = await differ(ed, remote, fallback);
    expect(same).toBeGreaterThanOrEqual(0);
    expect(same).toBeLessThan(20);
    expect(other).toBeGreaterThan(200);
    expect(await fails("view_page", { selector: ["#remote", "#nope"] })).toMatch(/Nothing on the page matches #nope/);
    expect(await fails("view_page", { selector: ["h1", "h2", "h3", "p"], frames: [0, 100] })).toMatch(
      /8 pictures: one call takes at most 6/
    );
  }
);

test("the agent's context gives the user's window size and mode", async ({ tab }) => {
  const { ed } = await open(tab);
  const size = await ed.eval<{ width: number; height: number }>(
    `(() => { const f = document.getElementById("frame"); return { width: f.clientWidth, height: f.clientHeight }; })()`
  );
  const context = await ed.eval<string>(`ergaPage.agentContext()`);
  expect(context).toContain(`${size.width}×${size.height} CSS pixels`);
  expect(context).toContain("light mode");
});
