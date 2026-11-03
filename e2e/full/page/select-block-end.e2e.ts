// A selection that ends at the start of the next block deletes nothing of that block, and the two stay apart (Pete, on
// /_home: "Images and files kept whole." selected and deleted pulled the "Lines" heading up into the paragraph).
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

const P = "p:nth-of-type(2)";
/** Points in the tab: on "Images" and on the last "." of the paragraph. */
async function words(ed: Editor) {
  const f = await ed.frameAt();
  const r = await ed.frame<{ x: number; y: number; dot: number }>(
    `(() => { const t = ${F}.querySelector(${JSON.stringify(P)}).lastChild, i = t.textContent.indexOf("Images"), at = (k) => { const rg = ${F}.createRange(); rg.setStart(t, k); rg.setEnd(t, k + 1); return rg.getBoundingClientRect(); }; const a = at(i), d = at(t.length - 1); return { x: a.left + 3, y: a.top + a.height / 2, dot: d.right - 1 }; })()`
  );
  return { x: r.x + f.x, y: r.y + f.y, dot: r.dot + f.x };
}

for (const key of ["Backspace", "Delete"]) {
  test(`a double-click on "Images", a shift-click on the last ".", then ${key}: the words go and "Lines" stays a heading`, async ({
    tab,
  }) => {
    const ed = await openEditor(tab, await servers.main(), "under-hood");
    const w = await words(ed);
    await ed.click(w.x, w.y, { clickCount: 2 });
    await ed.click(w.dot, w.y, { modifiers: ["Shift"] });
    await expect.poll(async () => (await ed.selection()).text).toContain("kept whole.");
    await ed.press(key);
    await expect.poll(() => ed.source()).toContain(`<p><strong>R2</strong> (storage): </p>\n  <h3>Lines</h3>\n  <p>The window`);
    await ed.shows(`
      ## Under the hood (draft text for the diagram)

      D1 (database): Documents, people and versions.

      R2 (storage): |

      ### Lines

      The window to the Worker: HTTPS
    `);
  });
}

test(`a triple-click on the paragraph, then Backspace: the paragraph is empty, "Lines" stays a heading, and undo brings the text back`, async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "under-hood");
  const original = await ed.source();
  const w = await words(ed);
  await ed.click(w.x, w.y, { clickCount: 3 });
  await expect.poll(async () => (await ed.selection()).text).toContain("kept whole.");
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).toContain(`versions.</p>\n  <p></p>\n  <h3>Lines</h3>`);
  await ed.shows(`
    ## Under the hood (draft text for the diagram)

    D1 (database): Documents, people and versions.

    |

    ### Lines

    The window to the Worker: HTTPS
  `);
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
});
