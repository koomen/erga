// The editor's header and the room around the page take the page's background, and
// follow it whichever way it changes: the agent's edit to a style rule (shown in place, not rendered: morph.ts), its
// undo, a script change (the page rendered afresh in a new frame), and a change typed in the source view.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

await servers.script();

/** The shell's colour: what the band and the room beside the page are painted, and whether the header's controls are drawn for a dark page. */
const shell = (ed: Editor) => ed.eval<string>(`(() => { const r = document.documentElement; return getComputedStyle(r).getPropertyValue("--page-bg").trim() + (r.classList.contains("page-dark") ? " dark" : ""); })()`);
const page = (ed: Editor) => ed.frame<string>(`getComputedStyle(${F}.body).backgroundColor`);

/** The page turns `color`, and the shell with it. */
async function follows(ed: Editor, color: string, dark: boolean, what: string) {
  await until(async () => (await page(ed)) == color, 15_000, `${what}: the page turns ${color}`);
  await expect.poll(() => shell(ed), { message: `${what}: the shell follows` }).toBe(color + (dark ? " dark" : ""));
}

/** Has the agent make `steps` (servers.script's @script). */
async function agent(ed: Editor, steps: object[]) {
  await ed.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify("Edit @script " + JSON.stringify([...steps, { text: "Done." }]))}; i.dispatchEvent(new Event("input")); i.focus(); })()`);
  await ed.page.keyboard.press("Enter");
}

test("the header follows the page's background: the agent's edit to a style rule and its undo, a script change, a change typed in the source view", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.script(), "long");
  await ed.openAgent();
  await expect.poll(() => shell(ed)).toBe("#ffffff");

  await agent(ed, [{ tool: "edit", args: { path: "index.html", edits: [{ oldText: "<style>body {", newText: "<style>body { background: rgb(20, 20, 30);" }] } }]);
  await follows(ed, "rgb(20, 20, 30)", true, "the agent's edit to a style rule");
  await until(() => ed.eval<boolean>(`document.getElementById("agent-undo").getAttribute("aria-disabled") == "false"`), 10_000, "the agent's turn ends");
  await ed.eval(`document.getElementById("agent-undo").click()`);
  await until(async () => (await page(ed)) == "rgba(0, 0, 0, 0)", 15_000, "its undo: the page is white again");
  await expect.poll(() => shell(ed), { message: "its undo: the shell follows" }).toBe("#ffffff");

  // A rule for a class, and the script that sets it: the page renders afresh in a new frame.
  await agent(ed, [{ tool: "edit", args: { path: "index.html", edits: [
    { oldText: "</style>", newText: " body.sea { background: rgb(10, 40, 60); }</style>" },
    { oldText: "let n = 0;", newText: `let n = 0; document.body.classList.add("sea");` },
  ] } }]);
  await follows(ed, "rgb(10, 40, 60)", true, "a script change");

  // Typed in the source view, and undone in the page.
  await ed.eval(`ergaPage.toggleSource(true)`);
  await until(() => ed.eval<boolean>(`!!document.querySelector("#source .cm-content[contenteditable=true]")`), 5000, "the source view");
  await ed.eval(`(() => {
    const c = document.querySelector("#source .cm-content"), want = "rgb(10, 40, 60)", i = c.textContent.indexOf(want);
    const at = (k) => { const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT); let n, o = 0; while ((n = w.nextNode())) { if (o + n.nodeValue.length >= k) return [n, k - o]; o += n.nodeValue.length; } };
    c.focus(); const r = document.createRange(); r.setStart(...at(i)); r.setEnd(...at(i + want.length)); getSelection().removeAllRanges(); getSelection().addRange(r);
  })()`);
  await ed.settle();
  await ed.page.keyboard.type("rgb(250, 240, 200)");
  await ed.press("Escape");
  await follows(ed, "rgb(250, 240, 200)", false, "a change typed in the source view");
  await ed.idle();
  await ed.press("ControlOrMeta+z");
  await follows(ed, "rgb(10, 40, 60)", true, "its undo");
});
