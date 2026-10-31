// Live pages on Documents (/docs): a change made elsewhere (an agent over the API, someone who shares a document)
// shows on the open list at once, with no reload, and nothing else on the page moves (server/news/).
import { expect, test, until } from "../../helpers/fixtures";
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

test("a hidden tab waits: changes made meanwhile come in when it shows, both rows in one ask, and nothing else", async ({ tab }) => {
  const p = await person(await servers.script());
  const agent = tools(p.base, await p.token("Live test agent"));
  const a = (await agent.call("create_document", { title: "First" })).data as { id: string };
  const b = (await agent.call("create_document", { title: "Second" })).data as { id: string };
  const page = tab.page;
  tab.strict = true;
  // What the page's socket hears, and each ask for rows.
  const heard: string[] = [],
    asks: string[] = [];
  let done = 0;
  page.on("websocket", (ws) => {
    if (ws.url().includes("/api/news")) ws.on("framereceived", (f) => heard.push(String(f.payload)));
  });
  page.on("request", (r) => {
    if (r.url().includes("/api/news/rows")) asks.push(r.url());
  });
  page.on("requestfinished", (r) => {
    if (r.url().includes("/api/news/rows")) done++;
  });
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  const titles = () =>
    page.evaluate<string>(`[...document.querySelectorAll("ol.rows > li[data-live] .title")].map((t) => t.innerText).join(" | ")`);
  expect(await titles()).toBe("Second | First");
  // The socket's first answer (what changed since a little before the page was made: these two, just made, again) and its
  // ask are done; from here, only what changes next.
  await until(
    () => heard.length > 0 && (!heard[0].includes('"key"') || asks.length > 0) && done == asks.length,
    5_000,
    "the page caught up as it opened"
  );
  heard.length = asks.length = 0;
  // The tab goes to the background (as the browser says it, to the page).
  await page.evaluate(
    `Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange"))`
  );
  await agent.call("rename_document", { document: a.id, title: "First, renamed" });
  await agent.call("rename_document", { document: b.id, title: "Second, renamed" });
  await until(
    () => heard.some((t) => t.includes(`doc:${a.id}`)) && heard.some((t) => t.includes(`doc:${b.id}`)),
    5_000,
    "the socket heard both changes"
  );
  expect(asks).toEqual([]);
  expect(await titles()).toBe("Second | First");
  // Back in view: both rows as they are now, in one ask.
  await page.evaluate(
    `Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange"))`
  );
  await expect.poll(titles).toBe("Second, renamed | First, renamed");
  expect(asks.length).toBe(1);
  expect(new URL(asks[0]).searchParams.get("keys")!.split(",").sort()).toEqual([`doc:${a.id}`, `doc:${b.id}`].sort());
});
