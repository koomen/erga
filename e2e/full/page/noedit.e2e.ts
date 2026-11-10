// Parts marked data-erga-noedit: never editable by hand, and clicking them says so ("No-edit parts").
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor } from "../../helpers/editor";

await servers.script();

test("a no-edit section has no editable text, and a no-edit span inside a paragraph is fenced off", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.script(), "noedit");
  expect(
    await ed.frame<boolean>(
      `[...${F}.querySelectorAll(".fixed h2, .fixed p")].every((e) => !e.hasAttribute("data-erga-text") && !e.isContentEditable)`
    )
  ).toBe(true);
  expect(await ed.frame<boolean>(`${F}.querySelector(".free").isContentEditable && !${F}.querySelector(".count").isContentEditable`)).toBe(
    true
  );
});

test("clicking a no-edit part says why, typing there changes nothing, and the rest of the paragraph still edits", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.script(), "noedit");
  const before = await ed.source();
  const r = await ed.rectOf(".fixed p", 0.3);
  await ed.click(r.x, r.y);
  // (The viewer's note, with its button.)
  await expect.poll(async () => (await ed.toast()).shown && /not editable by hand/.test((await ed.toast()).text)).toBe(true);
  await ed.type("xyz");
  await ed.settle();
  expect(await ed.source()).toBe(before);
  await ed.clickEnd(".free");
  await ed.type("!");
  await expect.poll(() => ed.source()).toContain("items.!</p>");
});

/** The agent's box: what it holds, whether the panel is open, and how many messages went. */
const box = (ed: Awaited<ReturnType<typeof openEditor>>) =>
  ed.eval<{ text: string; open: boolean; sent: number }>(
    `({ text: document.getElementById("agent-input").value, open: document.body.classList.contains("agent-open"), sent: document.querySelectorAll(".msg-user").length })`
  );

test("a no-edit part's note has Fix with agent: it opens the agent's panel with the request ready to complete, and sends nothing", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.script(), "noedit");
  const r = await ed.rectOf(".count", 0.5);
  await ed.click(r.x, r.y);
  await expect.poll(async () => (await ed.toast()).shown).toBe(true);
  expect(await ed.eval<string>(`document.querySelector("#toast .toast-fix").textContent`)).toBe("Fix with agent");
  await ed.page.click("#toast .toast-fix");
  await expect.poll(() => box(ed)).toEqual({ text: "Change the text “42” to: ", open: true, sent: 0 });
  expect(await ed.eval<boolean>(`document.activeElement == document.getElementById("agent-input")`)).toBe(true);
  await ed.page.screenshot({ path: ".e2e/shots/noedit-fix.png" });
});

test("text that the page's script changed: its note has Fix with agent, which asks the agent to make it editable by hand", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.script(), "script-text");
  const r = await ed.rectOf("#now", 0.3);
  await ed.click(r.x, r.y);
  await expect.poll(async () => (await ed.toast()).text).toMatch(/changed by the page's script after it loaded/);
  await ed.page.click("#toast .toast-fix");
  await expect.poll(async () => (await box(ed)).sent).toBe(1);
  expect(await ed.eval<string>(`document.querySelector(".msg-user").textContent`)).toContain(
    "Fix the problem with this page that the editor reported"
  );
});
