// view_page's capture in other sizes and modes: width, height and
// color_scheme change it, the view_page tool takes them, and a user in dark mode gets dark mode by default.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { capture, CAPTURES, DARK, expectColour, fontSite, openFonts as open, SCRIPT_DARK, SCRIPT_LIGHT, WHITE } from "./view-page";

await servers.script();
test.beforeAll(async () => { await fontSite(); });

test("width and height set the window it renders in; color_scheme dark renders dark mode, which the page's script sees too", CAPTURES, async ({ tab }) => {
  const ed = await open(tab);
  const small = await capture(ed, { width: 500, height: 300 });
  expect({ width: small.width, height: small.height, viewport: small.viewport }).toEqual({ width: 500, height: 300, viewport: { width: 500, height: 300 } });
  const dark = await capture(ed, { colorScheme: "dark" });
  expect(dark.colorScheme).toBe("dark");
  await expectColour(ed, dark.png!, 600, 30, DARK);
  await expectColour(ed, dark.png!, dark.width - 10, 10, SCRIPT_DARK);
});

test("the view_page tool, end to end (the scripted model, through the host), takes width, height and color_scheme: its words beside the picture", async ({ tab }) => {
  const ed = await open(tab);
  await ed.openAgent();
  const steps = JSON.stringify([{ tool: "view_page", args: { width: 640, height: 480, color_scheme: "dark" } }, { text: "Looked." }]);
  await ed.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify("Look @script " + steps)}; i.dispatchEvent(new Event("input")); i.focus(); })()`);
  await ed.page.keyboard.press("Enter");
  await until(() => ed.eval<boolean>(`[...document.querySelectorAll(".msg-tool")].some((e) => /Looked at the page/.test(e.textContent) && e.querySelector("img.shot")?.naturalWidth == 640)`), 10_000, "the tool's row, with a 640-pixel picture")
    .catch(async (e) => { throw new Error(`${(e as Error).message}: ${await ed.eval(`[...document.querySelectorAll(".msg-tool")].map((e) => e.textContent).join(" | ")`)}`); });
});

test("a user in dark mode gets dark mode by default, and light mode when asked; their agent's context says dark mode", CAPTURES, async ({ tab }) => {
  const ed = await open(tab, true);
  const theirs = await capture(ed, {});
  expect(theirs.colorScheme).toBe("dark");
  await expectColour(ed, theirs.png!, 600, 30, DARK);
  const light = await capture(ed, { colorScheme: "light" });
  expect(light.colorScheme).toBe("light");
  await expectColour(ed, light.png!, 600, 30, WHITE);
  await expectColour(ed, light.png!, light.width - 10, 10, SCRIPT_LIGHT);
  expect(await ed.eval<string>(`ergaPage.agentContext()`)).toContain("dark mode");
});
