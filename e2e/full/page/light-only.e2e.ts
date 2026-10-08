// No dark mode, and a coloured page's background from the first frame ("System in dark mode", "Reload with a coloured page").
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, settle, test } from "../../fixtures";
import { F, openEditor } from "../../editor";

await servers.main();

test("with the system in dark mode, the Markdown page and the shell stay light, and there is no theme toggle", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await tab.page.emulateMedia({ colorScheme: "dark" });
  await settle(tab.page);
  await settle(tab.page);
  expect(await ed.frame<string>(`getComputedStyle(${F}.body).backgroundColor`)).toBe("rgb(255, 255, 255)");
  expect(await ed.eval<string>(`getComputedStyle(document.documentElement).backgroundColor`)).toBe("rgb(255, 255, 255)");
  expect(await ed.eval<boolean>(`!!document.getElementById("btn-theme")`)).toBe(false);
});

test("after a reload, the canvas behind a coloured page is that colour from the start, not white", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  writeFileSync(join(ed.dir, "style.css"), readFileSync(join(ed.dir, "style.css"), "utf8") + "\nbody { background: rgb(243, 236, 220); }\n");
  await expect.poll(() => ed.eval<string>(`getComputedStyle(document.documentElement).backgroundColor`)).toBe("rgb(243, 236, 220)");
  // The colour the moment the shell's frame first exists, before the page in it has loaded: recorded by the new document itself.
  await tab.page.addInitScript(() => {
    if (window.top != window) return;
    new MutationObserver((_, o) => {
      if (!document.getElementById("frame")) return;
      (window as any).__firstBackground = getComputedStyle(document.documentElement).backgroundColor;
      o.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await tab.page.reload();
  await expect.poll(() => ed.eval<string | null>(`window.__firstBackground ?? null`)).toBe("rgb(243, 236, 220)");
});
