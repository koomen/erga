// End-to-end check of the page editor: starts the host on a scratch copy of
// a fixture, drives headless Chrome with real clicks and keys, and reads the
// file back from disk after each edit. Runs the HTML and the Markdown
// fixture. (Two people at once: tests/suite, `bun tests/suite/run.ts --suite browser`.)
//   bun tests/page.ts [html|select|md|format|view|agent|reload|enter|join|indent] [--keep]   (--keep leaves the host running and prints its URL)
// covers: src/page/editor.ts src/page/main.ts src/page/manuscript.ts src/page/markdown.ts src/page/merge.ts src/page/collab.ts src/page/remote.ts src/page/frame.ts src/page/bridge.ts src/page/layout.ts room.ts src/room/ host.ts agent.ts workspace.ts page.html

import { Browser, MOD, ROOT, SHOTS } from "./cdp";
import { startHost } from "./host";
import { F, frameAt, tab } from "./tab";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { testJobs } from "./cores";

const keep = process.argv.includes("--keep");
const only = process.argv.find((a) => a == "html" || a == "select" || a == "md" || a == "agent" || a == "format" || a == "view" || a == "reload" || a == "enter" || a == "join" || a == "indent");

// Scenarios run at once, each in its own host and tab; each one's lines are
// collected and printed together when it finishes.
const out = new AsyncLocalStorage<string[]>();
const say = (line: string) => { const b = out.getStore(); if (b) b.push(line); else console.log(line); };
let failures = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  const d = typeof detail == "string" ? detail : JSON.stringify(detail);
  say(`${ok ? "ok  " : "FAIL"} ${name}${ok || !d ? "" : "\n     " + d}`);
  if (!ok) failures++;
};
const waitFor = async (f: () => boolean, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await Bun.sleep(15); } return f(); };
/** Waits until an async condition holds (or `ms` passes); returns whether it did. Never a fixed pause. */
const until = async (f: () => Promise<unknown> | unknown, ms = 3000) => { const t = Date.now(); for (;;) { try { if (await f()) return true; } catch { /* not yet */ } if (Date.now() - t > ms) return false; await Bun.sleep(15); } };
/** The editor's timers run at this fraction of real time here (src/page/editor.ts, \`ms\`), so timed behaviour is checked without sitting through it. */
const TIMESCALE = 0.1;
const T = (ms: number) => ms * TIMESCALE;
/** After a (re)load: the shell is up, the page rendered, the agent's status in. */
const loaded = (p: Awaited<ReturnType<Browser["page"]>>) => until(async () => await p.eval<boolean>(`!!window.ergaPage && !!document.getElementById("agent-model").textContent`) && await p.frame<boolean>(`!!${F}?.querySelector("[data-erga-id]")`), 10_000);

/** Starts a host on a scratch copy of a fixture and opens the editor on it. */
async function session(browser: Browser, fixture: string, fileName: string, env: Record<string, string> = {}, query = "", timescale = TIMESCALE) {
  const dir = mkdtempSync(join(tmpdir(), "erga-page-"));
  cpSync(`${ROOT}tests/fixtures/${fixture}`, dir, { recursive: true });
  const file = join(dir, fileName);
  const host = await startHost(dir, { env });
  const p = await browser.page();
  await p.open(`${host.base}${query}#edit`, { clear: false, width: 1100, height: 800, timescale, agent: false });
  await until(async () => await p.eval<boolean>(`!!window.ergaPage`) && await p.frame<boolean>(`!!${F}?.querySelector("[data-erga-id]")`), 10_000);
  // The page's own fonts too: text measured before they load moves when they do.
  await p.frame(`${F}.fonts.ready.then(() => true)`);
  await p.settle();
  const s = {
    ...tab(p),
    base: host.base, dir,
    disk: () => readFileSync(file, "utf8"),
    write: (text: string) => writeFileSync(file, text),
    async close() {
      if (keep) {
        console.log(`\nhost kept at ${host.base}/  (${dir})`);
        await new Promise(() => {});
      }
      p.close();
      await host.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return s;
}


async function htmlScenario(browser: Browser) {
  say("\nHTML page");
  const s = await session(browser, "page", "index.html");
  const { p, F } = s;
  check("page rendered with units", (await s.count("[data-erga-id]")) >= 9);
  await p.frame(`${F}.body.style.background = "rgb(243, 236, 220)"`);
  check("the shell's canvas follows the page's background", await until(async () => await p.eval<string>(`getComputedStyle(document.documentElement).backgroundColor`) == "rgb(243, 236, 220)" && await p.eval<boolean>(`document.documentElement.classList.contains("page-light")`)));
  await p.frame(`${F}.body.style.background = ""`);
  check("widget button is a plain button", await p.frame<boolean>(`!${F}.getElementById("bump").closest("[contenteditable]")`));
  check("units are the editing hosts", await p.frame<boolean>(`${F}.body.getAttribute("contenteditable") == null && ${F}.querySelector("h1").getAttribute("contenteditable") == "true"`));

  // Clicking non-editable content places no caret and does not move the model's selection.
  const before = await p.eval<string>("JSON.stringify(ergaPage.state.selection.main)");
  const box = await s.rectOf("#stats", 0.9);
  await p.click(box.x, box.y);
  await Bun.sleep(100);
  check("clicking a widget area focuses nothing", await p.frame<boolean>(`!${F}.activeElement || ${F}.activeElement == ${F}.body`));
  check("and leaves the selection alone", (await p.eval<string>("JSON.stringify(ergaPage.state.selection.main)")) == before);

  await s.clickEnd("h1");
  await p.type(" v2");
  await Bun.sleep(100);
  check("typing updates the page", (await s.textOf("h1")) == "Launch notes v2");
  // Arrow keys cross into the next unit.
  await p.key("ArrowRight");
  await Bun.sleep(60);
  check("ArrowRight at the end enters the next paragraph", await p.frame<boolean>(`${F}.activeElement.matches("p.lede")`));
  await p.key("ArrowUp");
  await Bun.sleep(60);
  check("ArrowUp returns to the heading", await p.frame<boolean>(`${F}.activeElement.matches("h1")`));
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

  check("svg text is not editable", await p.frame<boolean>(`!${F}.querySelector("svg text").closest("[data-erga-id]")`));
  await s.clickEnd("pre");
  await p.type(" // ok");
  await Bun.sleep(100);
  check("pre edits land after the entity", (await s.source()).includes("const x = 1 &lt; 2; // ok</pre>"), (await s.source()).match(/<pre>[\s\S]*?<\/pre>/)?.[0]);

  await waitFor(() => s.disk().includes("// ok"));
  s.write(s.disk().replace("Where the leads go.", "Where the leads went."));
  check("disk edits reach the page", await until(async () => (await s.textOf("figcaption")) == "Where the leads went."));
  const marks = s.marks;
  let m = await marks();
  check("disk edits patch the page in place", (await s.count("[data-erga-id]")) >= 9 && !(await p.frame<boolean>(`!!${F}.querySelector("figcaption.erga-flash")`)));
  check("the added word is highlighted, exactly", m.added.join("|") == "went", JSON.stringify(m));
  check("the removed word is marked where it was, and who removed it", m.gone.join("|") == "Edited on diskgo", JSON.stringify(m));
  check("marks don't touch the page's text", (await s.textOf("figcaption")) == "Where the leads went.");
  check("with tracking off, the marks fade away", await until(async () => { m = await marks(); return !m.added.length && !m.gone.length; }, T(3200) + 2000), JSON.stringify(m));

  // Typing and an edit on disk at the same moment: both survive.
  await s.clickEnd("h1");
  await p.type(" now");
  s.write(s.disk().replace("Where the leads went.", "Where the leads go now."));
  // Marks are brief (and the timescale makes them briefer): look as the edit lands.
  check("marks follow typing elsewhere", await until(async () => { m = await marks(); return m.added.some((x) => /go now/.test(x)); }, 3000), JSON.stringify(m));
  await waitFor(() => s.disk().includes(" now</h1>") && s.disk().includes("leads go now."), 3000);
  check("concurrent disk edit merges with unsaved typing", s.disk().includes(" now</h1>") && s.disk().includes("leads go now."), s.disk().match(/<h1>.*<\/h1>|<figcaption>.*<\/figcaption>/g)?.join(" | "));
  check("and the page shows both", (await s.textOf("h1")).endsWith(" now") && (await s.textOf("figcaption")) == "Where the leads go now.");
  await p.key("z", MOD.Meta);
  await Bun.sleep(100);
  check("⌘Z takes back your typing, never the disk's edit", !(await s.textOf("h1")).endsWith(" now") && (await s.textOf("figcaption")) == "Where the leads go now.", `${await s.textOf("h1")} | ${await s.textOf("figcaption")}`);
  await p.key("z", MOD.Meta | MOD.Shift);
  await Bun.sleep(100);
  check("and ⌘⇧Z brings it back", (await s.textOf("h1")).endsWith(" now"));

  // Track changes: every change, yours or from disk, stays marked as a diff from when it was switched on.
  await p.eval(`document.getElementById("btn-track").click()`);
  await Bun.sleep(100);
  await s.clickEnd("h1");
  await p.type(" too");
  s.write(s.disk().replace("Where the leads go now.", "Where leads go now."));
  check("tracking keeps your edits and the disk's marked", await until(async () => { m = await marks(); return m.added.some((x) => /too/.test(x)) && m.gone.join("|").trim() == "Edited on diskthe"; }, 4000), JSON.stringify(m));
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


  // A change outside the text (a new diagram) can't be patched in: the page renders again on its own.
  s.write(s.disk().replace("<h2>What changed</h2>", `<svg id="diagram" width="80" height="20"><rect width="80" height="20" fill="#c00"/></svg>\n    <h2>What changed</h2>`));
  check("a diagram added on disk shows up without a reload", await until(() => p.frame<boolean>(`!!${F}.getElementById("diagram")`)));
  await until(() => p.frame<boolean>(`!!${F}.querySelector("[data-erga-id]")`));
  check("and the page still edits", (await s.count("[data-erga-id]")) >= 9);

  // Another file in the folder changes: the page renders again and picks it up.
  const css = join(s.dir, "style.css");
  writeFileSync(css, readFileSync(css, "utf8") + "\nh1 { letter-spacing: 3px; }\n");
  check("a stylesheet change reaches the page", await until(() => p.frame<boolean>(`getComputedStyle(${F}.querySelector("h1")).letterSpacing == "3px"`)));

  await p.key("p", MOD.Meta | MOD.Shift);
  check("source view shows the file", await until(async () => await p.eval<boolean>(`document.body.classList.contains("source")`) && (await s.source()).includes("Where leads go now.")));
  await p.key("p", MOD.Meta | MOD.Shift);
  await until(async () => !(await p.eval<boolean>(`document.body.classList.contains("source")`)) && await p.frame<boolean>(`!!${F}.querySelector("h1[data-erga-id]")`));
  await s.clickEnd("h1");
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

async function mdScenario(browser: Browser) {
  say("\nMarkdown page");
  const s = await session(browser, "md", "index.md");
  const { p } = s;
  check("front matter is not rendered", !(await s.textOf("#erga-article")).includes("title:"));
  check("units rendered", (await s.count("[data-erga-id]")) >= 8);

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

  // Clear formatting: marks and link syntax go, and a heading becomes a paragraph.
  await s.selectAllOf("p:nth-of-type(1)");
  await p.key("\\", MOD.Meta);
  await Bun.sleep(150);
  check("⌘\\ in Markdown drops the marks", (await s.source()).includes("A first paragraph with emphasis, bold\\*, code and a link.\nIt continues"), (await s.source()).match(/A first.*\n/)?.[0]);
  await s.selectAllOf("h2");
  await p.key("\\", MOD.Meta);
  await Bun.sleep(150);
  check("and a heading's #s", (await s.source()).includes("\nThings to do\n"), (await s.source()).match(/.*Things to do.*/)?.[0]);
  await p.key("z", MOD.Meta); await p.key("z", MOD.Meta);
  await Bun.sleep(150);

  await s.clickEnd("h1");
  await Bun.sleep(300);
  await s.clickEnd("h1");
  await p.key("Enter");
  await p.type("### Sub");
  await Bun.sleep(200);
  check("'### ' in a Markdown file makes a real heading", /^### Sub$/m.test(await s.source()), JSON.stringify((await s.source()).match(/.*Sub.*/)?.[0]));
  await p.key("z", MOD.Meta); await p.key("z", MOD.Meta); await p.key("z", MOD.Meta);
  await Bun.sleep(150);
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

/** A reload paints the page's own background behind the agent from the first frame, not white. */
async function backdropReloadScenario(browser: Browser) {
  say("\nReload with a coloured page");
  const s = await session(browser, "page", "index.html");
  const { p } = s;
  writeFileSync(join(s.dir, "style.css"), readFileSync(join(s.dir, "style.css"), "utf8") + "\nbody { background: rgb(243, 236, 220); }\n");
  check("the canvas takes the page's colour", await until(() => p.eval<boolean>(`getComputedStyle(document.documentElement).backgroundColor == "rgb(243, 236, 220)"`)));
  await p.send("Page.reload", {});
  // Sample as early as possible: before the page in the frame has loaded.
  let first = "";
  for (let i = 0; i < 100 && !first; i++) {
    try { first = await p.eval<string>(`document.documentElement && document.getElementById("frame") ? getComputedStyle(document.documentElement).backgroundColor : ""`); } catch {}
    if (!first) await Bun.sleep(5);
  }
  check("after a reload it's that colour from the start, not white", first == "rgb(243, 236, 220)", first);
  await s.close();
}

/** Send never refuses silently: it always says why it can't send. */
async function agentOffScenario(browser: Browser) {
  say("\nAgent off");
  const s = await session(browser, "page", "index.html", { ANTHROPIC_API_KEY: "" });
  const { p } = s;
  await p.openAgent();
  await until(() => p.eval<boolean>(`!document.getElementById("agent-hint").hidden`));
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

  // A placeholder in .dev.vars doesn't hide the key the server's environment has (dev/agent-key.ts); nothing is written back.
  const dir = mkdtempSync(join(tmpdir(), "erga-page-"));
  cpSync(`${ROOT}tests/fixtures/page`, dir, { recursive: true });
  const fromEnv = await startHost(dir, { env: { ANTHROPIC_API_KEY: "xxxxxx" }, processEnv: { ANTHROPIC_API_KEY: "sk-ant-test-from-the-environment" } });
  const info = await (await fetch(`${fromEnv.base}/api/agent`)).json() as { enabled: boolean; reason?: string };
  check("the environment's key turns the agent on past a placeholder in .dev.vars", info.enabled, JSON.stringify(info));
  await fromEnv.dispose();
  const placeholder = await startHost(dir, { env: { ANTHROPIC_API_KEY: "xxxxxx" } });
  const off = await (await fetch(`${placeholder.base}/api/agent`)).json() as { enabled: boolean; reason?: string };
  check("a placeholder alone is no key: off, saying how to set one", !off.enabled && /ANTHROPIC_API_KEY is not set.*export/.test(off.reason ?? ""), JSON.stringify(off));
  await placeholder.dispose();
  rmSync(dir, { recursive: true, force: true });
}

/** Styling: the style bar, shortcuts across inline elements, Markdown as you type, and the view switcher. */
async function formatScenario(browser: Browser) {
  say("\nStyling and views");
  const s = await session(browser, "page", "index.html");
  const { p, F } = s;
  // Select from inside <strong>new</strong> into the plain text after it.
  const f = await frameAt(p);
  const r = await p.frame<{ a: number; b: number; y: number }>(`(() => { const d = ${F}; const li = [...d.querySelectorAll("li")][1]; const st = li.querySelector("strong").firstChild, t = st.parentNode.nextSibling; const rg = d.createRange(); rg.setStart(st, 1); rg.setEnd(t, 4); const rs = rg.getClientRects(); const f = ${JSON.stringify(f)}; return { a: f.x + rs[0].left + 1, b: f.x + rs[rs.length - 1].right - 1, y: f.y + rs[0].top + rs[0].height / 2 }; })()`);
  await p.drag(r.a, r.y, r.b, r.y);
  check("selecting text shows the style bar", await until(() => p.eval<boolean>(`!document.getElementById("fmt").hidden`)));
  await p.key("b", MOD.Meta);
  await Bun.sleep(150);
  check("⌘B across the end of a bold word bolds the rest, valid HTML", (await s.source()).includes("<li>A <strong>new</strong> <strong>edi</strong>tor</li>"), (await s.source()).match(/<li>A[\s\S]*?<\/li>/)?.[0]);
  check("and the bar shows it as bold", (await p.eval<string>(`document.querySelector("#fmt [data-style=strong]").getAttribute("aria-pressed")`)) == "true");
  await p.eval(`document.querySelector("#fmt [data-style=em]").click()`);
  await Bun.sleep(150);
  check("the bar's italic button works", /<em>/.test((await s.source()).match(/<li>A[\s\S]*?<\/li>/)?.[0] ?? ""));
  await p.key("z", MOD.Meta); await p.key("z", MOD.Meta);
  await Bun.sleep(150);

  // Clear formatting.
  const original = await s.source();
  await s.selectAllOf("p.lede");
  await p.key("\\", MOD.Meta);
  await Bun.sleep(150);
  check("⌘\\ takes every style off the selection", (await s.source()).includes('<p class="lede">Build cool things &amp; ship them. This paragraph has a link and code.</p>'), (await s.source()).match(/<p class="lede">.*<\/p>/)?.[0]);
  await p.key("z", MOD.Meta);
  await Bun.sleep(150);
  const ew = await p.frame<{ a: number; b: number; y: number }>(`(() => { const d = ${F}; const t = [...d.querySelectorAll("li")][1].querySelector("strong").firstChild; const rg = d.createRange(); rg.setStart(t, 1); rg.setEnd(t, 3); const r = rg.getBoundingClientRect(); const f = ${JSON.stringify(f)}; return { a: f.x + r.left + 1, b: f.x + r.right - 1, y: f.y + r.top + r.height / 2 }; })()`);
  await p.drag(ew.a, ew.y, ew.b, ew.y);
  await until(() => p.eval<boolean>(`!document.getElementById("fmt").hidden`));
  await p.eval(`document.querySelector("#fmt [data-act=clear]").click()`);
  await Bun.sleep(150);
  check("the bar's clear button splits an element it only partly covers", (await s.source()).includes("<li>A <strong>n</strong>ew editor</li>"), (await s.source()).match(/<li>A[\s\S]*?<\/li>/)?.[0]);
  await p.key("z", MOD.Meta);
  await Bun.sleep(150);
  await s.selectAllOf("h2");
  await p.key("\\", MOD.Meta);
  await Bun.sleep(150);
  check("clearing a heading makes it a paragraph", (await s.source()).includes("<p>What changed</p>"), (await s.source()).match(/<(h2|p)>What[\s\S]*?<\/\w+>/)?.[0]);
  await p.key("z", MOD.Meta);
  await Bun.sleep(150);
  check("and each clear is one undo step", (await s.source()) == original);

  // Markdown as you type.
  await s.clickEnd("h1");
  await p.type(" **big** and *small* and `x` done");
  await Bun.sleep(200);
  check("typed Markdown becomes styling and the marks disappear", (await s.source()).includes("<h1>Launch notes <strong>big</strong> and <em>small</em> and <code>x</code> done</h1>"), (await s.source()).match(/<h1>.*<\/h1>/)?.[0]);
  await p.type(" snake_case_name");
  await Bun.sleep(100);
  check("an underscore inside a word isn't a shortcut", (await s.source()).includes("snake_case_name</h1>"));

  // Markdown at the start of a line: headings, lists, quotes.
  await s.clickEnd("p.lede");
  await p.key("Enter");
  await p.type("## Sub");
  await Bun.sleep(150);
  check("'## ' at the start of a paragraph makes a heading", (await s.source()).includes("<h2>Sub</h2>"));
  await p.key("Enter");
  await Bun.sleep(100);
  check("Enter at the end of a heading starts a well-formed paragraph", /<h2>Sub<\/h2>\s*<p><br><\/p>/.test(await s.source()), (await s.source()).match(/<h2>Sub[\s\S]{0,40}/)?.[0]);
  await p.type("- item");
  await Bun.sleep(150);
  check("'- ' makes a list, and typing straight after lands in it", /<ul>\s*<li>item<\/li>\s*<\/ul>/.test(await s.source()), (await s.source()).match(/<h2>Sub[\s\S]{0,80}/)?.[0]);
  await p.key("Enter"); await p.key("Enter");
  await Bun.sleep(150);
  check("Enter in an empty last item leaves the list", /<\/ul>\s*<p><br><\/p>/.test(await s.source()), (await s.source()).match(/<ul>\s*<li>item[\s\S]{0,60}/)?.[0]);
  await p.type("> quoted");
  await Bun.sleep(150);
  check("'> ' makes a quote", /<blockquote>\s*<p>quoted<\/p>\s*<\/blockquote>/.test(await s.source()));
  for (let i = 0; i < 2; i++) await p.key("z", MOD.Meta);
  await Bun.sleep(150);
  check("⌘Z brings back the literal marks", (await s.source()).includes("<p>&gt; </p>"));

  // Styling a code block is refused, with a reason.
  const pre = await s.rectOf("pre", 0.2);
  await p.click(pre.x, pre.y); await p.click(pre.x, pre.y, 2);
  await Bun.sleep(100);
  await p.key("b", MOD.Meta);
  await Bun.sleep(100);
  check("styling a code block says why it can't", /code block/.test(await p.eval<string>(`document.getElementById("toast").textContent`)));

  // view_page's capture, done in this tab: the page as it is now, or one element, with script errors.
  const shot = await p.eval<{ png: number; width: number; height: number; errors: string[]; error?: string }>(`ergaPage.captureView({}).then((r) => ({ ...r, png: (r.png || "").length }))`);
  check("the page can be captured in the browser for the agent", shot.png > 1000 && shot.width > 300 && shot.height > 300 && !shot.error, JSON.stringify(shot));
  const fig = await p.eval<{ png: number; width: number; error?: string }>(`ergaPage.captureView({ selector: "figure" }).then((r) => ({ ...r, png: (r.png || "").length }))`);
  check("and so can one element", fig.png > 200 && fig.width > 100 && fig.width < 900 && !fig.error, JSON.stringify(fig));
  const none = await p.eval<{ error?: string }>(`ergaPage.captureView({ selector: "#nope" })`);
  check("a selector that matches nothing says so", /Nothing on the page matches #nope/.test(none.error ?? ""));


  // The view switcher.
  await p.eval(`document.querySelector("#mode [data-mode=text]").click()`);
  await Bun.sleep(100);
  check("clicking the view button shows all three views", await p.eval<boolean>(`document.getElementById("mode").classList.contains("open")`));
  await p.eval(`document.querySelector("#mode [data-mode=md]").click()`);
  await until(() => p.eval<boolean>(`!!document.querySelector("#source .cm-content")`));
  await p.settle();
  const h1Width = await p.frame<number>(`${F}.querySelector("h1").getBoundingClientRect().width`);
  check("the Markdown view is as wide as the page's text column", await p.eval<boolean>(`Math.abs(document.querySelector("#source .cm-content").getBoundingClientRect().width - ${h1Width}) < 4`));
  check("an HTML file's Markdown view is read-only and says so", (await p.eval<string>(`document.querySelector("#source .cm-content").getAttribute("contenteditable")`)) == "false" && !(await p.eval<boolean>(`document.getElementById("mode-note").hidden`)) && (await p.eval<string>(`document.querySelector("#source .cm-content").textContent`)).includes("# Launch notes"));
  await p.eval(`document.querySelector("#mode [aria-checked=true]").click()`); await Bun.sleep(100);
  await p.eval(`document.querySelector("#mode [data-mode=html]").click()`); await until(() => p.eval<boolean>(`!!document.querySelector("#source .cm-content") && document.querySelector("#source .cm-content").getAttribute("contenteditable") == "true"`)); await p.settle();
  check("the HTML view is code: smaller monospace, lines not wrapped", await p.eval<boolean>(`(() => { const c = document.querySelector("#source .cm-content"); return getComputedStyle(c).fontSize == "13px" && !c.classList.contains("cm-lineWrapping"); })()`));
  check("its HTML view is the file, editable", (await p.eval<string>(`document.querySelector("#source .cm-content").getAttribute("contenteditable")`)) == "true" && (await p.eval<boolean>(`document.getElementById("mode-note").hidden`)));
  await p.key("Escape");
  check("Esc goes back to the page", await until(async () => !(await p.eval<boolean>(`document.body.classList.contains("source")`))));
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

/** No dark mode: with the system set to dark, the Markdown page and the shell stay light. */
async function lightOnlyScenario(browser: Browser) {
  say("\nSystem in dark mode");
  const s = await session(browser, "md", "index.md");
  const { p, F } = s;
  await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await p.settle(); await p.settle();
  check("the Markdown page stays light", (await p.frame<string>(`getComputedStyle(${F}.body).backgroundColor`)) == "rgb(255, 255, 255)");
  check("and so does the shell", (await p.eval<string>(`getComputedStyle(document.documentElement).backgroundColor`)) == "rgb(255, 255, 255)");
  check("there is no theme toggle", !(await p.eval<boolean>(`!!document.getElementById("btn-theme")`)));
  await s.close();
}

async function agentEmptyScenario(browser: Browser) {
  say("\nAgent, empty message");
  const s = await session(browser, "page", "index.html", { ANTHROPIC_API_KEY: "sk-ant-test-not-used" });
  const { p } = s;
  await p.openAgent();
  await until(() => p.eval<boolean>(`/Type a message/.test(document.getElementById("agent-send").title)`));
  check("an empty message: Send says to type one", await p.eval<boolean>(`(() => { const b = document.getElementById("agent-send"); return b.getAttribute("aria-disabled") == "true" && /Type a message/.test(b.title); })()`));
  await p.key("Enter");
  check("and pressing it says so in the panel", await until(() => p.eval<boolean>(`(() => { const h = document.getElementById("agent-hint"); return !h.hidden && /Type a message/.test(h.textContent); })()`)));
  await p.type("x");
  await Bun.sleep(50);
  check("typing enables it and clears the hint", await p.eval<boolean>(`document.getElementById("agent-send").getAttribute("aria-disabled") == "false" && document.getElementById("agent-hint").hidden`));

  // A re-render (here, a stylesheet changing) doesn't pull focus out of the agent's input.
  await p.eval(`document.getElementById("agent-input").focus()`);
  writeFileSync(join(s.dir, "style.css"), readFileSync(join(s.dir, "style.css"), "utf8") + "\nh1 { color: rgb(1, 2, 3); }\n");
  await until(() => p.frame<boolean>(`getComputedStyle(${F}.querySelector("h1")).color == "rgb(1, 2, 3)"`));
  await p.settle();
  check("a page re-render leaves focus in the agent's input", (await p.frame<string>(`getComputedStyle(${F}.querySelector("h1")).color`)) == "rgb(1, 2, 3)" && (await p.eval<string>(`document.activeElement.id`)) == "agent-input");

  // The box grows with its text, and the height eases rather than snapping.
  const grow = await p.eval<number[]>(`new Promise((res) => { const f = document.getElementById("agent-field"), t = document.getElementById("agent-input"); const out = [f.getBoundingClientRect().height]; t.value += "\\ntwo\\nthree"; t.dispatchEvent(new Event("input")); let n = 0; const tick = () => { out.push(f.getBoundingClientRect().height); if (++n < 20) requestAnimationFrame(tick); else res(out); }; requestAnimationFrame(tick); })`);
  const [h0, hEnd] = [grow[0], grow[grow.length - 1]];
  check("the agent box grows with its text, easing through the heights between", hEnd > h0 + 30 && grow.some((h) => h > h0 + 2 && h < hEnd - 2), grow.map(Math.round).join(" "));
  await p.eval(`(() => { const t = document.getElementById("agent-input"); t.value = t.value.split("\\n")[0]; t.dispatchEvent(new Event("input")); })()`);

  // An unsent message survives a reload.
  await p.eval(`document.getElementById("agent-input").focus()`);
  await p.type("half a thought");
  await p.eval(`location.reload()`);
  await Bun.sleep(50);
  await loaded(p);
  check("an unsent message in the agent box survives a reload", (await p.eval<string>(`document.getElementById("agent-input").value`)).endsWith("half a thought"), await p.eval<string>(`document.getElementById("agent-input").value`));
  await p.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  await p.eval(`location.reload()`);
  await Bun.sleep(50);
  await loaded(p);
  check("and a cleared box stays cleared", (await p.eval<string>(`document.getElementById("agent-input").value`)) == "");
  await p.eval(`document.getElementById("agent-input").focus()`);

  // The pane's open or closed state survives a reload.
  const paneOpen = () => p.eval<boolean>(`document.body.classList.contains("agent-open") && !document.getElementById("agent").inert`);
  // Checked as soon as the new page's script has run (not after a fixed pause: on a busy machine the reload can take longer).
  await p.eval(`window.__beforeReload = true; location.reload()`);
  await until(() => p.eval<boolean>(`!window.__beforeReload && !!window.ergaPage`), 5000);
  check("an open pane is still open after a reload, from the first frame", await paneOpen());
  await loaded(p);
  await p.key("j", MOD.Meta);
  await p.settle();
  await p.eval(`location.reload()`);
  await Bun.sleep(50);
  await loaded(p);
  check("a collapsed pane stays collapsed after a reload", !(await paneOpen()) && (await p.eval<string>(`document.getElementById("agent-fab").getAttribute("aria-expanded")`)) == "false");

  // Out of the editor the pane collapses; back in, it grows out again only if it was left open.
  const toggleEditing = async () => { await p.eval(`(document.querySelector("body.erga-editing #btn-edit") ?? document.querySelector(".erga-edit-button")).click()`); await Bun.sleep(700); };
  await toggleEditing(); await toggleEditing();
  check("left collapsed, it stays collapsed on the way back into the editor", !(await paneOpen()));
  await p.key("j", MOD.Meta);
  await p.settle();
  await toggleEditing();
  check("leaving the editor collapses the pane", !(await paneOpen()));
  await toggleEditing();
  check("and left open, it opens again on the way back in", await paneOpen());
  // Someone who's never closed it finds it open, coming into the editor.
  await p.eval(`localStorage.removeItem("erga:settings:v1")`);
  await p.navigate(`${s.base}?again#edit`); // a new address: the same one would count as a reload
  await loaded(p);
  check("coming into the editor for the first time, the pane opens by itself", await until(paneOpen, 2000));
  await s.close();
}

/** A paragraph whose HTML has a stray end tag: it's locked and says why, and typing never lands somewhere else. */
async function strayTagScenario(browser: Browser) {
  say("\nStray end tag");
  // Timing is what's under test here, so less compressed than elsewhere: a busy machine
  // shouldn't eat a whole (scaled) minimum between a click and the check after it.
  const TS = 0.4, T = (ms: number) => ms * TS;
  const s = await session(browser, "stray", "index.html", {}, "", TS);
  const { p, F } = s;
  check("the malformed paragraph is locked", await p.frame<boolean>(`${F}.querySelector(".box p").classList.contains("erga-locked")`));
  check("its neighbours aren't", await p.frame<boolean>(`!${F}.querySelector(".box h4").classList.contains("erga-locked") && !${F}.querySelector("body > p").classList.contains("erga-locked")`));
  const before = await s.source();
  const r = await s.rectOf(".box p", 0.3);
  await p.click(r.x, r.y);
  const toast = () => p.eval<{ text: string; shown: boolean }>(`(() => { const t = document.getElementById("toast"); return { text: t.textContent, shown: t.classList.contains("show") }; })()`);
  check("clicking it says why", /stray <\/h2>/.test((await toast()).text) && (await toast()).shown);
  check("and offers the agent's help, not a trip to the HTML", !/HTML view|⌘⇧P/.test((await toast()).text) && await p.eval<boolean>(`!!document.querySelector("#toast .toast-fix")`));
  await Bun.sleep(T(5000) * 1.5); // past its minimum, with nothing else happening
  check("the explanation stays up while nothing else happens", (await toast()).shown);
  const elsewhere = await s.rectOf("h1", 0.5);
  await p.click(elsewhere.x, elsewhere.y);
  check("and goes when you click somewhere else", await until(async () => !(await toast()).shown, 1000));
  // Typing into the locked paragraph explains again, and changes nothing.
  await p.click(r.x, r.y);
  await p.type("xyz");
  await p.settle();
  check("typing into it explains again", (await toast()).shown && /stray/.test((await toast()).text));
  check("and changes nothing (no edit at the top of the page)", (await s.source()) == before, (await s.source()).slice(0, 300));
  // A click elsewhere straight away doesn't cut it short: it stays its minimum first.
  await p.click(elsewhere.x, elsewhere.y);
  await Bun.sleep(T(5000) / 2);
  check("a click elsewhere right away leaves it up for its minimum", (await toast()).shown);
  check("then it goes", await until(async () => !(await toast()).shown, T(5000) + 1000));
  await s.clickEnd("body > p");
  await p.type("!");
  await Bun.sleep(150);
  check("the paragraph above still edits", (await s.source()).includes("This paragraph is fine.!</p>"));
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

/** Parts marked data-erga-noedit: never editable by hand, and clicking them says so. */
async function noEditScenario(browser: Browser) {
  say("\nNo-edit parts");
  const s = await session(browser, "noedit", "index.html");
  const { p, F } = s;
  check("a no-edit section has no editable text", await p.frame<boolean>(`[...${F}.querySelectorAll(".fixed h2, .fixed p")].every((e) => !e.hasAttribute("data-erga-id") && !e.isContentEditable)`));
  check("a no-edit span inside a paragraph is fenced off", await p.frame<boolean>(`${F}.querySelector(".free").isContentEditable && !${F}.querySelector(".count").isContentEditable`));
  const before = await s.source();
  const r = await s.rectOf(".fixed p", 0.3);
  await p.click(r.x, r.y);
  const toast = () => p.eval<{ text: string; shown: boolean }>(`(() => { const t = document.getElementById("toast"); return { text: t.textContent, shown: t.classList.contains("show") }; })()`);
  check("clicking it says why", await until(async () => { const t = await toast(); return t.shown && /not editable by hand/.test(t.text); }), await toast());
  await p.type("xyz");
  await p.settle();
  check("and typing changes nothing", (await s.source()) == before);
  await s.clickEnd(".free");
  await p.type("!");
  await Bun.sleep(150);
  check("the rest of the paragraph still edits", (await s.source()).includes("items.!</p>"), (await s.source()).slice(0, 400));
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

/** The model menu: Opus 5.5 fast by default, switchable to Sonnet 5.5; the person's other tabs and a reload follow. */
async function modelScenario(browser: Browser) {
  say("\nAgent model");
  const s = await session(browser, "noedit", "index.html", { ANTHROPIC_API_KEY: "sk-ant-test-not-used", ERGA_AGENT_MODEL: "" });
  const { p } = s;
  const sel = (q: typeof p) => q.eval<{ value: string; text: string; options: string[] } | null>(`(() => { const s = document.getElementById("agent-model-select"); return s && { value: s.value, text: s.selectedOptions[0]?.text, options: [...s.options].map((o) => o.text) }; })()`);
  await until(async () => !!(await sel(p)));
  const first = await sel(p);
  check("the agent starts on Opus 5.5 fast, with Sonnet 5.5 to pick", first?.value == "opus-fast" && first.options.join("|") == "Sonnet 5.5|Opus 5.5 fast", first);
  const q = await browser.page();
  await q.open(`${s.base}#edit`, { clear: false, width: 900, height: 700 });
  await until(async () => (await sel(q))?.value == "opus-fast");
  await p.eval(`(() => { const s = document.getElementById("agent-model-select"); s.value = "sonnet"; s.dispatchEvent(new Event("change")); })()`);
  check("picking Sonnet 5.5 switches it", await until(async () => (await (await fetch(`${s.base}/api/agent`)).json() as { choice: string }).choice == "sonnet"));
  check("the person's other tab follows", await until(async () => (await sel(q))?.value == "sonnet"));
  q.close();
  await p.eval(`location.reload()`);
  await until(async () => !!(await sel(p)));
  check("and a reload keeps it", (await sel(p))?.value == "sonnet");
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

/** The share button: a prompt with this page's API and a working token; Escape closes it. */
async function shareScenario(browser: Browser) {
  say("\nShare with an agent");
  const s = await session(browser, "noedit", "index.html");
  const { p } = s;
  await p.eval(`document.getElementById("btn-share").click()`);
  check("the share button opens its dialog", await p.eval<boolean>(`!document.getElementById("share").hidden && document.getElementById("btn-share").getAttribute("aria-expanded") == "true"`));
  check("with a prompt", await until(() => p.eval<boolean>(`document.getElementById("share-prompt").value.includes("Token: erga_")`)));
  const prompt = await p.eval<string>(`document.getElementById("share-prompt").value`);
  const token = /Token: (\S+)/.exec(prompt)?.[1], api = /API: (\S+)/.exec(prompt)?.[1];
  check("naming the API and the token, which works", !!api && !!token && (await fetch(api, { headers: { Authorization: `Bearer ${token}` } })).ok, prompt);
  await p.key("Escape");
  // With the caret on the page, the key reaches the shell from the frame, by message: a moment later.
  check("Escape closes it", await until(() => p.eval<boolean>(`document.getElementById("share").hidden`)));
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

/** A page with problems nobody asked about/** A page with problems nobody asked about: each is explained in turn, with a button to have the agent fix it. */
async function brokenPageScenario(browser: Browser) {
  say("\nBroken page");
  const s = await session(browser, "broken", "index.html", { ANTHROPIC_API_KEY: "" });
  const { p } = s;
  const toast = () => p.eval<{ text: string; shown: boolean; fix: boolean; fixDisabled: string | null; fixTitle: string }>(`(() => { const t = document.getElementById("toast"), b = t.querySelector(".toast-fix"); return { text: t.querySelector(".toast-text")?.textContent ?? t.textContent, shown: t.classList.contains("show"), fix: !!b, fixDisabled: b?.getAttribute("aria-disabled") ?? null, fixTitle: b?.title ?? "" }; })()`);
  await until(async () => (await toast()).shown);
  const first = await toast();
  check("a broken page says what's wrong on its own", first.shown && /missing\.css|drawTheChart/.test(first.text), first);
  check("with a button to have the agent fix it", first.fix);
  check("which, with the agent off, is disabled and says why", first.fixDisabled == "true" && /agent is off/i.test(first.fixTitle), first);
  await p.eval(`document.querySelector("#toast .toast-fix").click()`);
  check("clicking it anyway explains", await until(async () => /agent is off/i.test((await toast()).text)), await toast());
  await Bun.sleep(T(5000) + 100);
  const h1 = await s.rectOf("h1", 0.5);
  await p.click(h1.x, h1.y);
  await until(async () => { const t = await toast(); return t.shown && t.fix && t.text != first.text; });
  const second = await toast();
  check("the other problem comes next", second.shown && second.fix && second.text != first.text && /missing\.css|drawTheChart/.test(second.text), { first: first.text, second });
  const both = first.text + " " + second.text;
  check("they name the missing stylesheet and the script error", /stylesheet “missing\.css”/.test(both) && /drawTheChart is not defined/.test(both), both);
  await s.close();
}

/** Pausing the page: a page that defines window.ergaPause stops answering clicks, so its text can be edited; one that doesn't says so. */
async function pauseScenario(browser: Browser) {
  say("\nPausing the page");
  const s = await session(browser, "pause", "index.html");
  const { p, F } = s;
  const btn = () => p.eval<{ disabled: string | null; pressed: string | null }>(`(() => { const b = document.getElementById("btn-pause"); return { disabled: b.getAttribute("aria-disabled"), pressed: b.getAttribute("aria-pressed") }; })()`);
  const slide = () => p.frame<number>(`${F}.defaultView.slide`);
  check("a page with window.ergaPause can be paused", (await btn()).disabled == "false", await btn());
  await s.clickEnd("h1");
  check("live, a click on its text drives the page", await until(async () => (await slide()) == 2), await slide());
  await p.eval(`document.getElementById("btn-pause").click()`);
  check("the pause button pauses it", (await btn()).pressed == "true", await btn());
  await s.clickEnd("h1");
  await p.type("!");
  await Bun.sleep(150);
  check("paused, a click places the caret and the page stays put", (await slide()) == 2, await slide());
  check("and the text edits", (await s.source()).includes("advance on click!</h1>"), (await s.source()).slice(0, 400));
  // A fresh page (a render from scratch starts its script over, at slide 1) is told it's paused too.
  await p.eval(`window.ergaPage.page.render()`);
  await until(async () => (await slide()) == 1);
  await s.clickEnd("h1");
  await Bun.sleep(150);
  check("a re-rendered page stays paused", (await btn()).pressed == "true" && (await slide()) == 1, { btn: await btn(), slide: await slide() });
  await p.eval(`document.getElementById("btn-pause").click()`);
  await s.clickEnd("h1");
  check("resuming hands clicks back to the page", (await btn()).pressed == "false" && await until(async () => (await slide()) == 2), { btn: await btn(), slide: await slide() });
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();

  const t = await session(browser, "noedit", "index.html", { ANTHROPIC_API_KEY: "" });
  const card = () => t.p.eval<{ shown: boolean; text: string; fixDisabled: string | null; fixTitle: string }>(`(() => { const c = document.getElementById("pause-card"), f = document.getElementById("pause-fix"); return { shown: !c.hidden, text: c.textContent, fixDisabled: f.getAttribute("aria-disabled"), fixTitle: f.title }; })()`);
  check("a page without it can't be paused", await t.p.eval<boolean>(`document.getElementById("btn-pause").getAttribute("aria-disabled") == "true"`));
  await t.p.eval(`document.getElementById("btn-pause").dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }))`);
  check("hovering the button explains", (await card()).shown && /can't be paused/.test((await card()).text), await card());
  check("with a fix button, disabled while the agent is off", (await card()).fixDisabled == "true" && /agent is off/i.test((await card()).fixTitle), await card());
  await t.p.eval(`document.getElementById("btn-pause").click()`);
  check("clicking it doesn't pause anything", await t.p.eval<boolean>(`document.getElementById("btn-pause").getAttribute("aria-pressed") == "false"`));
  await t.p.key("Escape");
  check("Escape closes the card", !(await card()).shown, await card());
  check("no page errors", t.p.errors.length == 0, t.p.errors.join("\n"));
  await t.close();
}

/** Voice mode, against a stand-in for the browser's speech recognition: dictation fills the box and each pause sends it. */
async function voiceScenario(browser: Browser) {
  say("\nAgent, voice mode");
  const s = await session(browser, "page", "index.html", { ANTHROPIC_API_KEY: "sk-ant-test-not-used" });
  const { p } = s;
  // The stand-in records each session in __recs; messages to the agent are caught in __sent, not sent.
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__recs = []; window.__sent = [];
    window.SpeechRecognition = class extends EventTarget { start() { this.running = true; __recs.push(this); } stop() { this.abort(); } abort() { if (!this.running) return; this.running = false; setTimeout(() => this.onend?.()); } };
    window.__hear = (...rs) => __recs.at(-1).onresult({ results: rs.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f })) });
    const f = window.fetch;
    window.fetch = (url, init) => String(url).split("?")[0].endsWith("/api/agent") && init?.method == "POST" ? (__sent.push(JSON.parse(init.body).text), Promise.resolve(new Response("{}"))) : f(url, init);
  ` });
  await p.eval(`location.reload()`);
  await loaded(p);
  await p.openAgent();
  await until(() => p.eval<boolean>(`/Type a message/.test(document.getElementById("agent-send").title)`), 10_000);
  // `before` runs in the same evaluation as the read: the pause timer is a tenth of real time under test, shorter than a round trip on a busy machine.
  const st = (before = "") => p.eval<{ on: string | null; input: string; readOnly: boolean; send: string | null; title: string; sent: string[]; recs: number }>(`(() => { ${before}; const v = document.getElementById("agent-voice"), i = document.getElementById("agent-input"), b = document.getElementById("agent-send"); return { on: v.getAttribute("aria-pressed"), input: i.value, readOnly: i.readOnly, send: b.getAttribute("aria-disabled"), title: b.title, sent: [...__sent], recs: __recs.length }; })()`);
  check("the voice button shows where speech recognition exists", await p.eval<boolean>(`!document.getElementById("agent-voice").hidden`));
  await p.eval(`document.getElementById("agent-voice").click()`);
  let v = await st();
  check("voice mode listens, and Send is off and says why", v.on == "true" && v.recs == 1 && v.readOnly && v.send == "true" && /Voice mode/.test(v.title), v);

  v = await st(`__hear(["make the title", false])`);
  check("words show in the box as they're heard, unsent", v.input == "make the title" && v.sent.length == 0, v);
  await p.eval(`__hear(["make the title blue", true])`);
  check("a pause sends what was said", await until(async () => (await st()).sent.length == 1, 2000));
  v = await st();
  check("and empties the box", v.sent[0] == "make the title blue" && v.input == "", v);

  // The session's first result was sent; the next words not yet final are sent at the pause too, then the session restarts.
  v = await st(`__hear(["make the title blue", true], [" and bigger", false])`);
  check("the next words show alone", v.input == "and bigger", v);
  await until(async () => (await st()).sent.length == 2, 2000);
  v = await st();
  check("each pause sends again, words not yet final included", v.sent[1] == "and bigger", v);
  check("and a fresh session takes over, so they don't come again", await until(async () => (await st()).recs == 2, 2000));

  v = await st(`__hear(["thanks", true]); document.getElementById("agent-voice").click()`);
  check("leaving voice mode keeps what wasn't sent in the box, to edit", v.on == "false" && v.input == "thanks" && !v.readOnly && v.sent.length == 2, v);
  await Bun.sleep(T(1000) + 100);
  check("and doesn't send it later", (await st()).sent.length == 2);

  await p.eval(`document.getElementById("agent-voice").click()`);
  await p.key("j", MOD.Meta);
  check("collapsing the panel stops listening", (await st()).on == "false" && await p.eval<boolean>(`!__recs.at(-1).running`));
  await s.close();
}

/** Selections that span several units (paragraphs, headings, list items): by mouse, Shift-click and keyboard, then copy, cut, delete and typing over them. */
async function selectScenario(browser: Browser) {
  say("\nSelecting across paragraphs");
  const s = await session(browser, "page", "index.html");
  const { p, F } = s;
  /** A point in the tab at character `i` of an element's first text node. */
  const at = async (selector: string, i: number) => {
    const r = await p.frame<{ x: number; y: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); const t = ${F}.createTreeWalker(el, 4).nextNode(); const rg = ${F}.createRange(); rg.setStart(t, ${i}); rg.setEnd(t, ${i} + 1); const r = rg.getBoundingClientRect(); const f = document.getElementById("page").getBoundingClientRect(); return { x: f.left + r.left + 1, y: f.top + r.top + r.height / 2 }; })()`);
    const f = await frameAt(p);
    return { x: r.x + f.x, y: r.y + f.y };
  };
  const domText = () => p.frame<string>(`${F}.getSelection().toString()`);
  const model = () => p.eval<{ from: number; to: number; text: string }>(`(() => { const m = ergaPage.state.selection.main; return { from: m.from, to: m.to, text: ergaPage.state.doc.sliceString(m.from, m.to) }; })()`);
  const hosts = () => p.frame<boolean>(`[...${F}.querySelectorAll("[data-erga-id]:not(.erga-locked)")].every((el) => el.getAttribute("contenteditable") == "true")`);
  /** The editor's shortcut key: ⌘ on a Mac, Ctrl elsewhere (src/page/editor.ts, isMac). */
  /** Undo can render the page afresh (when patching it can't put the units back): wait until it's done. */
  const idle = () => until(async () => !(await p.frame<boolean>("ergaFrame.page.rendering")));
  const CMD = process.platform == "darwin" ? MOD.Meta : MOD.Ctrl;

  // The mouse: from the heading into the paragraph under it.
  const h = await at("h1", 2), b = await at("p.lede", 3);
  await p.drag(h.x, h.y, b.x, b.y);
  await until(async () => (await model()).text.includes("</h1>"));
  check("a drag selects from the heading into the paragraph", (await domText()).replace(/\s+/g, " ") == "unch notes Bui", await domText());
  check("and the editor's selection spans both", (await model()).text.startsWith("unch notes</h1>") && (await model()).text.endsWith("Bui"), await model());
  await p.screenshot(`${SHOTS}/select-across.png`);
  await p.key("Backspace");
  check("Backspace deletes the selection and joins the two", await until(async () => (await s.textOf("h1")).startsWith("Lald ")), await s.textOf("h1"));
  check("valid HTML in the source", (await s.source()).includes(`<h1>Lald <em>cool</em>`), (await s.source()).match(/<h1>.*/)?.[0]);
  check("and the units are editing hosts again, with the caret", await hosts() && await p.frame<boolean>(`${F}.activeElement.matches("h1")`));
  await p.key("z", CMD);
  check("undo brings both back", await until(async () => (await s.textOf("h1")) == "Launch notes" && (await s.count("p.lede")) == 1));
  await idle();

  // Shift-click: from a caret in the heading to a list item, past the widget and the second heading.
  await p.click(h.x, h.y);
  const li = await at("li:first-child", 6);
  await p.click(li.x, li.y, 1, MOD.Shift);
  await until(async () => (await model()).text.includes("Faster"));
  check("Shift-click extends the selection into another unit", /^unch notes[\s\S]*What changed[\s\S]*Faster$/.test((await domText()).trim()), await domText());
  check("the editor's selection spans them", (await model()).text.startsWith("unch notes") && (await model()).text.endsWith("Faster"), await model());
  // Copying: only the document's text, as plain text and as HTML with no styles; a cut takes it out too.
  const copied = await p.frame<{ text: string; html: string }>(`(() => { const d = new DataTransfer(); ${F}.body.dispatchEvent(new ClipboardEvent("copy", { clipboardData: d, bubbles: true, cancelable: true })); return { text: d.getData("text/plain"), html: d.getData("text/html") }; })()`);
  check("a copy takes the units' text, a blank line between them", copied.text == "unch notes\n\nBuild cool things & ship them. This paragraph has a link and code.\n\n0clicks\n\nWhat changed\n\nFaster", copied.text);
  check("and not the widget's button", !copied.text.includes("Bump") && !copied.html.includes("Bump"), copied);
  check("its HTML is only structure: no classes, styles or ids", copied.html == `<h1>unch notes</h1><p>Build <em>cool</em> things &amp; ship them. This paragraph has <a href="https://example.com/">a link</a> and <code>code</code>.</p><p><strong>0</strong>clicks</p><h2>What changed</h2><ul><li>Faster</li></ul>`, copied.html);
  const cut = await p.frame<string>(`(() => { const d = new DataTransfer(); ${F}.body.dispatchEvent(new ClipboardEvent("cut", { clipboardData: d, bubbles: true, cancelable: true })); return d.getData("text/plain"); })()`);
  check("a cut copies the same", cut == copied.text, cut);
  check("and deletes it from the source", await until(async () => /<h1>La<\/h1>[\s\S]*<li> builds<\/li>/.test(await s.source()) && !(await s.source()).includes("What changed")), (await s.source()).match(/<h1>[\s\S]*?<\/ul>/)?.[0]);
  await p.key("z", CMD);
  check("undo brings it back", await until(async () => (await s.source()).includes("<h1>Launch notes</h1>") && (await s.source()).includes("<li>Faster builds</li>")));
  await idle();

  // The keyboard: Shift and the arrows carry on past the heading's end.
  await p.click(h.x, h.y);
  await p.key("ArrowDown", MOD.Shift);
  await p.key("ArrowDown", MOD.Shift);
  await p.key("ArrowRight", MOD.Shift);
  await p.settle();
  await until(async () => (await model()).text.includes("</h1>"));
  check("Shift+ArrowDown selects past the end of the heading", (await domText()).startsWith("unch notes") && /Build/.test(await domText()), await domText());
  check("the editor's selection follows", (await model()).text.startsWith("unch notes</h1>"), await model());
  const one = await p.frame<{ text: string; html: string }>(`(() => { const t = ${F}.querySelector("p.lede").firstChild; ${F}.getSelection().setBaseAndExtent(t, 0, t, 5); const d = new DataTransfer(); ${F}.activeElement.dispatchEvent(new ClipboardEvent("copy", { clipboardData: d, bubbles: true, cancelable: true })); return { text: d.getData("text/plain"), html: d.getData("text/html") }; })()`);
  check("a copy inside one paragraph is its text, with no block around it", one.text == "Build" && one.html == "Build", one);
  await p.click(h.x, h.y);
  for (const k of ["ArrowDown", "ArrowDown", "ArrowRight"]) await p.key(k, MOD.Shift);
  await p.key("ArrowLeft", MOD.Shift);
  await p.key("ArrowUp", MOD.Shift);
  await p.key("ArrowUp", MOD.Shift);
  await p.settle();
  check("Shift+ArrowUp comes back", await until(async () => !(await model()).text.includes("</h1>")), await model());
  await p.key("ArrowDown", MOD.Shift);
  await p.key("ArrowDown", MOD.Shift);
  await until(async () => (await model()).text.includes("</h1>"));
  await p.key("X", MOD.Shift);
  check("typing replaces a selection across units", await until(async () => /^LaX/.test(await s.textOf("h1"))), await s.textOf("h1"));
  check("and the caret is after it, in a unit that edits", await hosts() && await p.frame<boolean>(`${F}.activeElement.matches("h1")`));
  await p.type("y");
  check("typing goes on there", await until(async () => /^LaXy/.test(await s.textOf("h1"))), await s.textOf("h1"));
  await p.key("z", CMD); await p.key("z", CMD);
  await until(async () => (await s.textOf("h1")) == "Launch notes");
  await idle();

  // An arrow without Shift collapses the selection.
  await p.drag(h.x, h.y, b.x, b.y);
  await until(async () => (await model()).text.includes("</h1>"));
  await p.key("ArrowRight");
  check("ArrowRight collapses a selection across units at its end", await until(async () => { const m = await model(); return m.from == m.to; }) && await hosts() && await p.frame<boolean>(`${F}.activeElement.matches("p.lede")`));

  // Select all (⌘A twice) spans the page, and the browser shows it.
  await p.key("a", CMD); await p.key("a", CMD);
  await p.settle();
  check("⌘A twice selects every unit, on the page too", /^Launch notes[\s\S]*Typing never waits\.$/.test((await domText()).trim()), await domText());

  // The HTML view (CodeMirror): a drag across lines, and Backspace.
  await p.eval(`ergaPage.toggleSource(true)`);
  await until(() => p.eval<boolean>(`document.querySelectorAll("#source .cm-line").length > 5`));
  await p.settle();
  const line = (n: number) => p.eval<{ x: number; y: number }>(`(() => { const l = document.querySelectorAll("#source .cm-line")[${n}]; l.scrollIntoView({ block: "center" }); const r = l.getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; })()`);
  const lines = await p.eval<string[]>(`[...document.querySelectorAll("#source .cm-line")].map((l) => l.textContent)`);
  const i = lines.findIndex((l) => l.includes("<h1>"));
  const a1 = await line(i), a2 = await line(i + 2);
  await p.drag(a1.x, a1.y, a2.x, a2.y);
  check("the HTML view selects across lines", ((await p.eval<string>(`getSelection().toString()`)).match(/\n/g) ?? []).length >= 2, await p.eval<string>(`getSelection().toString()`));
  await p.key("Backspace");
  check("and Backspace deletes them", await until(async () => !(await s.source()).includes("<h1>Launch notes</h1>")));
  await s.close();

  // Markdown: the same drag, from the heading into the paragraph and on into the list.
  const m = await session(browser, "md", "index.md");
  const mp = m.p;
  const pt = async (selector: string, i: number) => {
    const r = await mp.frame<{ x: number; y: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); const t = ${F}.createTreeWalker(el, 4).nextNode(); const rg = ${F}.createRange(); rg.setStart(t, ${i}); rg.setEnd(t, ${i} + 1); const r = rg.getBoundingClientRect(); const f = document.getElementById("page").getBoundingClientRect(); return { x: f.left + r.left + 1, y: f.top + r.top + r.height / 2 }; })()`);
    const f = await frameAt(mp);
    return { x: r.x + f.x, y: r.y + f.y };
  };
  const m1 = await pt("h1", 5), m2 = await pt("li", 6);
  await mp.drag(m1.x, m1.y, m2.x, m2.y);
  check("Markdown: a drag selects from the heading into the list", /^ notes[\s\S]*Things to do[\s\S]*Water $/.test(await mp.frame<string>(`${F}.getSelection().toString()`)), await mp.frame<string>(`${F}.getSelection().toString()`));
  await mp.key("Delete");
  check("and Delete leaves one line of Markdown", await until(async () => (await m.source()).includes("\n# Fieldthe plants\n- Call")), (await m.source()).slice(0, 300));
  await m.close();
}

/** Tab and Shift+Tab at the start of a Markdown list item nest it and take it back out; Enter then carries on at its level. */
async function indentScenario(browser: Browser) {
  say("\nTab in a list");
  const s = await session(browser, "md", "index.md");
  const { p } = s;
  // The editor's own shortcut key: ⌘ on a Mac, Ctrl elsewhere.
  const UNDO = process.platform == "darwin" ? MOD.Meta : MOD.Ctrl;
  const list = async () => (await s.source()).match(/- Water[\s\S]*?\n(?=\n)/)?.[0] ?? "";
  const press = async (key: string, mods = 0) => { await p.key(key, mods); await Bun.sleep(80); };
  const start = async (selector: string) => { await s.clickEnd(selector); await press("Home"); };
  const nested = () => p.frame<string[]>(`[...${F}.querySelectorAll("li li")].map((li) => li.textContent.trim())`);

  await start("li:last-child p");
  await press("Tab");
  check("Tab at the start of an item nests it under the one before", (await list()) == "- Water the plants\n  - Call *Sam* back\n", await list());
  check("and the page shows a nested list", JSON.stringify(await nested()) == '["Call Sam back"]', await nested());
  check("the caret stays at the start of the item's text", await until(async () => (await s.source()).indexOf("Call *Sam*") == await p.eval<number>("ergaPage.state.selection.main.head")));

  await s.clickEnd("li li p");
  await press("Enter");
  await p.type("Write it down");
  await Bun.sleep(120);
  check("Enter after it starts the next item at the same level", (await list()) == "- Water the plants\n  - Call *Sam* back\n  - Write it down\n", await list());

  await press("Tab");
  check("Tab in the middle of the text changes nothing", (await list()) == "- Water the plants\n  - Call *Sam* back\n  - Write it down\n", await list());

  await start("li li:last-child p");
  await press("Tab");
  check("Tab again nests it one more level", (await list()) == "- Water the plants\n  - Call *Sam* back\n    - Write it down\n", await list());
  check("three levels on the page", (await s.count("li li li")) == 1);
  await press("Tab", MOD.Shift);
  check("Shift+Tab takes it one level back out", (await list()) == "- Water the plants\n  - Call *Sam* back\n  - Write it down\n", await list());

  await start("li li:first-child p");
  await press("Tab", MOD.Shift);
  check("Shift+Tab on a nested item takes it out, with what comes after it nested under it", (await list()) == "- Water the plants\n- Call *Sam* back\n  - Write it down\n", await list());
  await p.type("Now ");
  await Bun.sleep(120);
  check("the caret stays at the start of the item", (await list()).includes("\n- Now Call *Sam* back\n"), await list());
  await p.key("z", UNDO); await Bun.sleep(120);

  const before = await s.source();
  await start("li:first-child p");
  await press("Tab");
  await press("Tab", MOD.Shift);
  check("the first item and a top-level item stay where they are", (await s.source()) == before, await list());

  await start("li:last-child p");
  await press("Tab");
  check("a nested list made with Tab", (await list()) == "- Water the plants\n  - Call *Sam* back\n    - Write it down\n", await list());
  await p.screenshot(`${SHOTS}/indent-list.png`);
  check("on disk too", await waitFor(() => s.disk().includes("  - Call *Sam* back\n    - Write it down\n")));
  await p.key("z", UNDO); await Bun.sleep(150);
  check("undo takes the indent back", (await list()) == "- Water the plants\n- Call *Sam* back\n  - Write it down\n", await list());
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

/** The same in an HTML page: a nested list goes in the item before, whose own text moves into a <p> so it stays editable. */
async function htmlIndentScenario(browser: Browser) {
  say("\nTab in an HTML list");
  const s = await session(browser, "page", "index.html");
  const { p } = s;
  const UNDO = process.platform == "darwin" ? MOD.Meta : MOD.Ctrl;
  const list = async () => (await s.source()).match(/<ul>[\s\S]*<\/ul>/)?.[0] ?? "";
  const flat = (t: string) => t.replace(/\s*\n\s*/g, "");
  const press = async (key: string, mods = 0) => { await p.key(key, mods); await Bun.sleep(120); };
  const start = async (selector: string) => { await s.clickEnd(selector); await press("Home"); };
  const editable = () => p.frame<boolean>(`[...${F}.querySelectorAll("[data-erga-id]")].filter((e) => e.closest("li")).every((e) => e.isContentEditable)`);

  await start("li:last-child");
  await press("Tab");
  check("Tab nests the item in the one before, whose text goes in a <p>", flat(await list()) == "<ul><li><p>Faster builds</p><ul><li>A <strong>new</strong> editor</li></ul></li></ul>", await list());
  check("the page shows it nested, and every item's text stays editable", (await s.count("li li")) == 1 && await editable(), await s.count("li li"));
  await s.clickEnd("li li");
  await press("Enter");
  await p.type("Fewer bugs");
  await Bun.sleep(150);
  check("Enter after it starts the next item at the same level", flat(await list()) == "<ul><li><p>Faster builds</p><ul><li>A <strong>new</strong> editor</li><li>Fewer bugs</li></ul></li></ul>", await list());

  await start("li li:first-child");
  await press("Tab", MOD.Shift);
  check("Shift+Tab takes it out; the items after it go with it, nested", flat(await list()) == "<ul><li>Faster builds</li><li><p>A <strong>new</strong> editor</p><ul><li>Fewer bugs</li></ul></li></ul>", await list());
  await p.type("A ");
  await Bun.sleep(150);
  check("the caret stays at the start of its text", (await s.source()).includes("<p>A A <strong>"), await list());
  await press("Backspace"); await press("Backspace");
  await start("li li");
  await press("Tab", MOD.Shift);
  check("and the last nested item out takes the <p> away again", flat(await list()) == "<ul><li>Faster builds</li><li>A <strong>new</strong> editor</li><li>Fewer bugs</li></ul>", await list());
  check("each item editable", await editable());

  await start("li:nth-child(2)");
  await press("Tab");
  await start("li:nth-child(2)");
  await press("Tab");
  check("the next item joins the nested list", flat(await list()) == "<ul><li><p>Faster builds</p><ul><li>A <strong>new</strong> editor</li><li>Fewer bugs</li></ul></li></ul>", await list());
  await start("li li:last-child");
  await press("Tab");
  check("Tab again: three levels", flat(await list()) == "<ul><li><p>Faster builds</p><ul><li><p>A <strong>new</strong> editor</p><ul><li>Fewer bugs</li></ul></li></ul></li></ul>", await list());
  check("on the page too", await until(async () => (await s.count("li li li")) == 1 && await editable()));
  await p.key("z", UNDO); await Bun.sleep(150);
  check("undo takes the last indent back", flat(await list()) == "<ul><li><p>Faster builds</p><ul><li>A <strong>new</strong> editor</li><li>Fewer bugs</li></ul></li></ul>", await list());
  if (process.platform == "darwin") await p.key("z", MOD.Meta | MOD.Shift); else await p.key("y", MOD.Ctrl);
  await Bun.sleep(150);
  check("redo puts it back", await until(async () => (await s.count("li li li")) == 1 && await editable()), await list());
  await p.screenshot(`${SHOTS}/indent-html-list.png`);
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

/** Enter makes an empty paragraph; typing, pasting or composing into it leaves no placeholder <br> behind, on the page or in the file. */
async function enterScenario(browser: Browser) {
  say("\nEnter and the placeholder <br>");
  const s = await session(browser, "page", "index.html");
  const { p, F } = s;
  const html = (sel: string) => p.frame<string>(`${F}.querySelector(${JSON.stringify(sel)}).innerHTML`);
  const around = async (re: RegExp) => (await s.source()).match(re)?.[0];
  // The editor's shortcut key: ⌘ on a Mac, Ctrl elsewhere.
  const mod = process.platform == "darwin" ? MOD.Meta : MOD.Ctrl;

  // Enter at the end, then typing.
  await s.clickEnd("blockquote p");
  await p.key("Enter");
  await Bun.sleep(80);
  await p.type("hello");
  await Bun.sleep(120);
  check("Enter at the end, then typing: the text fills the new paragraph", /<p>Typing never waits\.<\/p>\s*<p>hello<\/p>/.test(await s.source()), await around(/<blockquote>[\s\S]*?<\/blockquote>/));
  check("and the page has no <br> in it", (await html("blockquote p:nth-of-type(2)")) == "hello", await html("blockquote p:nth-of-type(2)"));
  check("saved without a <br>", await waitFor(() => /<p>hello<\/p>/.test(s.disk())), s.disk().match(/<blockquote>[\s\S]*?<\/blockquote>/)?.[0]);

  await p.key("z", mod);
  await Bun.sleep(100);
  check("undo gives back the empty paragraph, <br> and all", /<p>Typing never waits\.<\/p>\s*<p><br><\/p>/.test(await s.source()), await around(/<blockquote>[\s\S]*?<\/blockquote>/));
  await p.key("z", mod | MOD.Shift);
  await Bun.sleep(100);
  check("and redo the text, without it", /<p>hello<\/p>/.test(await s.source()), await around(/<blockquote>[\s\S]*?<\/blockquote>/));

  // Enter twice keeps a blank paragraph between, as the user asked for it: a <br> holds it open, so it shows on the page too.
  await s.clickEnd("blockquote p:nth-of-type(2)");
  await p.key("Enter"); await p.key("Enter");
  await Bun.sleep(80);
  await p.type("world");
  await Bun.sleep(120);
  check("Enter twice: a blank paragraph stays, then the text", /<p>hello<\/p>\s*<p><br><\/p>\s*<p>world<\/p>/.test(await s.source()), await around(/<blockquote>[\s\S]*?<\/blockquote>/));
  check("and the paragraph typed into has no <br>", (await html("blockquote p:nth-of-type(4)")) == "world", await html("blockquote p:nth-of-type(4)"));
  check("the blank paragraph has a line's height", await p.frame<boolean>(`${F}.querySelector("blockquote p:nth-of-type(3)").getBoundingClientRect().height > 10`));

  // Backspace at the start of "world" joins it to the blank paragraph: no <br> is left beside the text.
  await p.key("ArrowLeft"); await p.key("ArrowLeft"); await p.key("ArrowLeft"); await p.key("ArrowLeft"); await p.key("ArrowLeft");
  await p.key("Backspace");
  await Bun.sleep(100);
  check("Backspace into a blank paragraph leaves no <br>", /<p>hello<\/p>\s*<p>world<\/p>\s*<\/blockquote>/.test(await s.source()), await around(/<blockquote>[\s\S]*?<\/blockquote>/));

  // Enter at the start of a block: the empty half before it gets the <br>.
  await s.clickEnd("figcaption");
  await p.key("Home");
  await p.key("Enter");
  await Bun.sleep(100);
  check("Enter at the start leaves a blank block before, held open by a <br>", /<figcaption><br><\/figcaption>\s*<figcaption>Where the leads go\.<\/figcaption>/.test(await s.source()), await around(/<figure>[\s\S]*?<\/figure>/));

  // Enter in the middle splits the block, and typing goes at the start of the second half.
  const f = await frameAt(p);
  const mid = await p.frame<{ x: number; y: number }>(`(() => { const t = ${F}.querySelector("h2").firstChild; const r = ${F}.createRange(); r.setStart(t, 5); r.setEnd(t, 5); const b = r.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 }; })()`);
  await p.click(f.x + mid.x, f.y + mid.y);
  await Bun.sleep(80);
  await p.key("Enter");
  await Bun.sleep(80);
  await p.type("X");
  await Bun.sleep(120);
  check("Enter in the middle splits the block, typing starts the second half", /<h2>What <\/h2>\s*<h2>Xchanged<\/h2>/.test(await s.source()), await around(/<h2>What[\s\S]{0,60}/));

  // Paste into a new paragraph.
  await s.clickEnd("p.lede");
  await p.key("Enter");
  await Bun.sleep(80);
  await p.frame(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", "pasted"); ${F}.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await Bun.sleep(120);
  check("pasting into a new paragraph leaves no <br>", /<\/p>\s*<p class="lede">pasted<\/p>/.test(await s.source()), await around(/<p class="lede">[\s\S]*?<\/p>\s*<p>[\s\S]*?<\/p>/));

  // IME composition into a new paragraph.
  await p.key("Enter");
  await Bun.sleep(80);
  await p.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
  await Bun.sleep(40);
  await p.send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 });
  await Bun.sleep(40);
  await p.send("Input.insertText", { text: "仮名" });
  await Bun.sleep(150);
  check("composing into a new paragraph leaves no <br>", /<p class="lede">pasted<\/p>\s*<p class="lede">仮名<\/p>/.test(await s.source()), await around(/<p class="lede">pasted[\s\S]{0,40}/));
  check("and the page shows it once", (await p.frame<string>(`${F}.activeElement.innerHTML`)) == "仮名", await p.frame<string>(`${F}.activeElement.innerHTML`));
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

/** Backspace at the start of a block joins it to the one before: the block goes, its content moves, the caret stays at the join. */
async function joinScenario(browser: Browser) {
  say("\nBackspace joins a block to the one before");
  const s = await session(browser, "join", "index.html");
  const { p, F } = s;
  const mod = process.platform == "darwin" ? MOD.Meta : MOD.Ctrl;
  const original = await s.source();
  const main = async () => (await s.source()).match(/<main>[\s\S]*<\/main>/)?.[0];
  const caret = () => p.eval<number>("ergaPage.state.selection.main.head");
  /** Puts the caret at the start of an element's text and presses Backspace. */
  const backspaceAt = async (sel: string) => {
    await s.clickEnd(sel);
    await p.key("Home");
    await Bun.sleep(60);
    await p.key("Backspace");
    await Bun.sleep(100);
  };
  // [what, the block, the source after the join with "|" at the caret, the block before, its text after]
  const cases: [string, string, string, string, string][] = [
    ["a paragraph into a paragraph", "#beta", `<p id="alpha">Press Backspace at the <em>start</em>|of a paragraph to join it.</p>\n    <h2`, "#alpha", "Press Backspace at the startof a paragraph to join it."],
    ["a heading into a paragraph, which stays a paragraph", "#head", `<p id="beta">of a paragraph to join it.|A heading</p>\n    <p id="gamma">`, "#beta", "of a paragraph to join it.A heading"],
    ["a paragraph into a heading, which stays a heading", "#gamma", `<h2 id="head">A heading|keeps its own type.</h2>\n    <ul>`, "#head", "A headingkeeps its own type."],
    ["the first list item into the paragraph before the list", "#one", `<p id="gamma">keeps its own type.|Item one</p>\n    <ul>\n      <li id="two">`, "#gamma", "keeps its own type.Item one"],
    ["a list item into the one before", "#two", `<li id="one">Item one|Item two</li>\n    </ul>`, "#one", "Item oneItem two"],
    ["a paragraph after a list into its last item", "#after", `<li id="two">Item two|after the list.</li>\n    </ul>\n    <blockquote>`, "#two", "Item twoafter the list."],
    ["a quote's only paragraph, and the quote with it", "#quoted", `<p id="after">after the list.|A quote</p>\n    <figure>`, "#after", "after the list.A quote"],
  ];
  for (const [what, sel, joined, prevSel, prevText] of cases) {
    const plain = joined.replace("|", "");
    await backspaceAt(sel);
    const src = await s.source();
    check(`${what}: joins`, src.includes(plain) && !src.includes(`id="${sel.slice(1)}"`), await main());
    check(`${what}: the page shows it`, await until(async () => (await s.count(sel)) == 0 && (await s.textOf(prevSel)) == prevText), await s.textOf(prevSel).catch(() => "?"));
    const want = src.indexOf(plain) + joined.indexOf("|");
    check(`${what}: the caret is at the join`, (await caret()) == want && await p.frame<boolean>(`${F}.activeElement.matches(${JSON.stringify(prevSel)})`), `${await caret()}, not ${want}`);
    await p.key("z", mod);
    check(`${what}: one undo brings back both blocks`, await until(async () => (await s.source()) == original && (await s.count(sel)) == 1), await main());
  }
  check("a quote with nothing left goes", !/<blockquote>/.test((await (async () => { await backspaceAt("#quoted"); return s.source(); })())), await main());
  await p.key("z", mod);
  await until(async () => (await s.source()) == original);

  // Both items into the paragraph: the empty list goes too. Typing goes in at the join.
  await backspaceAt("#two");
  await p.key("Home");
  await p.key("Backspace");
  await Bun.sleep(100);
  await p.type("+");
  await Bun.sleep(120);
  check("a list with nothing left goes, and typing goes in at the join", (await s.source()).includes(`<p id="gamma">keeps its own type.+Item oneItem two</p>\n    <p id="after">`), await main());
  check("saved to disk", await waitFor(() => s.disk().includes("type.+Item oneItem two</p>"), 3000));
  await p.key("z", mod); await p.key("z", mod); await p.key("z", mod);
  check("and undo brings the list back", await until(async () => (await s.source()) == original && (await s.count("li")) == 2), await main());

  await backspaceAt("h1");
  check("in the first block, Backspace does nothing", (await s.source()) == original && (await caret()) == original.indexOf("Joining blocks</h1>"), await main());
  await backspaceAt("#cap");
  check("with a picture between, Backspace does nothing", (await s.source()) == original, await main());

  // Delete at the end of a block joins the next one to it the same way.
  await s.clickEnd("#head");
  await p.key("Delete");
  await Bun.sleep(100);
  check("Delete at the end joins the next block", (await s.source()).includes(`<h2 id="head">A headingkeeps its own type.</h2>`), await main());
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();

  // Markdown: the marks between the blocks go (a heading's, a list item's).
  const m = await session(browser, "md", "index.md");
  const mdOriginal = await m.source();
  await m.clickEnd("h2");
  await m.p.key("Home");
  await m.p.key("Backspace");
  await Bun.sleep(100);
  let md = await m.source();
  check("Markdown: a heading joins the paragraph before", md.includes("has an ampersand.Things to do\n\n- Water") && (await m.count("h2")) == 0, md.slice(0, 260));
  check("Markdown: the caret is at the join", (await m.p.eval<number>("ergaPage.state.selection.main.head")) == md.indexOf("Things to do"));
  await m.p.key("z", mod);
  check("Markdown: one undo brings back both", await until(async () => (await m.source()) == mdOriginal));
  // In a list item the first Backspace takes the marker off (tests/page.ts md), the second joins.
  await m.clickEnd("li:first-child");
  await m.p.key("Home");
  await m.p.key("Backspace");
  await m.p.key("Backspace");
  await Bun.sleep(100);
  md = await m.source();
  check("Markdown: then the list item joins the heading, which stays a heading", md.includes("## Things to doWater the plants\n- Call") && (await m.textOf("h2")) == "Things to doWater the plants", md.slice(0, 260));
  check("Markdown: no page errors", m.p.errors.length == 0, m.p.errors.join("\n"));
  await m.close();
}

/** evaluate_page's run, in this tab: an expression in view_page's render, its result as JSON; read-only, with a time limit and a size cap. */
async function evaluateScenario(browser: Browser) {
  say("\nInspecting the page for the agent");
  const s = await session(browser, "page", "index.html");
  const { p, F } = s;
  type Ev = { value?: string; note?: string; error?: string; errors: string[] };
  const ev = (expr: string, more = "") => p.eval<Ev>(`ergaPage.captureView({ evaluate: ${JSON.stringify(expr)}${more} })`);
  const h1Size = await p.frame<string>(`getComputedStyle(${F}.querySelector("h1")).fontSize`);
  const style = await ev(`getComputedStyle(document.querySelector("h1")).fontSize`);
  check("evaluate gives a computed style as JSON, as the page has it", style.value == JSON.stringify(h1Size) && !style.error, JSON.stringify(style));
  const box = await ev(`document.querySelector("figure").getBoundingClientRect()`);
  const rect = JSON.parse(box.value ?? "{}");
  check("and an element's size", rect.width > 100 && rect.height > 10 && "top" in rect, JSON.stringify(box));
  const els = await ev(`const all = [...document.querySelectorAll("h1, figure")]; return { all, fonts: [...document.fonts].length, styles: Object.keys(getComputedStyle(document.body)).length };`);
  const elsV = JSON.parse(els.value ?? "{}");
  check("statements with a return work, and elements read as tags", JSON.stringify(elsV.all) == '["<h1>","<figure>"]' && typeof elsV.fonts == "number", JSON.stringify(els));
  const before = await s.source();
  const changed = await ev(`(document.querySelector("h1").textContent = "Changed by evaluate", document.querySelector("h1").textContent)`);
  await Bun.sleep(500);
  check("what it changes stays in its throwaway render", changed.value == '"Changed by evaluate"' && (await s.source()) == before && !(await p.frame<string>(`${F}.querySelector("h1").textContent`)).includes("Changed"), JSON.stringify(changed));
  const up = await ev(`[parent, top, opener, frameElement, window.parent, window.frameElement]`);
  check("it doesn't reach the editor around the page", up.value == "[null,null,null,null,null,null]", JSON.stringify(up));
  const slow = await ev(`new Promise(() => {})`, ", timeout: 300");
  check("an expression that never finishes times out", /didn't finish within 300 ms/.test(slow.error ?? "") && slow.value == null, JSON.stringify(slow));
  const big = await ev(`"x".repeat(100000)`);
  check("a large result is cut, and says so", big.value?.length == 20000 && /100002 characters/.test(big.note ?? ""), JSON.stringify({ ...big, value: big.value?.length }));
  const threw = await ev(`document.querySelector("#nope").width`);
  check("an expression that throws says why", /The expression threw: TypeError/.test(threw.error ?? ""), JSON.stringify(threw));
  const bad = await ev(`1 +* 2`);
  check("and one that doesn't parse", /doesn't parse/.test(bad.error ?? ""), JSON.stringify(bad));
  const cyc = await ev(`(() => { const a = { n: 1n, f() {}, u: undefined }; a.self = a; return a; })()`);
  check("cycles, bigints and functions still make JSON", cyc.value == '{"n":"1n","f":"[function f]","u":null,"self":"[circular]"}', JSON.stringify(cyc));
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

const SCENARIOS: [string, (b: Browser) => Promise<void>][] = [
  ["html", htmlScenario], ["select", selectScenario], ["html", strayTagScenario], ["html", noEditScenario], ["html", brokenPageScenario], ["html", pauseScenario],
  ["md", mdScenario], ["md", lightOnlyScenario],
  ["format", formatScenario], ["view", evaluateScenario],
  ["agent", agentOffScenario], ["agent", shareScenario], ["agent", modelScenario], ["agent", agentEmptyScenario], ["agent", voiceScenario],
  ["reload", backdropReloadScenario],
  ["enter", enterScenario], ["join", joinScenario],
  ["indent", indentScenario], ["indent", htmlIndentScenario],
];
const browser = await Browser.launch();
try {
  const chosen = SCENARIOS.filter(([group]) => !only || only == group);
  // --keep holds a scenario's host open, so it only makes sense one at a time.
  const runOne = ([, f]: (typeof SCENARIOS)[number]) => out.run([], async () => {
    try { await f(browser); } catch (e) { check(`${f.name} ran to the end`, false, (e as Error).stack ?? String(e)); }
    console.log(out.getStore()!.join("\n"));
  });
  if (keep) for (const sc of chosen) await runOne(sc);
  else {
    // A few at a time (each has a dev server of its own; tests/cores.ts, or PAGE_JOBS): all fifteen at once overload a laptop, and the timing checks fail.
    const queue = [...chosen], at = Number(process.env.PAGE_JOBS) || testJobs().jobs;
    await Promise.all(Array.from({ length: at }, async () => { for (let sc; (sc = queue.shift());) await runOne(sc); }));
  }
} finally {
  if (!keep) browser.close();
}
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
