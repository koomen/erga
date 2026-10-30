// The frame's text and the shell's stay in step (client/page-editor/bridge.ts). Pete saw "Applying change set to a
// document with the wrong length" while he edited his deck: an edit from outside (the agent, the disk) that came while
// the page loaded again went to the new page twice, once in its init and once more after it.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { DISK_MS, F, openEditor } from "../../helpers/editor";

await servers.main();

const wrongLength = (errors: string[]) => errors.filter((e) => /wrong length|RangeError/.test(e));

test("an edit on disk while the page loads again: no error, and the file ends with it and with what was typed", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "deck");
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await ed.clickEnd(".current h1");
  await ed.type(" one");
  await ed.idle();
  // The page loads slowly, as on a real network: the edit on disk comes while it loads.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await tab.page.context().route(/[?&]erga-edit/, async (route) => {
    await held;
    await route.continue();
  });
  // The page made afresh, as for a change the editor can't patch in: it loads again.
  await ed.eval(`window.ergaPage.page.render()`);
  await until(() => ed.eval<boolean>(`window.ergaPage.page.loading`), 5000, "the page loads again");
  ed.write(ed.disk().replace("The arrows move between slides.", "The arrows move between slides, and the disk edits."));
  await until(
    () => ed.eval<boolean>(`ergaPage.state.doc.toString().includes("the disk edits")`),
    DISK_MS,
    "the shell has the edit on disk"
  );
  // (From now on the page loads at once.)
  release();
  await ed.loaded();
  await ed.type(" two");
  await ed.idle();
  await ed.shows(`
    # Third slide one two|

    The last one.
  `);
  expect(wrongLength(tab.errors)).toEqual([]);
  await until(() => ed.disk().includes("Third slide one two") && ed.disk().includes("the disk edits"), DISK_MS, "the file has both");
  expect(await ed.frame<string>(`${F}.querySelector(".slide p").textContent`), "the first slide has the edit on disk").toContain(
    "the disk edits"
  );
});

test("a change that doesn't fit the frame's text: the editor takes the shell's text again, with no error, and typing goes on", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "deck");
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await ed.clickEnd(".current h1");
  await ed.type(" one");
  await ed.idle();
  const warned = new Promise<string>((r) =>
    tab.page.on("console", (m) => {
      if (m.type() == "warning" && /resyncing/.test(m.text())) r(m.text());
    })
  );
  // A change made for a text 7 characters longer than this one, as from a frame and a shell out of step.
  await ed.eval(
    `(() => { const n = ergaPage.state.doc.length + 7; ergaPage.page.post({ type: "external", changes: [n, [0, "x"]], author: null, length: n + 1 }); })()`
  );
  expect(await warned).toMatch(/doesn't fit/);
  await ed.clickEnd(".current h1");
  await ed.type(" two");
  await ed.idle();
  await ed.shows(`
    # Third slide one two|

    The last one.
  `);
  expect(wrongLength(tab.errors)).toEqual([]);
  await until(() => ed.disk().includes("Third slide one two"), DISK_MS, "the file has what was typed");
});
