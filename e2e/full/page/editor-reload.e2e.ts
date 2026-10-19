// A reload in the editor (by hand) opens as the editor was, from its first frame: its controls up (not the viewer's
// until the editor's code has come), the agent's pane open as it was, the document in its place beside it, and scrolled
// where it was, never shown at its top first (server/pages/viewer.ts, editingHead; main.ts, the "shell" it keeps).
import { expect, servers, test } from "../../fixtures";
import { F, openEditor } from "../../editor";

await servers.main();

test("a reload in the editor shows the editor, as it was, from its first frame", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "long", { agent: true });
  const page = tab.page;
  await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("agent-open")`)).toBe(true);
  await ed.frame(`${F}.scrollingElement.scrollTo(0, 900)`);
  await expect.poll(() => ed.eval<number>(`ergaPage.page.scrollY`)).toBe(900);
  const frameAt = () => ed.eval<number>(`document.getElementById("frame").getBoundingClientRect().left`);
  // (Once the pane has opened: the document moves aside as it does.)
  let left = -1;
  await expect.poll(async () => { const was = left; left = await frameAt(); await ed.settle(); return was == left && left > 100; }).toBe(true);

  // What each frame of the reloaded page shows, from its first: in the tab, the editor's controls or the viewer's, and
  // where the document's frame is; in the frame's host page, where the page it shows is scrolled, while it shows.
  await page.addInitScript(() => {
    const seen: unknown[] = (window as any).__seen = [];
    const top = window.top == window;
    // (The frame's host page is at /t/<token>/ on the document's origin; the editor's half runs in it too.)
    const host = !top && /\/t\/[^/]+\/$/.test(location.pathname);
    if (!top && !host) return;
    const tick = () => {
      if (top && document.body) {
        const wrap = document.getElementById("erga-editor"), viewer = document.querySelector(".erga-view-buttons");
        seen.push({
          editor: !!wrap && getComputedStyle(wrap).opacity == "1",
          viewer: !!viewer && getComputedStyle(viewer).visibility != "hidden" && getComputedStyle(viewer).opacity != "0",
          agent: document.body.classList.contains("agent-open"),
          left: document.getElementById("frame")?.getBoundingClientRect().left,
        });
      }
      if (host) {
        const f = document.querySelector<HTMLIFrameElement>("iframe.on");
        try {
          if (f && getComputedStyle(f).visibility == "visible" && f.contentDocument?.body?.childElementCount) seen.push({ y: f.contentWindow!.scrollY });
        } catch { /* not yet */ }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.reload();
  await ed.loaded();

  const shell = await ed.eval<{ editor: boolean; viewer: boolean; agent: boolean; left: number }[]>(`window.__seen`);
  expect(shell.length).toBeGreaterThan(0);
  // From the first frame: the editor's controls, never the viewer's; the pane open; the document where it was.
  expect(shell.filter((s) => !s.editor || s.viewer || !s.agent)).toEqual([]);
  // (Once the frame is on the page: before it, its place shows only the page's colour.)
  expect([...new Set(shell.filter((s) => s.left != null).map((s) => Math.round(s.left)))]).toEqual([Math.round(left)]);
  // The document: scrolled where it was in every frame it shows, and still there.
  const host = await ed.frame<{ y: number }[]>(`window.__seen`);
  expect(host.length).toBeGreaterThan(0);
  expect(host.filter((s) => Math.abs(s.y - 900) > 2)).toEqual([]);
  expect(await ed.frame<number>(`${F}.scrollingElement.scrollTop`)).toBe(900);
  expect(await frameAt()).toBe(left);
});
