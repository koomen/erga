// The agent panel's Redo, beside Undo: it puts back the changes Undo took back, one tool call at a time, and a new
// change by the agent clears what is left to redo. The person clicks the buttons; the page shows each state.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.script();

/** Has the agent make `steps` (servers.script's @script), and waits for its turn to end. */
async function agent(ed: Editor, steps: object[]) {
  await ed.eval(
    `(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify("Edit @script " + JSON.stringify([...steps, { text: "Done." }]))}; i.dispatchEvent(new Event("input")); i.focus(); })()`
  );
  await ed.page.keyboard.press("Enter");
}
const edit = (oldText: string, newText: string) => ({ tool: "edit", args: { path: "index.html", edits: [{ oldText, newText }] } });

/** A button's state: "off" or its tip. */
const btn = (ed: Editor, id: string) =>
  ed.eval<string>(
    `(() => { const b = document.getElementById(${JSON.stringify(id)}); return b.getAttribute("aria-disabled") == "true" ? "off" : b.dataset.tip; })()`
  );
const heads = async (ed: Editor) => `${await ed.textOf("h1")} / ${await ed.textOf("#s0")}`;

async function click(ed: Editor, id: string, want: string, undo: string, redo: string) {
  await ed.page.click(`#${id}`);
  await until(async () => (await heads(ed)) == want, 10_000, `after ${id}, the page shows ${want}`);
  await expect.poll(() => btn(ed, "agent-undo"), { message: `after ${id}: Undo` }).toBe(undo);
  await expect.poll(() => btn(ed, "agent-redo"), { message: `after ${id}: Redo` }).toBe(redo);
}

test("Redo puts back each change Undo took back, and a new change by the agent turns it off", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.script(), "long");
  await ed.openAgent();
  expect(await btn(ed, "agent-redo")).toBe("off");

  await agent(ed, [edit("<h1>Long notes</h1>", "<h1>Field notes</h1>"), edit(">Section 1<", ">Dawn<")]);
  await until(async () => (await heads(ed)) == "Field notes / Dawn", 15_000, "the agent's two changes");
  await expect.poll(() => btn(ed, "agent-undo")).toBe("Undo the agent's last change (2 to go)");
  expect(await btn(ed, "agent-redo")).toBe("off");

  await click(
    ed,
    "agent-undo",
    "Field notes / Section 1",
    "Undo the agent's last change (1 to go)",
    "Redo the agent's last undone change (1 to go)"
  );
  await click(ed, "agent-undo", "Long notes / Section 1", "off", "Redo the agent's last undone change (2 to go)");
  await ed.page.screenshot({ path: ".e2e/shots/agent-redo-undone.png" });
  await click(
    ed,
    "agent-redo",
    "Field notes / Section 1",
    "Undo the agent's last change (1 to go)",
    "Redo the agent's last undone change (1 to go)"
  );
  await click(ed, "agent-redo", "Field notes / Dawn", "Undo the agent's last change (2 to go)", "off");
  await ed.page.screenshot({ path: ".e2e/shots/agent-redo-redone.png" });

  // Undo, then a new change by the agent: nothing is left to redo.
  await click(
    ed,
    "agent-undo",
    "Field notes / Section 1",
    "Undo the agent's last change (1 to go)",
    "Redo the agent's last undone change (1 to go)"
  );
  await agent(ed, [edit(">Section 2<", ">Noon<")]);
  await until(async () => (await ed.textOf("#s1")) == "Noon", 15_000, "the agent's new change");
  await expect.poll(() => btn(ed, "agent-redo"), { message: "a new change clears Redo" }).toBe("off");
  await expect.poll(() => btn(ed, "agent-undo")).toBe("Undo the agent's last change (2 to go)");
});
