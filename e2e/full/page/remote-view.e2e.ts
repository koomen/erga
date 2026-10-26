// Edits from elsewhere (the agent, another tab, the disk) while you read or type in another part of the page, as in a
// shared document: only what changed changes. The view doesn't move, however much changes above it; the page isn't
// loaded again, so its scripts keep their state; the caret stays where you type. Only a change to a script makes the
// page afresh: it loads again, and opens at the same spot (client/page-editor/editor.ts, restoreView; morph.ts).
import { expect, servers, test, until } from "../../helpers/fixtures";
import { DISK_MS, F, W, openEditor, type Editor } from "../../helpers/editor";

await servers.script();

const LONG = " This sentence makes the paragraph much longer, so that it wraps onto more lines than it did.".repeat(4);

/** The first text block whose text starts with `text`, as an expression for the page's document `d`. */
const block = (d: string, text: string) => `[...${d}.querySelectorAll("[data-erga-id]")].find((e) => e.textContent.startsWith(${JSON.stringify(text)}))`;

/**
 * Scrolls the page so the block starting with `text` is near the top, marks the page's window (a page that loads again has another),
 * and from then on, every frame, notes where that block is on the page shown. Answers a reading of it so far: how far
 * it moved at most and in the end, in pixels, whether the page rendered afresh, and in how many frames it wasn't there.
 */
async function watch(ed: Editor, text: string) {
  await ed.frame(`(() => { const el = ${block(F, text)}; el.scrollIntoView({ block: "start" }); ${W}.scrollBy(0, -40); ${W}.__marker = 1; })()`);
  await ed.settle();
  const top = await ed.frame<number>(`${block(F, text)}.getBoundingClientRect().top`);
  expect(await ed.frame<number>(`${W}.scrollY`), "the page is scrolled").toBeGreaterThan(500);
  await ed.frame(`(() => { const out = window.__tops = []; const tick = () => { const d = document; const el = d && ${block("d", text)}; out.push(el ? el.getBoundingClientRect().top : null); if (window.__tops == out) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
  return async () => {
    // A page that loaded again has none of this one's notes: where the block is now.
    const reloaded = !(await ed.frame<boolean>(`${W}.__marker == 1`));
    const tops = reloaded ? [await ed.frame<number>(`${block(F, text)}.getBoundingClientRect().top`)] : await ed.frame<(number | null)[]>(`window.__tops`);
    const seen = tops.filter((t): t is number => t != null);
    return {
      worst: Math.round(Math.max(0, ...seen.map((t) => Math.abs(t - top)))),
      end: Math.round((seen.at(-1) ?? top) - top),
      missing: tops.length - seen.length,
      reloaded,
    };
  };
}

/** The block at the top of the window stayed where it was (to a pixel), the page on screen all along (loaded again: where it is now); loaded again or not. */
function still(r: { worst: number; end: number; missing: number; reloaded: boolean }, reloaded: boolean) {
  expect(r.worst <= 1 && r.missing == 0 && r.reloaded == reloaded, JSON.stringify(r)).toBe(true);
}

test("edits on disk above and below the view, to the text, the structure and the styles, of an HTML page: the view doesn't move and the page isn't rendered again", {
  timeout: 45_000,
}, async ({ tab }) => {
  await tab.page.setViewportSize({ width: 1280, height: 800 });
  const ed = await openEditor(tab, await servers.script(), "long");
  const reading = await watch(ed, "Heat came up and the light went flat");
  const edit = async (f: (s: string) => string, shows: string) => {
    const next = f(ed.disk());
    expect(next).not.toBe(ed.disk());
    ed.write(next);
    await until(() => ed.frame<boolean>(shows), DISK_MS, shows);
  };
  await edit((s) => s.replace(/(<p id="p3">[^<]*)\./, `$1.${LONG}`), `${F}.getElementById("p3").textContent.includes("wraps onto more lines")`);
  await edit((s) => s.replace(`<h2 id="s1">`, `<ul id="added"><li>One</li><li>Two</li></ul>\n    <h2 id="s1">`), `${F}.querySelectorAll("#added li").length == 2`);
  await edit((s) => s.replace(`<h2 id="s2">`, `<svg id="chart" width="80" height="120"><rect width="80" height="120" fill="#c00"/></svg>\n    <h2 id="s2">`), `${F}.getElementById("chart")?.getBoundingClientRect().height == 120`);
  await edit((s) => s.replace("padding: 8px 12px;", "padding: 40px 12px;"), `getComputedStyle(${F}.querySelector(".note")).paddingTop == "40px"`);
  await edit((s) => s.replace(/(<p id="p40">[^<]*)\./, `$1.${LONG}`), `${F}.getElementById("p40").textContent.includes("wraps onto more lines")`);
  await ed.settle();
  still(await reading(), false);
  // The new blocks are the editor's like any other.
  expect(await ed.frame<boolean>(`${F}.querySelector("#added li").getAttribute("contenteditable") == "true"`)).toBe(true);
  expect(await ed.count(".erga-locked"), "every block still edits").toBe(0);
});

test("while you type in one paragraph, a list arrives above it: the caret stays, and your typing goes on where it was", {
  timeout: 45_000,
}, async ({ tab }) => {
  await tab.page.setViewportSize({ width: 1280, height: 800 });
  const ed = await openEditor(tab, await servers.script(), "long");
  await ed.clickEnd("#p21");
  await ed.type(" Mine");
  const reading = await watch(ed, "Heat came up and the light went flat");
  ed.write(ed.disk().replace(`<h2 id="s1">`, `<ul id="added"><li>One</li><li>Two</li></ul>\n    <h2 id="s1">`));
  await until(() => ed.frame<boolean>(`!!${F}.getElementById("added")`), DISK_MS, "the list shows");
  await ed.type(" and more");
  await ed.idle();
  expect(await ed.textOf("#p21")).toContain(" Mine and more");
  expect(await ed.source()).toContain(" Mine and more");
  still(await reading(), false);
});

test("the agent edits above the view as it works: each edit shows at once and the view stays; its change to a script makes the page afresh when it finishes: it loads again, at the same spot", async ({ tab }) => {
  await tab.page.setViewportSize({ width: 1280, height: 800 });
  const ed = await openEditor(tab, await servers.script(), "long");
  await ed.openAgent();
  const reading = await watch(ed, "Heat came up and the light went flat");
  const steps = [
    { tool: "edit", args: { path: "index.html", edits: [{ oldText: `<h2 id="s1">`, newText: `<ul id="added"><li>One</li><li>Two</li></ul>\n    <h2 id="s1">` }] } },
    { tool: "edit", args: { path: "index.html", edits: [{ oldText: `<h2 id="s2">Section 3</h2>`, newText: `<h2 id="s2">Section 3, renamed</h2>\n    <p>A paragraph the agent added.</p>` }] }, delay: 300 },
    { tool: "edit", args: { path: "index.html", edits: [{ oldText: "let n = 0;", newText: `let n = 0; document.getElementById("count").textContent = "ran";` }] }, delay: 300 },
    { text: "Done.", delay: 1500 },
  ];
  await ed.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify("Edit @script " + JSON.stringify(steps))}; i.dispatchEvent(new Event("input")); i.focus(); })()`);
  await ed.page.keyboard.press("Enter");
  // Text and structure show while it works, without a render.
  await until(() => ed.frame<boolean>(`!!${F}.getElementById("added") && ${F}.getElementById("s2").textContent.endsWith("renamed")`), 10_000, "the agent's edits show as it makes them");
  expect(await ed.frame<boolean>(`${W}.__marker == 1`), "without a render").toBe(true);
  // The script waits for the end of its turn.
  await until(() => ed.eval<boolean>(`!document.getElementById("refresh-pill").hidden`), 10_000, "the pill says a change waits for the agent");
  expect(await ed.frame<string>(`${F}.getElementById("count").textContent`)).toBe("0");
  await until(() => ed.frame<boolean>(`${F}.getElementById("count")?.textContent == "ran"`), 15_000, "the page renders afresh once the agent finishes, and the new script runs");
  await ed.settle();
  still(await reading(), true);
  expect(await ed.eval<boolean>(`document.getElementById("refresh-pill").hidden`)).toBe(true);
  expect(await ed.eval<number>(`document.querySelectorAll("iframe").length`), "one page frame").toBe(1);
  expect(await ed.frame<boolean>(`!!${F}.querySelector("style[data-erga-caret]")`), "the new page draws your caret too (caret.ts)").toBe(true);
});

test("the agent edits the first sentence of a long paragraph that starts above the window: the line you read stays put, and so it does when its change to a script makes the page afresh (it loads again)", {
  timeout: 45_000,
}, async ({ tab }) => {
  await tab.page.setViewportSize({ width: 1280, height: 800 });
  const ed = await openEditor(tab, await servers.script(), "long");
  const sentences = Array.from({ length: 80 }, (_, i) => i == 50 ? "Here is the word zebra, in the middle." : `Sentence ${i + 1} of the long paragraph.`);
  ed.write(ed.disk().replace(`<h2 id="s3">`, `<p id="long">${sentences.join(" ")}</p>\n    <h2 id="s3">`));
  await until(() => ed.frame<boolean>(`!!${F}.getElementById("long")`), DISK_MS, "the long paragraph shows");
  await ed.openAgent();
  // The word "zebra" 300 px down the window, the paragraph's start far above it.
  const word = `(() => { const d = document; const p = d.getElementById("long"); const t = p && [...p.childNodes].find((n) => n.nodeType == 3 && n.nodeValue.includes("zebra")); if (!t) return null; const r = d.createRange(); const i = t.nodeValue.indexOf("zebra"); r.setStart(t, i); r.setEnd(t, i + 5); return r.getBoundingClientRect().top; })()`;
  await ed.frame(`${W}.scrollBy(0, ${word} - 300)`);
  await ed.settle();
  const top = (await ed.frame<number>(word))!;
  expect(await ed.frame<number>(`${F}.getElementById("long").getBoundingClientRect().top`), "the paragraph starts above the window").toBeLessThan(-300);
  await ed.frame(`(() => { ${W}.__marker = 1; const out = window.__tops = []; const tick = () => { out.push(${word}); if (window.__tops == out) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
  const reading = async () => {
    // A page that loaded again has none of this one's notes: where the word is now.
    const reloaded = !(await ed.frame<boolean>(`${W}.__marker == 1`));
    const tops = reloaded ? [await ed.frame<number | null>(word)] : await ed.frame<(number | null)[]>(`window.__tops`);
    const seen = tops.filter((t): t is number => t != null);
    return { worst: Math.round(Math.max(0, ...seen.map((t) => Math.abs(t - top)))), end: Math.round((seen.at(-1) ?? top) - top), missing: tops.length - seen.length, reloaded };
  };
  const run = async (steps: unknown[]) => {
    const replies = () => ed.eval<number>(`document.querySelectorAll(".msg-assistant").length`);
    const before = await replies();
    await ed.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify("Edit @script " + JSON.stringify(steps))}; i.dispatchEvent(new Event("input")); i.focus(); })()`);
    await ed.page.keyboard.press("Enter");
    await until(async () => await replies() > before && !(await ed.eval<boolean>(`document.getElementById("agent-send").classList.contains("stop")`)), 15_000, "the agent finishes");
  };
  // Its first sentence, far above the window, becomes several lines longer.
  await run([{ tool: "edit", args: { path: "index.html", edits: [{ oldText: "Sentence 1 of the long paragraph.", newText: `The agent rewrote this first sentence.${LONG}` }] } }, { text: "Done." }]);
  await until(() => ed.frame<boolean>(`${F}.getElementById("long").textContent.startsWith("The agent rewrote")`), 5000, "the edit shows");
  await ed.settle();
  still(await reading(), false);
  // A change to the script: the page renders afresh, on the same line.
  await run([{ tool: "edit", args: { path: "index.html", edits: [{ oldText: "let n = 0;", newText: `let n = 0; document.getElementById("count").textContent = "ran";` }] } }, { text: "Done." }]);
  await until(() => ed.frame<boolean>(`${F}.getElementById("count")?.textContent == "ran"`), 15_000, "the page renders afresh");
  await ed.settle();
  still(await reading(), true);
});
