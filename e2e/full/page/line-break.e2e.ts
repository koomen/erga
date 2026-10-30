// Shift+Enter breaks a line in a block (<br>). At the end of a block's text, a second <br> holds the new, empty line
// open (lineHolder): a <br> at a block's end shows no line alone.
import { servers, test } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

// Pete's keys: two line breaks, one letter on the new last line, then that letter deleted. Before, the deletion took
// the last line away with the letter: the caret showed on the empty line above, and the next letter went there.
for (const [key, back] of [
  ["Backspace", []],
  ["Delete", ["ArrowLeft"]],
] as const)
  test(`${key} of the one letter on a last line after a line break leaves that line, and the caret on it`, async ({ tab }) => {
    const ed = await openEditor(tab, await servers.main(), "empty");
    await ed.clickEnd("p");
    await ed.idle();
    await ed.type("The way we work.");
    await ed.press("Shift+Enter");
    await ed.press("Shift+Enter");
    await ed.type("s");
    for (const k of back) await ed.press(k);
    await ed.press(key);
    await ed.shows(`
      The way we work.

      |
    `);
    await ed.type("X");
    await ed.shows(`
      The way we work.

      X|
    `);
  });
