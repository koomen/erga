// Find on Documents (/docs): each key typed in the box hides the rows whose title and address don't match, at once,
// in the browser, on /docs and on /docs/archived; Escape clears it; a row that comes in live while the box holds words obeys them too.
import { join } from "node:path";
import { ROOT } from "../../helpers/env";
import { expect, test } from "../../helpers/fixtures";
import { person, servers, tools } from "./front";

await servers.script();

/** A login that holds none of the words these tests type: a row's address has it, and a random one can hold "x" or "b". */
let logins = 0;
const login = () => `w${String(Date.now() * 10 + ++logins).replace(/\d/g, (d) => "acefghjknq"[+d])}`;

test("typing in Find filters the rows by title and address, says when none match, Escape clears it, and live rows obey it", async ({
  tab,
}) => {
  const p = await person(await servers.script(), login());
  const agent = tools(p.base, await p.token("Find test agent"));
  const make = async (title: string, slug?: string) =>
    ((await agent.call("create_document", { title, ...(slug ? { slug } : {}) })).data as { id: string }).id;
  await make("Groceries");
  await make("Trip to Lisbon");
  await make("Budget", "money-plan");
  const page = tab.page;
  tab.strict = true;
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  /** What the list shows, as the person sees it: the count, each visible row's title, and the no-match line. */
  const shown = () =>
    page.evaluate(
      `[document.getElementById("docs-count"), ...document.querySelectorAll("ol.rows > li[data-live] .title"), document.getElementById("docs-none")]
        .filter((e) => e.checkVisibility()).map((e) => e.innerText).join(" | ")`
    );
  await expect.poll(shown).toBe("3 documents | Budget | Trip to Lisbon | Groceries");

  // The box is left of New and Scratch, on the same line.
  const box = page.locator("input.find");
  const [find, neu] = [await box.boundingBox(), await page.locator(".make-buttons > :nth-child(2)").boundingBox()];
  expect(find!.x + find!.width).toBeLessThan(neu!.x);
  expect(Math.abs(find!.y - neu!.y)).toBeLessThan(2);

  await box.click();
  await page.keyboard.type("li");
  expect(await shown()).toBe("1 of 3 documents | Trip to Lisbon");
  // Every word must match, in any case.
  await page.keyboard.type(" X");
  expect(await shown()).toBe("0 of 3 documents | No documents match “li X”.");
  await page.screenshot({ path: join(ROOT, ".e2e/shots/find-none.png") });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  expect(await shown()).toBe("1 of 3 documents | Trip to Lisbon");

  // The address counts too: the slug, and the owner.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("money");
  expect(await shown()).toBe("1 of 3 documents | Budget");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(p.login.toUpperCase());
  expect(await shown()).toBe("3 of 3 documents | Budget | Trip to Lisbon | Groceries");

  // Live rows obey the words: one that doesn't match stays hidden, one that does shows, and a rename (which keeps its place) brings it in or takes it out.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("trip");
  await page.screenshot({ path: join(ROOT, ".e2e/shots/find-trip.png") });
  const other = await make("Taxes");
  const trip = await make("Trip to Kyoto");
  await expect.poll(shown).toBe("2 of 5 documents | Trip to Kyoto | Trip to Lisbon");
  await agent.call("rename_document", { document: other, title: "Trip to Oslo" });
  await expect.poll(shown).toBe("3 of 5 documents | Trip to Kyoto | Trip to Oslo | Trip to Lisbon");
  await agent.call("rename_document", { document: trip, title: "Kyoto notes" });
  await expect.poll(shown).toBe("2 of 5 documents | Trip to Oslo | Trip to Lisbon");

  // Escape clears the words, and every row shows; a second Escape leaves the box.
  await page.keyboard.press("Escape");
  expect(await box.inputValue()).toBe("");
  expect(await shown()).toBe("5 documents | Kyoto notes | Trip to Oslo | Budget | Trip to Lisbon | Groceries");
  expect(await page.evaluate<boolean>(`document.activeElement.matches("input.find")`)).toBe(true);
  await page.keyboard.press("Escape");
  expect(await page.evaluate<boolean>(`document.activeElement.matches("input.find")`)).toBe(false);

  // On a phone, the box takes the line's room left of New and Scratch, and the page doesn't scroll sideways.
  await page.setViewportSize({ width: 390, height: 760 });
  // (The agent's panel covers a phone's page: close it first.)
  await page.getByRole("button", { name: "Collapse (Esc)" }).click();
  await box.click();
  await page.keyboard.type("oslo");
  expect(await shown()).toBe("1 of 5 documents | Trip to Oslo");
  expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  expect((await box.boundingBox())!.width).toBeGreaterThan(120);
  await page.screenshot({ path: join(ROOT, ".e2e/shots/find-phone.png") });
});

test("Find stays fast with many rows: a key filters 2000 rows in well under a frame's worth of work", async ({ tab }) => {
  const p = await person(await servers.script(), login());
  const page = tab.page;
  tab.strict = true;
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  await p.make();
  await expect.poll(() => page.evaluate(`document.querySelectorAll("ol.rows > li[data-live]").length`)).toBe(1);
  // Copies of the row, as if the person had 2000 documents (each with its own title and address).
  await page.evaluate(`(() => {
    const list = document.querySelector("ol.rows"), row = list.querySelector("li[data-live]");
    for (let i = 0; i < 2000; i++) {
      const r = row.cloneNode(true);
      r.dataset.live = "doc:copy" + i;
      r.querySelector(".title").textContent = "Copy " + i;
      r.querySelector("a.doc").href = "/someone/copy-" + i;
      list.append(r);
    }
  })()`);
  await page.locator("input.find").click();
  const t0 = Date.now();
  await page.keyboard.type("1999");
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(
    await page.evaluate<string>(
      `[...document.querySelectorAll("ol.rows > li[data-live]")].filter((r) => r.checkVisibility()).map((r) => r.innerText.split("\\n")[0]).join()`
    )
  ).toBe("Copy 1999");
});

test("/docs/archived has the same Find: it filters the archived rows, a row archived meanwhile obeys it, Escape clears it", async ({
  tab,
}) => {
  const p = await person(await servers.script(), login());
  const agent = tools(p.base, await p.token("Find test agent"));
  for (const title of ["Old minutes", "Old budget", "Garden"]) {
    const d = (await agent.call("create_document", { title })).data as { id: string };
    await agent.call("documents", { op: "archive_document", document: d.id });
  }
  const page = tab.page;
  tab.strict = true;
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs/archived`);
  const shown = () =>
    page.evaluate<string>(
      `[document.getElementById("docs-count"), ...document.querySelectorAll("ol.rows > li[data-live] .title"), document.getElementById("docs-none")].filter((e) => e.checkVisibility()).map((e) => e.innerText).join(" | ")`
    );
  await expect.poll(shown).toBe("3 documents | Garden | Old budget | Old minutes");
  await page.locator("input.find").click();
  await page.keyboard.type("old b");
  expect(await shown()).toBe("1 of 3 documents | Old budget");
  // A live row: one more archived while the filter is on, that doesn't match, stays hidden.
  const d = (await agent.call("create_document", { title: "Trip" })).data as { id: string };
  await agent.call("documents", { op: "archive_document", document: d.id });
  await expect.poll(shown).toBe("1 of 4 documents | Old budget");
  await page.keyboard.type("zz");
  expect(await shown()).toBe("0 of 4 documents | No documents match “old bzz”.");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.locator("li:has-text('Old budget')").hover();
  await page.screenshot({ path: join(ROOT, ".e2e/shots/find-archived.png") });
  await page.keyboard.press("Escape");
  expect(await shown()).toBe("4 documents | Trip | Garden | Old budget | Old minutes");
});
