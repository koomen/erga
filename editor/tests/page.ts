// End-to-end check of the page editor: starts the host on a scratch copy of
// a fixture, drives headless Chrome with real clicks and keys, and reads the
// file back from disk after each edit. Runs the HTML and the Markdown fixture.
//   bun tests/page.ts [html|md] [--keep]   (--keep leaves the host running and prints its URL)

import { Browser, MOD, ROOT } from "./cdp";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const keep = process.argv.includes("--keep");
const only = process.argv.find((a) => a == "html" || a == "md" || a == "agent");
mkdirSync(`${ROOT}editor/screenshots`, { recursive: true });

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : "\n     " + detail}`);
  if (!ok) failures++;
};
const waitFor = async (f: () => boolean, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await Bun.sleep(50); } return f(); };

/** Starts a host on a scratch copy of a fixture and opens the editor on it. */
async function session(browser: Browser, fixture: string, fileName: string, env: Record<string, string> = {}) {
  const port = 4500 + Math.floor(Math.random() * 400);
  const dir = mkdtempSync(join(tmpdir(), "sw-page-"));
  cpSync(`${ROOT}editor/tests/fixtures/${fixture}`, dir, { recursive: true });
  const file = join(dir, fileName);
  const host = Bun.spawn(["bun", `${ROOT}editor/open.ts`, dir, "--port", String(port), "--no-open"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/doc`)).ok) break; } catch {}
    await Bun.sleep(100);
  }
  const p = await browser.page();
  await p.open(`http://127.0.0.1:${port}/`, { clear: false, width: 1100, height: 800 });
  await Bun.sleep(400);
  const F = `document.getElementById("frame").contentDocument`;
  const s = {
    p, F, port, dir,
    disk: () => readFileSync(file, "utf8"),
    write: (text: string) => writeFileSync(file, text),
    source: () => p.eval<string>("scratchPage.state.doc.toString()"),
    textOf: (selector: string) => p.eval<string>(`${F}.querySelector(${JSON.stringify(selector)}).textContent`),
    count: (selector: string) => p.eval<number>(`${F}.querySelectorAll(${JSON.stringify(selector)}).length`),
    /** Scrolls an element into view and returns a point inside it, `at` along its width. */
    async rectOf(selector: string, at = 0.5) {
      const r = await p.eval<{ x: number; y: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); const f = document.getElementById("frame").getBoundingClientRect(); return { x: f.left + r.left + r.width * ${at}, y: f.top + r.top + r.height / 2 }; })()`);
      await Bun.sleep(30);
      return r;
    },
    /** Clicks just past the end of an element's text. */
    async clickEnd(selector: string) {
      const r = await s.rectOf(selector, 0.98);
      await p.click(r.x + 2, r.y);
      await Bun.sleep(60);
    },
    /** Drags across the first `n` characters of an element's first text node. */
    async selectChars(selector: string, n: number) {
      const r = await p.eval<{ a: number; b: number; y: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const t = el.firstChild; const rg = ${F}.createRange(); rg.setStart(t, 0); rg.setEnd(t, ${n}); const r = rg.getBoundingClientRect(); const f = document.getElementById("frame").getBoundingClientRect(); return { a: f.left + r.left + 1, b: f.left + r.right, y: f.top + r.top + r.height / 2 }; })()`);
      await p.drag(r.a, r.y, r.b, r.y);
    },
    async close() {
      if (keep) {
        console.log(`\nhost kept at http://127.0.0.1:${port}/  (${dir})`);
        await new Promise(() => {});
      }
      p.close();
      host.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return s;
}

async function htmlScenario(browser: Browser) {
  console.log("\nHTML page");
  const s = await session(browser, "page", "index.html");
  const { p, F } = s;
  check("page rendered with units", (await s.count("[data-sw-id]")) >= 9);
  await p.eval(`${F}.body.style.background = "rgb(243, 236, 220)"`);
  await Bun.sleep(450);
  check("the shell's canvas follows the page's background", await p.eval<string>(`getComputedStyle(document.documentElement).backgroundColor`) == "rgb(243, 236, 220)" && await p.eval<boolean>(`document.body.classList.contains("page-light")`));
  await p.eval(`${F}.body.style.background = ""`);
  check("widget button is a plain button", await p.eval<boolean>(`!${F}.getElementById("bump").closest("[contenteditable]")`));
  check("units are the editing hosts", await p.eval<boolean>(`${F}.body.getAttribute("contenteditable") == null && ${F}.querySelector("h1").getAttribute("contenteditable") == "true"`));

  // Clicking non-editable content places no caret and does not move the model's selection.
  const before = await p.eval<string>("JSON.stringify(scratchPage.state.selection.main)");
  const box = await s.rectOf("#stats", 0.9);
  await p.click(box.x, box.y);
  await Bun.sleep(100);
  check("clicking a widget area focuses nothing", await p.eval<boolean>(`!${F}.activeElement || ${F}.activeElement == ${F}.body`));
  check("and leaves the selection alone", (await p.eval<string>("JSON.stringify(scratchPage.state.selection.main)")) == before);

  await s.clickEnd("h1");
  await p.type(" v2");
  await Bun.sleep(100);
  check("typing updates the page", (await s.textOf("h1")) == "Launch notes v2");
  // Arrow keys cross into the next unit.
  await p.key("ArrowRight");
  await Bun.sleep(60);
  check("ArrowRight at the end enters the next paragraph", await p.eval<boolean>(`${F}.activeElement.matches("p.lede")`));
  await p.key("ArrowUp");
  await Bun.sleep(60);
  check("ArrowUp returns to the heading", await p.eval<boolean>(`${F}.activeElement.matches("h1")`));
  check("typing updates the source", (await s.source()).includes("<h1>Launch notes v2</h1>"));
  check("saved to disk", await waitFor(() => s.disk().includes("<h1>Launch notes v2</h1>")));

  await s.clickEnd("p.lede em");
  await p.type(" & fun");
  await Bun.sleep(100);
  check("entity escaped in source", (await s.source()).includes("<em>cool &amp; fun</em>"), (await s.source()).match(/<p class="lede">.*<\/p>/)?.[0]);
  check("entity decoded on page", (await s.textOf("p.lede em")) == "cool & fun");

  const r = await s.rectOf("#bump");
  await p.click(r.x, r.y);
  await Bun.sleep(100);
  check("widget button works inside the editor", (await s.textOf("#count")) == "1");

  await s.clickEnd("li:first-child");
  await p.key("Enter");
  await Bun.sleep(80);
  check("Enter creates an empty sibling item", (await s.count("li")) == 3 && (await s.textOf("li:nth-child(2)")) == "");
  await p.type("Nicer docs");
  await Bun.sleep(100);
  check("typing fills it", (await s.textOf("li:nth-child(2)")) == "Nicer docs");
  check("source has the new item", /<li>Faster builds<\/li>\n\s*<li>Nicer docs<\/li>/.test(await s.source()));
  await p.key("Home");
  await Bun.sleep(80);
  await p.key("Backspace");
  await Bun.sleep(100);
  check("Backspace at start joins", (await s.count("li")) == 2 && (await s.textOf("li:first-child")) == "Faster buildsNicer docs");

  await p.key("z", MOD.Meta);
  await Bun.sleep(80);
  check("undo restores the split", (await s.count("li")) == 3, `li count ${await s.count("li")}`);
  await p.key("z", MOD.Meta);
  await p.key("z", MOD.Meta);
  await Bun.sleep(120);
  check("undo restores the list", (await s.count("li")) == 2 && (await s.textOf("li:first-child")) == "Faster builds");

  await s.selectChars("li:last-child", 1);
  await p.key("b", MOD.Meta);
  await Bun.sleep(100);
  check("⌘B wraps the selection in <strong>", /<li><strong>A<\/strong> <strong>new<\/strong> editor<\/li>/.test(await s.source()), (await s.source()).match(/<li>.*editor<\/li>/)?.[0]);
  await p.key("b", MOD.Meta);
  await Bun.sleep(100);
  check("⌘B again unwraps", /<li>A <strong>new<\/strong> editor<\/li>/.test(await s.source()));

  check("svg text is not editable", await p.eval<boolean>(`!${F}.querySelector("svg text").closest("[data-sw-id]")`));
  await s.clickEnd("pre");
  await p.type(" // ok");
  await Bun.sleep(100);
  check("pre edits land after the entity", (await s.source()).includes("const x = 1 &lt; 2; // ok</pre>"), (await s.source()).match(/<pre>[\s\S]*?<\/pre>/)?.[0]);

  await waitFor(() => s.disk().includes("// ok"));
  s.write(s.disk().replace("Where the leads go.", "Where the leads went."));
  await Bun.sleep(400);
  check("disk edits reach the page", await waitFor(() => false, 200) || (await s.textOf("figcaption")) == "Where the leads went.");
  // Added text: the green highlights (any fade level). Removed text: the notches' hover text.
  const marks = () => p.eval<{ added: string[]; gone: string[] }>(`(() => { const w = document.getElementById("frame").contentWindow; const added = []; for (let i = 0; i < 6; i++) { const h = w.CSS.highlights.get("sw-add-" + i); if (h) added.push(...[...h].map((r) => r.toString())); } return { added, gone: [...${F}.querySelectorAll("sw-del sw-tip")].map((e) => e.textContent) }; })()`);
  let m = await marks();
  check("disk edits patch the page in place", (await s.count("[data-sw-id]")) >= 9 && !(await p.eval<boolean>(`!!${F}.querySelector("figcaption.sw-flash")`)));
  check("the added word is highlighted, exactly", m.added.join("|") == "went", JSON.stringify(m));
  check("the removed word is marked where it was", m.gone.join("|") == "go", JSON.stringify(m));
  check("marks don't touch the page's text", (await s.textOf("figcaption")) == "Where the leads went.");
  await Bun.sleep(3200);
  m = await marks();
  check("with tracking off, the marks fade away", !m.added.length && !m.gone.length, JSON.stringify(m));

  // Typing and an edit on disk at the same moment: both survive.
  await s.clickEnd("h1");
  await p.type(" now");
  s.write(s.disk().replace("Where the leads went.", "Where the leads go now."));
  await waitFor(() => s.disk().includes(" now</h1>") && s.disk().includes("leads go now."), 3000);
  check("concurrent disk edit merges with unsaved typing", s.disk().includes(" now</h1>") && s.disk().includes("leads go now."), s.disk().match(/<h1>.*<\/h1>|<figcaption>.*<\/figcaption>/g)?.join(" | "));
  check("and the page shows both", (await s.textOf("h1")).endsWith(" now") && (await s.textOf("figcaption")) == "Where the leads go now.");
  m = await marks();
  check("marks follow typing elsewhere", m.added.some((x) => /go now/.test(x)), JSON.stringify(m));
  await p.key("z", MOD.Meta);
  await Bun.sleep(100);
  check("undo takes back the disk edit on its own", (await s.textOf("figcaption")) == "Where the leads went." && (await s.textOf("h1")).endsWith(" now"));
  await p.key("z", MOD.Meta | MOD.Shift);
  await Bun.sleep(100);

  // Track changes: every change, yours or from disk, stays marked as a diff from when it was switched on.
  await p.eval(`document.getElementById("btn-track").click()`);
  await Bun.sleep(100);
  await s.clickEnd("h1");
  await p.type(" too");
  s.write(s.disk().replace("Where the leads go now.", "Where leads go now."));
  await Bun.sleep(3500);
  m = await marks();
  check("tracking keeps your edits and the disk's marked", m.added.some((x) => /too/.test(x)) && m.gone.join("|").trim() == "the", JSON.stringify(m));
  await p.key("Backspace"); await p.key("Backspace"); await p.key("Backspace"); await p.key("Backspace");
  await Bun.sleep(150);
  m = await marks();
  check("it's a diff: typing and deleting leaves no mark", !m.added.some((x) => /too/.test(x)) && m.gone.length == 1, JSON.stringify(m));
  await p.type("s");
  await Bun.sleep(150);
  m = await marks();
  check("adding a letter to a word marks just the letter", m.added.includes("s") && !m.added.some((x) => /nows/.test(x)) && m.gone.length == 1, JSON.stringify(m));
  await p.key("Backspace");
  await Bun.sleep(100);
  await p.eval(`document.getElementById("btn-track").click()`);
  await Bun.sleep(100);
  m = await marks();
  check("switching tracking off clears the marks", !m.added.length && !m.gone.length, JSON.stringify(m));
  await Bun.sleep(500);

  const stale = await fetch(`http://127.0.0.1:${s.port}/api/doc`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "clobbered", version: 1 }) });
  check("a save from a stale version is refused", stale.status == 409 && !s.disk().includes("clobbered"));

  // Another file in the folder changes: the page renders again and picks it up.
  const css = join(s.dir, "style.css");
  writeFileSync(css, readFileSync(css, "utf8") + "\nh1 { letter-spacing: 3px; }\n");
  check("a stylesheet change reaches the page", await (async () => { for (let i = 0; i < 40; i++) { if (await p.eval<string>(`getComputedStyle(${F}.querySelector("h1")).letterSpacing`) == "3px") return true; await Bun.sleep(50); } return false; })());

  await p.key("p", MOD.Meta | MOD.Shift);
  await Bun.sleep(300);
  check("source view shows the file", await p.eval<boolean>(`document.body.classList.contains("source")`) && (await s.source()).includes("Where leads go now."));
  await p.key("p", MOD.Meta | MOD.Shift);
  await Bun.sleep(400);
  await s.clickEnd("h1");
  await Bun.sleep(300);
  await p.screenshot(`${ROOT}editor/screenshots/page-html.png`);
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

async function mdScenario(browser: Browser) {
  console.log("\nMarkdown page");
  const s = await session(browser, "md", "index.md");
  const { p } = s;
  check("front matter is not rendered", !(await s.textOf("#sw-article")).includes("title:"));
  check("units rendered", (await s.count("[data-sw-id]")) >= 8);

  await s.clickEnd("h1");
  await p.type(" 2026");
  await Bun.sleep(100);
  check("heading edit lands in the source line", (await s.source()).includes("\n# Field notes 2026\n"));
  check("saved to disk", await waitFor(() => s.disk().includes("# Field notes 2026")));

  // Typing Markdown syntax stays literal.
  await s.clickEnd("p:nth-of-type(1) strong");
  await p.type("*");
  await Bun.sleep(100);
  check("typed asterisk is escaped", (await s.source()).includes("**bold\\***"), (await s.source()).match(/A first.*\n/)?.[0]);
  check("and shown literally", (await s.textOf("p:nth-of-type(1) strong")) == "bold*");

  // Enter at the end of a paragraph makes a new one; typing fills it.
  await s.clickEnd("blockquote p");
  await p.key("Enter");
  await Bun.sleep(80);
  await p.type("Mapping is deterministic.");
  await Bun.sleep(120);
  check("Enter in a quote continues it", /> Typing never waits\.\n> ?\n> Mapping is deterministic\./.test(await s.source()), (await s.source()).match(/> [\s\S]*?\n\n/)?.[0]);
  check("quote shows two paragraphs", (await s.count("blockquote p")) == 2);

  // Enter in a list item continues the list.
  await s.clickEnd("li:last-child p");
  await p.key("Enter");
  await Bun.sleep(80);
  await p.type("Write it down");
  await Bun.sleep(120);
  check("Enter continues the list", (await s.source()).includes("- Call *Sam* back\n- Write it down\n"), (await s.source()).match(/- Call[\s\S]{0,40}/)?.[0]);
  check("list shows three items", (await s.count("li")) == 3);
  await p.key("Home");
  await Bun.sleep(80);
  await p.key("Backspace");
  await Bun.sleep(120);
  check("Backspace removes the marker", /- Call \*Sam\* back\n\s*Write it down/.test(await s.source()), (await s.source()).match(/- Call[\s\S]{0,40}/)?.[0]);

  // Bold via ⌘B.
  await s.selectChars("h2", 6);
  await p.key("b", MOD.Meta);
  await Bun.sleep(100);
  check("⌘B adds ** in Markdown", (await s.source()).includes("## **Things** to do"), (await s.source()).match(/## .*\n/)?.[0]);

  // Code block edits are literal.
  await s.clickEnd("pre");
  await p.type(" // *not emphasis*");
  await Bun.sleep(100);
  check("code edits are not escaped", (await s.source()).includes("const answer = 42; // *not emphasis*\n```"), (await s.source()).match(/```js[\s\S]*?```/)?.[0]);

  // Table cell: click into the text, End goes to the end of the cell.
  const td = await s.rectOf("td", 0.1);
  await p.click(td.x, td.y);
  await p.key("End");
  await p.type(" Lovelace");
  await Bun.sleep(100);
  check("table cell edit", /\| Ada\s+Lovelace\s*\| Math\s*\|/.test(await s.source()), (await s.source()).match(/\| Ada.*\n/)?.[0]);

  await s.clickEnd("h1");
  await Bun.sleep(300);
  await p.screenshot(`${ROOT}editor/screenshots/page-md.png`);
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

/** Send never refuses silently: it always says why it can't send. */
async function agentOffScenario(browser: Browser) {
  console.log("\nAgent off");
  const s = await session(browser, "page", "index.html", { ANTHROPIC_API_KEY: "", SCRATCHWORK_AGENT_ENV_FILE: "/nonexistent/.env" });
  const { p } = s;
  await p.key("j", MOD.Meta);
  await Bun.sleep(700);
  const state = () => p.eval<{ hint: string; hidden: boolean; disabled: string | null; title: string }>(`(() => { const h = document.getElementById("agent-hint"), b = document.getElementById("agent-send"); return { hint: h.textContent, hidden: h.hidden, disabled: b.getAttribute("aria-disabled"), title: b.title }; })()`);
  let st = await state();
  check("with no key, the panel says the agent is off and why", !st.hidden && /agent is off/.test(st.hint) && /ANTHROPIC_API_KEY/.test(st.hint), JSON.stringify(st));
  check("and Send carries the same reason", st.disabled == "true" && st.title == st.hint, JSON.stringify(st));
  await p.type("hello");
  await p.key("Enter");
  await Bun.sleep(100);
  st = await state();
  check("typing and sending still explains instead of doing nothing", !st.hidden && /ANTHROPIC_API_KEY/.test(st.hint) && (await p.eval<string>(`document.getElementById("agent-input").value`)) == "hello");
  await s.close();
}

/** No dark mode: with the system set to dark, the Markdown page and the shell stay light. */
async function lightOnlyScenario(browser: Browser) {
  console.log("\nSystem in dark mode");
  const s = await session(browser, "md", "index.md");
  const { p, F } = s;
  await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await Bun.sleep(300);
  check("the Markdown page stays light", (await p.eval<string>(`getComputedStyle(${F}.body).backgroundColor`)) == "rgb(255, 255, 255)");
  check("and so does the shell", (await p.eval<string>(`getComputedStyle(document.documentElement).backgroundColor`)) == "rgb(255, 255, 255)");
  check("there is no theme toggle", !(await p.eval<boolean>(`!!document.getElementById("btn-theme")`)));
  await s.close();
}

async function agentEmptyScenario(browser: Browser) {
  console.log("\nAgent, empty message");
  const s = await session(browser, "page", "index.html", { ANTHROPIC_API_KEY: "sk-ant-test-not-used", SCRATCHWORK_AGENT_ENV_FILE: "/nonexistent/.env" });
  const { p } = s;
  await p.key("j", MOD.Meta);
  await Bun.sleep(700);
  check("an empty message: Send says to type one", await p.eval<boolean>(`(() => { const b = document.getElementById("agent-send"); return b.getAttribute("aria-disabled") == "true" && /Type a message/.test(b.title); })()`));
  await p.key("Enter");
  await Bun.sleep(100);
  check("and pressing it says so in the panel", await p.eval<boolean>(`(() => { const h = document.getElementById("agent-hint"); return !h.hidden && /Type a message/.test(h.textContent); })()`));
  await p.type("x");
  await Bun.sleep(50);
  check("typing enables it and clears the hint", await p.eval<boolean>(`document.getElementById("agent-send").getAttribute("aria-disabled") == "false" && document.getElementById("agent-hint").hidden`));

  // The pane's open or closed state survives a reload.
  const paneOpen = () => p.eval<boolean>(`document.body.classList.contains("agent-open") && !document.getElementById("agent").inert`);
  await p.eval(`location.reload()`);
  await Bun.sleep(150);
  check("an open pane is still open after a reload, from the first frame", await paneOpen());
  await Bun.sleep(600);
  await p.key("j", MOD.Meta);
  await Bun.sleep(100);
  await p.eval(`location.reload()`);
  await Bun.sleep(700);
  check("a collapsed pane stays collapsed after a reload", !(await paneOpen()) && (await p.eval<string>(`document.getElementById("agent-fab").getAttribute("aria-expanded")`)) == "false");
  await s.close();
}

const browser = await Browser.launch();
try {
  if (!only || only == "html") await htmlScenario(browser);
  if (!only || only == "md") { await mdScenario(browser); await lightOnlyScenario(browser); }
  if (!only || only == "agent") { await agentOffScenario(browser); await agentEmptyScenario(browser); }
} finally {
  if (!keep) browser.close();
}
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
