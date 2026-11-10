// The end of the agent's turn, in its panel (client/agent/turn-summary.ts): one line says what the turn changed, "See
// changes" shows the text before and after it, and "Undo the turn" takes back all of its changes with one click.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.script();

/** Has the agent make `steps` (servers.script's @script). */
async function agent(ed: Editor, steps: object[]) {
  await ed.eval(
    `(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify("Edit @script " + JSON.stringify([...steps, { text: "Done." }]))}; i.dispatchEvent(new Event("input")); i.focus(); })()`
  );
  await ed.page.keyboard.press("Enter");
}
const edit = (oldText: string, newText: string) => ({ tool: "edit", args: { path: "index.html", edits: [{ oldText, newText }] } });
const heads = async (ed: Editor) => `${await ed.textOf("h1")} / ${await ed.textOf("#s0")} / ${await ed.textOf("#s1")}`;
/** The turn's line as the panel shows it: its text and its buttons; null while it is hidden. */
const line = (ed: Editor) =>
  ed.eval<string | null>(
    `(() => { const t = document.getElementById("agent-turn"); return t.hidden ? null : [t.querySelector("span").textContent, ...[...t.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => "[" + b.textContent + "]")].join(" "); })()`
  );

test("a turn of three edits ends with one line; See changes shows them; Undo the turn takes all three back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.script(), "long");
  await ed.openAgent();
  expect(await line(ed)).toBeNull();

  // One earlier turn, so that the turn below does not start at the first change.
  await agent(ed, [edit(">Section 3<", ">Dusk<")]);
  await expect.poll(() => line(ed), { timeout: 15_000 }).toBe("Done. 1 change in index.html. [See changes] [Undo the turn]");

  await agent(ed, [edit("<h1>Long notes</h1>", "<h1>Field notes</h1>"), edit(">Section 1<", ">Dawn<"), edit(">Section 2<", ">Noon<")]);
  await until(async () => (await heads(ed)) == "Field notes / Dawn / Noon", 15_000, "the agent's three changes");
  await expect.poll(() => line(ed)).toBe("Done. 3 changes in index.html. [See changes] [Undo the turn]");

  // The text before and after the turn: this turn's lines only.
  await ed.page.click("#agent-turn button.see");
  const shown = () => ed.eval<string>(`document.querySelector("dialog.agent-changes[open] pre")?.innerText ?? ""`);
  await until(async () => /^\+\s*<h1>Field notes<\/h1>$/m.test(await shown()), 10_000, "the changes show");
  const diff = await shown();
  expect(diff).toMatch(/^-\s*<h1>Long notes<\/h1>$/m);
  expect(diff).toContain("Dawn");
  expect(diff).toContain("Noon");
  expect(diff).not.toMatch(/^[+-].*Dusk/m);
  await ed.page.screenshot({ path: ".e2e/shots/agent-turn-changes.png" });
  await ed.page.click("dialog.agent-changes[open] button.close");

  // One click takes back the three changes of this turn, and leaves the turn before it.
  await ed.page.click("#agent-turn button.undo");
  await until(async () => (await heads(ed)) == "Long notes / Section 1 / Section 2", 10_000, "the turn is undone");
  expect(await ed.textOf("#s2")).toBe("Dusk");
  await expect.poll(() => line(ed)).toBe("Took back 3 changes.");
  await ed.page.screenshot({ path: ".e2e/shots/agent-turn-undone.png" });
  expect(await ed.eval<string>(`document.getElementById("agent-undo").dataset.tip`)).toBe("Undo the agent's last change (1 to go)");
});
