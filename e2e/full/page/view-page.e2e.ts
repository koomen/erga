// view_page's capture, as the user sees the page: it waits for the fonts and
// draws them (not a fallback), and says which fonts rendered, at what size and in which mode, as the agent's context
// does. Other sizes and modes: view-page-modes.e2e.ts.
import { expect, servers, test } from "../../fixtures";
import { capture, CAPTURES, differ, expectColour, fontSite, openFonts as open, SCRIPT_LIGHT, SLOW_MS, WHITE } from "./view-page";

await servers.script();
test.beforeAll(async () => { await fontSite(); });

test("the whole screenful, at the user's window size and in their mode (light); it waits for the slow web font and says which fonts rendered, where, and which fell back; the page's CSS and script both see light mode", async ({ tab }) => {
  const ed = await open(tab);
  const t0 = Date.now();
  const all = await capture(ed, {});
  const took = Date.now() - t0;
  const size = await ed.eval<{ width: number; height: number }>(`(() => { const f = document.getElementById("frame"); return { width: f.clientWidth, height: f.clientHeight }; })()`);
  expect(all.error).toBeUndefined();
  expect(all.png).toBeTruthy();
  expect({ viewport: all.viewport, width: all.width, height: all.height }).toEqual({ viewport: size, ...size });
  expect(all.colorScheme).toBe("light");
  // It waited for the font (no condition to wait on here: the time it took is what says so), and nothing was left loading.
  expect(took).toBeGreaterThan(SLOW_MS - 50);
  expect(all.pending ?? []).toEqual([]);
  const font = (family: string) => all.fonts?.find((f) => f.family == family && !f.wanted);
  expect(font("Testface")?.tags, JSON.stringify(all.fonts)).toContain("h1");
  expect(font("Localface")?.tags, JSON.stringify(all.fonts)).toContain("h2");
  const missed = all.fonts?.find((f) => f.wanted == "Missingface");
  expect(missed?.family, JSON.stringify(all.fonts)).not.toBe("Missingface");
  expect(missed?.tags).toContain("p");
  await expectColour(ed, all.png!, 600, 30, WHITE);
  await expectColour(ed, all.png!, all.width - 10, 10, SCRIPT_LIGHT);
});

test("the picture draws the other site's web font (the same as the document's own copy of it), not the fallback", CAPTURES, async ({ tab }) => {
  const ed = await open(tab);
  const [remote, local, fallback] = await Promise.all(["#remote", "#local", "#fallback"].map((s) => capture(ed, { selector: s })));
  const same = await differ(ed, remote.png!, local.png!), other = await differ(ed, remote.png!, fallback.png!);
  expect(same).toBeGreaterThanOrEqual(0);
  expect(same).toBeLessThan(20);
  expect(other).toBeGreaterThan(200);
});

test("the agent's context gives the user's window size and mode", async ({ tab }) => {
  const ed = await open(tab);
  const size = await ed.eval<{ width: number; height: number }>(`(() => { const f = document.getElementById("frame"); return { width: f.clientWidth, height: f.clientHeight }; })()`);
  const context = await ed.eval<string>(`ergaPage.agentContext()`);
  expect(context).toContain(`${size.width}×${size.height} CSS pixels`);
  expect(context).toContain("light mode");
});
