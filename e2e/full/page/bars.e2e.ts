// The editor's glass: the two bars at the top (the breadcrumbs, the buttons), which fade to 55% while you type and stay
// where a click reaches them; and the agent, one element that grows out of its "e" circle and shrinks back into it.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

/** The mouse goes to the element's middle and clicks there. */
const clickOn = async (ed: Editor, selector: string) => {
  const box = (await ed.page.locator(selector).boundingBox())!;
  await ed.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await ed.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

/** The agent as it shows: its glass's size and corners against its box's, and which of its "e" and its insides show. */
const agent = (ed: Editor) =>
  ed.eval<{ circle: boolean; panel: boolean; e: string; inside: string; inert: boolean; shadow: boolean; one: boolean }>(`(() => {
    const box = document.getElementById("agent").getBoundingClientRect(), glass = document.querySelector(".agent-glass"), g = glass.getBoundingClientRect();
    const fab = document.getElementById("agent-fab"), card = document.querySelector(".agent-card"), cs = getComputedStyle(glass);
    return {
      circle: Math.round(g.width) == 44 && Math.round(g.height) == 44 && cs.borderRadius == "22px" && Math.round(g.left) == Math.round(box.left) && Math.round(g.bottom) == Math.round(box.bottom),
      panel: Math.round(g.width) == Math.round(box.width) && Math.round(g.height) == Math.round(box.height) && cs.borderRadius == "18px",
      e: getComputedStyle(fab).opacity,
      inside: getComputedStyle(card).opacity + " " + getComputedStyle(card).visibility,
      inert: card.inert,
      shadow: /rgba\\(0, 0, 0/.test(cs.boxShadow),
      one: glass.contains(fab) && glass.contains(card) && getComputedStyle(card).clipPath == "none",
    };
  })()`);

test("the agent opens out of its e circle and closes back into it: one glass element, the e or the insides showing, its shadow on it", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "empty");
  if (await ed.eval<boolean>(`document.body.classList.contains("agent-open")`)) await clickOn(ed, "#agent-close");
  const closed = { circle: true, panel: false, e: "1", inside: "0 hidden", inert: true, shadow: true, one: true };
  await expect.poll(() => agent(ed)).toEqual(closed);
  await clickOn(ed, "#agent-fab");
  await expect
    .poll(() => agent(ed))
    .toEqual({ circle: false, panel: true, e: "0", inside: "1 visible", inert: false, shadow: true, one: true });
  expect(await ed.eval<boolean>(`document.activeElement == document.getElementById("agent-input")`), "the box has the focus").toBe(true);
  await clickOn(ed, "#agent-close");
  await expect.poll(() => agent(ed)).toEqual(closed);
});

test("the bars fade to 55% while you type, stay where a click reaches them, and come back as the pointer moves", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "empty");
  await ed.clickEnd("[data-erga-text]:not(.erga-locked)");
  await ed.idle();
  const bars = () =>
    ed.eval<string>(`[".chrome-nav", ".chrome-top"].map((s) => getComputedStyle(document.querySelector(s)).opacity).join(" ")`);
  await expect.poll(bars).toBe("1 1");
  await ed.type("Milk");
  await expect.poll(bars).toBe("0.55 0.55");
  // Faded, a click on a button still reaches it.
  expect(
    await ed.eval<boolean>(`(() => {
      const b = document.getElementById("btn-new"), r = b.getBoundingClientRect();
      return getComputedStyle(b.closest(".chrome")).pointerEvents != "none" && b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    })()`)
  ).toBe(true);
  await ed.shows("Milk|");
  // A deliberate move of the pointer (more than 30 px, once the typing is over) brings them back.
  let x = 500;
  await expect
    .poll(async () => {
      x = x == 500 ? 560 : 500;
      await ed.page.mouse.move(x, 400, { steps: 6 });
      return bars();
    })
    .toBe("1 1");
});
