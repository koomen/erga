// Two tabs on one document, typing at once (the robustness hunt): what each tab shows, and that no key is lost.
import { knownBug, servers, test, until, type Tab } from "../../helpers/fixtures";
import { editor, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

/** The fixture in the test's tab and in a second tab of the same browser. */
async function twoTabs(tab: Tab): Promise<[Editor, Editor]> {
  const a = await openEditor(tab, await servers.main(), "robust-two");
  const page = await tab.page.context().newPage();
  page.on("pageerror", (e) => tab.errors.push(e.stack ?? e.message));
  page.on("console", (m) => {
    if (m.type() == "error") tab.errors.push(`console.error: ${m.text()}`);
  });
  await page.goto(`${a.address}?edit`);
  const b = editor(page, a);
  await b.loaded();
  return [a, b];
}

/** Waits until both tabs show `text` in the element. */
const bothShow = (a: Editor, b: Editor, selector: string, text: string) =>
  until(
    async () => (await a.textOf(selector)) == text && (await b.textOf(selector)) == text,
    5000,
    `both tabs show "${text}"`,
    async () => [await a.textOf(selector), await b.textOf(selector)]
  );

test("two tabs type at once in nearby paragraphs, with Enter: both show all the text", async ({ tab }) => {
  const [a, b] = await twoTabs(tab);
  await a.clickEnd("#a");
  await b.clickEnd("#b");
  await Promise.all([a.type("123\n456"), b.type("abc\ndef")]);
  await until(
    async () => {
      const s = await a.source();
      return s.includes(`<p id="a">Alpha123</p>\n<p>456</p>\n<p id="b">Bravoabc</p>\n<p>def</p>`) && s == (await b.source());
    },
    5000,
    "the tabs agree"
  );
  await bothShow(a, b, "#b", "Bravoabc");
});

test("the other tab joins your paragraph to the one above: your next keys are kept", async ({ tab }) => {
    const [a, b] = await twoTabs(tab);
    const start = await a.charAt("#b", 0);
    await a.click(start.x, start.y);
    await b.clickEnd("#b");
    await a.press("Backspace");
    await bothShow(a, b, "#a", "AlphaBravo");
    await b.type("xyz");
    await bothShow(a, b, "#a", "AlphaBravoxyz");
  }
);

test("the other tab indents the list item you type in: your keys stay in it", async ({ tab }) => {
    const [a, b] = await twoTabs(tab);
    await a.clickEnd("#i2");
    await b.clickEnd("#i2");
    await b.type("ab");
    await a.press("Tab");
    await until(async () => (await a.count("li li")) == 1 && (await b.count("li li")) == 1, 5000, "both tabs show the item nested");
    await b.type("cd");
    await bothShow(a, b, "#i2", "Twoabcd");
  }
);
