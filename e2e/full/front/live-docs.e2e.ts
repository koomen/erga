// Live pages on Documents (/docs): a change made elsewhere (an agent over the API, someone who shares a document)
// shows on the open list at once, with no reload, and nothing else on the page moves (server/news/).
import { expect, test } from "../../helpers/fixtures";
import { person, servers, tools } from "./front";

await servers.script();

test("an agent makes, renames and deletes documents over the API, and someone shares one: the open list follows each, with no reload", async ({
  tab,
}) => {
  const p = await person(await servers.script());
  const page = tab.page;
  tab.strict = true;
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  /** What the list shows, as the person sees it: the count, and each row's title. */
  const shown = () =>
    page.evaluate(
      `[document.getElementById("docs-count")].filter((c) => c.checkVisibility()).map((c) => c.innerText).concat([...document.querySelectorAll("ol.rows > li[data-live] .title")].map((t) => t.innerText)).join(" | ")`
    );
  /** A row's notes, as shown ("ada · view only"). */
  const notes = (id: string) =>
    page.evaluate(`[...document.querySelectorAll('li[data-live="doc:${id}"] .note')].map((n) => n.innerText).join(", ")`);
  expect(await page.evaluate<string>(`document.querySelector("main").innerText`)).toContain("No documents yet");
  // The same page all along: a reload would lose this.
  await page.evaluate(`window.sameLoad = true`);

  const agent = tools(p.base, await p.token("Live test agent"));
  const made = (await agent.call("create_document", { title: "Made by an agent" })).data as { id: string };
  await expect.poll(shown).toBe("1 document | Made by an agent");
  expect(await page.evaluate<boolean>(`document.querySelector("p.empty").checkVisibility()`)).toBe(false);

  await agent.call("rename_document", { document: made.id, title: "Renamed by an agent" });
  await expect.poll(shown).toBe("1 document | Renamed by an agent");

  // Someone else shares theirs: it comes in at its place, the latest edit first.
  const bo = await person(await servers.script());
  const theirs = await bo.make();
  await bo.share(theirs, p.login, "viewer");
  await expect.poll(shown).toBe("2 documents | Untitled | Renamed by an agent");
  expect(await notes(theirs)).toBe(`${bo.login} · view only`);

  // The focus stays where it was while a row changes: on the same control of the new row.
  await page.focus(`li[data-live="doc:${made.id}"] a.doc`);
  await agent.call("rename_document", { document: made.id, title: "Renamed again" });
  await expect.poll(shown).toContain("Renamed again");
  expect(await page.evaluate<string>(`document.activeElement.closest("li").dataset.live`)).toBe(`doc:${made.id}`);

  await bo.share(theirs, p.login, "none");
  await agent.call("delete_document", { document: made.id });
  await expect.poll(shown).toBe("");
  expect(await page.evaluate<boolean>(`document.querySelector("p.empty").checkVisibility()`)).toBe(true);
  expect(await page.evaluate<boolean>(`window.sameLoad`)).toBe(true);
});
