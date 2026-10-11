// A live check of the document agent against the real model: it edits the page and its stylesheet,
// and the edits reach the open page without a reload and the disk; it is a participant (a badge on its owner's
// avatar); its last change can be undone; it draws a diagram and looks at it; it fixes a paragraph broken on disk. It
// calls the real API, so it costs a little, and it skips itself unless asked for: the gate and `bun run test --all`
// never run it.
//
//   ERGA_LIVE_AGENT=1 ANTHROPIC_API_KEY=sk-ant-... bun run test:e2e e2e/page/agent-live.e2e.ts
//
// (The test environment drops every secret, e2e/env.ts; with ERGA_LIVE_AGENT=1 it keeps this key, for this file's
// own server only.)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { F, openEditor, W, type Editor } from "../../editor";
import { expect, servers, test } from "../../fixtures";

const KEY = process.env.ERGA_LIVE_AGENT_KEY;
const own = () => servers.of("agent-live", { processEnv: { ANTHROPIC_API_KEY: KEY ?? "" } });
if (KEY) await own();

/** The real model takes up to a minute or two for a turn; each test has a few. */
const LIVE = { timeout: 300_000, skip: KEY ? false : "a live check: ERGA_LIVE_AGENT=1 and ANTHROPIC_API_KEY run it" };
const TURN_MS = 120_000;

const working = (ed: Editor) => ed.eval<boolean>(`document.getElementById("agent-send").classList.contains("stop")`);
/** Sends `text` to the agent and waits until it has finished. */
async function ask(ed: Editor, text: string) {
  await ed.openAgent();
  await ed.type(text);
  await ed.page.keyboard.press("Enter");
  await expect.poll(() => working(ed)).toBe(true);
  await expect.poll(() => working(ed), { timeout: TURN_MS }).toBe(false);
}
async function open(tab: Parameters<typeof openEditor>[0]) {
  await tab.page.setViewportSize({ width: 1280, height: 800 });
  const ed = await openEditor(tab, await own(), "page", { agent: true });
  const info = await (await fetch(`${ed.address}/api/agent`)).json() as { enabled: boolean; reason?: string };
  expect(info.enabled, info.reason).toBe(true);
  await ed.frame(`${W}.__marker = 1`);
  return ed;
}

test("two edits reach the open page without a reload and the disk; the agent's badge is on its owner's avatar; undo takes back its last change only", LIVE, async ({ tab }) => {
  const ed = await open(tab);
  await ed.openAgent();
  expect(await ed.eval<boolean>(`document.body.classList.contains("agent-open") && document.activeElement.id == "agent-input"`)).toBe(true);
  await ask(ed, `Change the first heading to "Notes from the field", and add a list item "Buy seeds" at the end of the first list.`);
  expect(await ed.eval<string | null>(`localStorage.getItem("erga:agent-draft:v1")`), "sending clears the saved draft").toBe(null);
  await expect.poll(() => { const d = ed.disk(); return d.includes("<h1>Notes from the field</h1>") && d.includes("<li>Buy seeds</li>"); }).toBe(true);
  expect(await ed.textOf("h1")).toBe("Notes from the field");
  expect(await ed.textOf("ul")).toContain("Buy seeds");
  expect(await ed.frame<boolean>(`${W}.__marker == 1`), "without a reload").toBe(true);
  expect(await ed.eval<boolean>(`[...document.querySelectorAll(".msg-tool")].some((e) => /Edited/.test(e.textContent))`), "the panel shows the edit").toBe(true);
  expect(await ed.eval<boolean>(`!!document.querySelector(".msg-assistant")?.textContent.trim()`), "and a reply").toBe(true);
  expect(await ed.eval<boolean>(`[...document.querySelectorAll(":is(#people, #me) .agent-badge")].some((e) => /agent/.test(e.dataset.tip))`), "its badge on its owner's avatar").toBe(true);
  // (No caret of its own on the page: e2e/suite/browser-agent.e2e.ts.)
  const before = await ed.eval<string>(`ergaPage.state.doc.toString()`);
  expect(await ed.eval<string>(`document.getElementById("agent-undo").getAttribute("aria-disabled")`)).toBe("false");
  await ed.eval(`document.getElementById("agent-undo").click()`);
  await expect.poll(() => ed.eval<string>(`ergaPage.state.doc.toString()`)).not.toBe(before);
  const undone = await ed.eval<string>(`ergaPage.state.doc.toString()`);
  expect(undone.includes("Notes from the field") && undone.includes("Buy seeds"), undone.slice(0, 400)).toBe(false);
  const log = await (await fetch(`${ed.address}/api/agent`)).json() as { log?: { items: unknown[] } };
  expect(log.log?.items.length ?? 0, "the server keeps the transcript").toBeGreaterThanOrEqual(2);
});

test("a stylesheet edit reaches the disk and the page; a diagram from the agent appears without a refresh, and it looks at it", LIVE, async ({ tab }) => {
  const ed = await open(tab);
  await ask(ed, `Make the h1 color red (#c00) in style.css.`);
  expect(readFileSync(join(ed.dir, "style.css"), "utf8")).toMatch(/#c00|red/i);
  await expect.poll(() => ed.frame<string | null>(`(() => { const h = ${F}?.querySelector("h1"); return h && getComputedStyle(h).color; })()`)).toBe("rgb(204, 0, 0)");
  await ask(ed, `Add a small inline SVG bar chart with id "chart" right after the first list. Plain SVG, no script. Then look at it on the page to check it renders.`);
  await expect.poll(() => ed.frame<boolean>(`!!${F}.getElementById("chart")`)).toBe(true);
  expect(await ed.eval<boolean>(`document.getElementById("refresh-pill").hidden`), "no refresh pill once it finishes").toBe(true);
  expect(await ed.eval<boolean>(`[...document.querySelectorAll(".msg-tool")].some((e) => /Looked at the page/.test(e.textContent) && e.querySelector("img.shot")?.naturalWidth > 0)`),
    await ed.eval<string>(`[...document.querySelectorAll(".msg-tool")].map((e) => e.textContent).join(" | ")`)).toBe(true);
});

test("a paragraph broken on disk: clicking it offers the agent's help, and Fix with agent repairs it with its text untouched", LIVE, async ({ tab }) => {
  const ed = await open(tab);
  writeFileSync(ed.file, readFileSync(ed.file, "utf8").replace("things &amp; ship them.", "things</h2> &amp; ship them."));
  await expect.poll(() => ed.frame<boolean>(`!!${F}.querySelector("p.lede.erga-locked")`)).toBe(true);
  const at = await ed.rectOf("p.lede", 0.3);
  // (Clicked again until it shows: a toast already up keeps its minimum time first.)
  await expect.poll(async () => { await ed.click(at.x, at.y); return ed.eval<boolean>(`!!document.querySelector("#toast.show .toast-fix") && /h2/.test(document.getElementById("toast").textContent)`); }, { timeout: 10_000 }).toBe(true);
  await ed.eval(`document.querySelector("#toast .toast-fix").click()`);
  await expect.poll(() => working(ed)).toBe(true);
  await expect.poll(() => working(ed), { timeout: TURN_MS }).toBe(false);
  await expect.poll(() => ed.frame<boolean>(`!!${F}.querySelector("p.lede") && !${F}.querySelector("p.lede").classList.contains("erga-locked")`)).toBe(true);
  expect(readFileSync(ed.file, "utf8").match(/<p class="lede">[\s\S]*?<\/p>/)?.[0]).toBe(`<p class="lede">Build <em>cool</em> things &amp; ship them. This paragraph has <a href="https://example.com">a link</a> and <code>code</code>.</p>`);
});
