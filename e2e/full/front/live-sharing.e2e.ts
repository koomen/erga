// Live pages in the editor: sharing changed elsewhere (another tab, an agent) shows in an open Share card, and someone
// whose role is taken away while their editor is open stops editing at once (server/news/, document/tabs.ts).
import { expect, test, until } from "../../helpers/fixtures";
import { person, servers } from "./front";

await servers.script();

test("the owner's open Share card lists someone an agent shares the document with, and drops them when it stops", async ({ tab }) => {
  const p = await person(await servers.script());
  const id = await p.make();
  const page = tab.page;
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=${encodeURIComponent(`${(await p.nameOf(id)).address}?edit`)}`);
  await until(() => page.evaluate(`document.body.classList.contains("erga-listening")`), 15_000, "the editor joined its room");
  await page.click("#btn-share");
  const people = () =>
    page.evaluate<string>(
      `[...document.querySelectorAll("#sharing-list li")].map((li) => li.innerText.replace(/\\s+/g, " ").trim()).join(" | ")`
    );
  await expect.poll(people).toContain(p.login);
  await p.share(id, "Bo", "viewer");
  await expect.poll(people).toContain("bo");
  await p.share(id, "Bo", "none");
  await expect.poll(people).not.toContain("bo");
});

test("someone the document stops being shared with, while their editor is open, stops editing: the page opens again and says so", async ({
  tab,
}) => {
  const p = await person(await servers.script());
  const id = await p.make();
  await p.share(id, "Ada", "editor");
  const page = tab.page;
  await page.goto(`${p.base}${(await p.nameOf(id)).address}?edit&user=Ada`);
  await until(() => page.evaluate(`document.body.classList.contains("erga-listening")`), 15_000, "Ada's editor joined its room");
  expect(await page.evaluate<boolean>(`!!document.getElementById("btn-share")`)).toBe(true);
  await page.evaluate(`window.beforeTheChange = true`);
  await p.share(id, "Ada", "none");
  await until(
    () => page.evaluate(`!window.beforeTheChange && document.readyState == "complete"`).catch(() => false),
    10_000,
    "Ada's page opened again"
  );
  expect(await page.evaluate<string>(`document.body.innerText`)).toContain("has not shared this document with");
  expect((await p.as("Ada", `/d/${id}/api/stored/index.html`, { method: "PUT", body: "<h1>Still mine</h1>" })).status).toBe(403);
});
