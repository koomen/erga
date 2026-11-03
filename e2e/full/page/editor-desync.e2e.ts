// The page's text stays in step with the room's. Pete saw "Applying change set to a document with the wrong length"
// while he edited his deck: an edit from outside (the agent, the disk) that came while the page loaded again went to
// the new page twice. The page's editor now has its own replica of the room (libs/text/ui/frame.ts): the page that
// loads again joins the room afresh, and takes the edit once. The keys typed while the new page loads go in it too:
// the old page holds them, and hands them over as it goes (libs/text/ui/frame.ts, pagehide).
import { expect, servers, test, until } from "../../helpers/fixtures";
import { DISK_MS, F, openEditor } from "../../helpers/editor";

await servers.main();

const wrongLength = (errors: string[]) => errors.filter((e) => /wrong length|RangeError/.test(e));

test("an edit on disk and keys while the page loads again: no error, and the file ends with the edit and every key", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "deck");
  await ed.press("Escape");
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await ed.clickEnd(".current h1");
  await ed.type(" one");
  await ed.idle();
  // The page loads slowly, as on a real network: the edit on disk comes while it loads.
  let release = () => {};
  let asked = false;
  const held = new Promise<void>((r) => (release = r));
  await tab.page.context().route(/[?&]erga-edit/, async (route) => {
    asked = true;
    await held;
    await route.continue();
  });
  // The page made afresh, as for a change the editor can't patch in: it loads again.
  await ed.frame(`ergaFrame.page.render()`);
  // (The old page has handed its state over, and asked for the new one: it stays until the new one comes.)
  await until(() => asked, 5000, "the page asks for the new page");
  ed.write(ed.disk().replace("The arrows move between slides.", "The arrows move between slides, and the disk edits."));
  await until(() => ed.eval<boolean>(`ergaPage.collab.current().includes("the disk edits")`), DISK_MS, "the shell has the edit on disk");
  // The person types on while the page loads.
  await ed.type(" two");
  // (From now on the page loads at once.)
  release();
  await ed.loaded();
  await ed.type(" three");
  await ed.idle();
  await ed.shows(`
    # Third slide one two three|

    The last one.
  `);
  expect(wrongLength(tab.errors)).toEqual([]);
  await until(() => ed.disk().includes("Third slide one two three") && ed.disk().includes("the disk edits"), DISK_MS, "the file has both");
  expect(await ed.frame<string>(`${F}.querySelector(".slide p").textContent`), "the first slide has the edit on disk").toContain(
    "the disk edits"
  );
});
