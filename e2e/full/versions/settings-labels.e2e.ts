// The settings say little: section titles, the switches' labels, and hover tips. No line of help under anything.
import { expect, servers, test } from "../../helpers/fixtures";
import { closeDrafts, draftDoc, openDocEditor } from "./settings";

await servers.short();
test.afterEach(closeDrafts);

test("the settings have Page details and Viewer settings, three labelled switches and a styled model menu; Document and Project have tips", async ({
  tab,
}) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Quiet notes", 2);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  await expect.poll(() => s.eval<boolean>(`!document.getElementById("ds-agent").hidden`)).toBe(true);
  const shown = (sel: string) =>
    s.eval<string[]>(
      `[...document.querySelectorAll("#doc-settings ${sel}")].filter((e) => e.offsetParent).map((e) => (e.tagName == "H3" ? e.firstChild : e).textContent.trim())`
    );
  expect(await shown("h3")).toEqual(["Page details", "Viewer settings", "Versions"]);
  expect(await shown(".ds-check")).toEqual([
    "Show the Erga header bar",
    "Viewers can use the Erga agent",
    "Viewers have access to the LLM API",
  ]);
  expect(await s.text("#ds-page-edit")).toBe("Edit");
  // No help under anything: the only lines of text are the description and the versions' foot.
  expect(await shown("p:not(#ds-page-desc):not(#ds-foot)")).toEqual([]);
  // The model's menu is drawn as Erga's other menus, not the browser's.
  expect(await s.eval<string>(`getComputedStyle(document.getElementById("ds-llm-model")).appearance`)).toBe("none");
  // Document and Project: each has a tip, which shows on hover.
  expect(await s.attr('#ds-kind [data-kind="document"]', "data-tip")).toBe("A document is one page, with its files beside it.");
  expect(await s.attr('#ds-kind [data-kind="project"]', "data-tip")).toBe("A project has pages, each with its own address.");
  const tipShown = () => s.eval<string>(`getComputedStyle(document.querySelector('#ds-kind [data-kind="project"]'), "::after").opacity`);
  expect(await tipShown()).toBe("0");
  const r = (await s.steadyRect('#ds-kind [data-kind="project"]'))!;
  await tab.page.mouse.move(r.x, r.y);
  await expect.poll(tipShown).toBe("1");
});
