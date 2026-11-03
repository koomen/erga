// view_page in other sizes and modes: width, height and color_scheme change the render, and the scripted model's
// view_page call takes them. A user in dark mode: their agent's context says so, and color_scheme dark renders it.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { CAPTURES, DARK, expectColour, fontSite, openFonts as open, SCRIPT_DARK, SCRIPT_LIGHT, WHITE } from "./view-page";

await servers.script();
test.beforeAll(async () => {
  await fontSite();
});

test(
  "width and height set the window it renders in; color_scheme dark renders dark mode, which the page's script sees too",
  CAPTURES,
  async ({ tab }) => {
    const { ed, tool } = await open(tab);
    const small = await tool("view_page", { width: 500, height: 300 });
    expect(small.text).toContain("Screenshot: 500×300px, top of the page");
    expect(small.text).toContain("Rendered in a 500×300px window, in light mode.");
    const dark = await tool("view_page", { color_scheme: "dark" });
    expect(dark.text).toContain("in dark mode");
    await expectColour(ed, dark.images[0], 600, 30, DARK);
    await expectColour(ed, dark.images[0], 1270, 10, SCRIPT_DARK);
  }
);

test("the view_page tool, end to end (the scripted model, through the host), takes width, height and color_scheme: its words beside the picture", async ({
  tab,
}) => {
  const { ed } = await open(tab);
  await ed.openAgent();
  const steps = JSON.stringify([{ tool: "view_page", args: { width: 640, height: 480, color_scheme: "dark" } }, { text: "Looked." }]);
  await ed.eval(
    `(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify("Look @script " + steps)}; i.dispatchEvent(new Event("input")); i.focus(); })()`
  );
  await ed.page.keyboard.press("Enter");
  await until(
    () =>
      ed.eval<boolean>(
        `[...document.querySelectorAll(".msg-tool")].some((e) => /Looked at the page/.test(e.textContent) && e.querySelector("img.shot")?.naturalWidth == 640)`
      ),
    10_000,
    "the tool's row, with a 640-pixel picture"
  ).catch(async (e) => {
    throw new Error(
      `${(e as Error).message}: ${await ed.eval(`[...document.querySelectorAll(".msg-tool")].map((e) => e.textContent).join(" | ")`)}`
    );
  });
});

test(
  "a user in dark mode: their agent's context says dark mode; the render is light unless color_scheme says dark",
  CAPTURES,
  async ({ tab }) => {
    const { ed, tool } = await open(tab, true);
    expect(await ed.eval<string>(`ergaPage.agentContext()`)).toContain("dark mode");
    const light = await tool("view_page", {});
    await expectColour(ed, light.images[0], 600, 30, WHITE);
    await expectColour(ed, light.images[0], 1270, 10, SCRIPT_LIGHT);
    const dark = await tool("view_page", { color_scheme: "dark" });
    await expectColour(ed, dark.images[0], 600, 30, DARK);
  }
);
