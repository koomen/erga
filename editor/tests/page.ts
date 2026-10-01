// End-to-end check of the page editor: starts the host on a scratch copy of
// a fixture, drives headless Chrome with real clicks and keys, and reads the
// file back from disk after each edit. Runs the HTML and the Markdown
// fixture. (Two people at once: tests/suite, `bun tests/suite/run.ts --suite browser`.)
//   bun tests/page.ts [html|md|format|agent|reload] [--keep]   (--keep leaves the host running and prints its URL)

import { Browser, MOD, ROOT } from "./cdp";
import { tab } from "./tab";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AsyncLocalStorage } from "node:async_hooks";

const keep = process.argv.includes("--keep");
const only = process.argv.find((a) => a == "html" || a == "md" || a == "agent" || a == "format" || a == "reload");

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
const loaded = (p: Awaited<ReturnType<Browser["page"]>>) => until(() => p.eval<boolean>(`!!window.scratchPage && !!document.getElementById("frame").contentDocument?.querySelector("[data-sw-id]") && !!document.getElementById("agent-model").textContent`), 10_000);

/** Starts a host on a scratch copy of a fixture and opens the editor on it. */
async function session(browser: Browser, fixture: string, fileName: string, env: Record<string, string> = {}, query = "", timescale = TIMESCALE) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dir = mkdtempSync(join(tmpdir(), "sw-page-"));
  cpSync(`${ROOT}editor/tests/fixtures/${fixture}`, dir, { recursive: true });
  const file = join(dir, fileName);
  const host = Bun.spawn(["bun", `${ROOT}editor/open.ts`, dir, "--port", String(port), "--no-open"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/doc`)).ok) break; } catch {}
    await Bun.sleep(15);
  }
  const p = await browser.page();
  await p.open(`http://127.0.0.1:${port}/${query}`, { clear: false, width: 1100, height: 800, timescale });
  await until(() => p.eval<boolean>(`!!window.scratchPage && !!document.getElementById("frame").contentDocument?.querySelector("[data-sw-id]")`), 10_000);
  // The page's own fonts too: text measured before they load moves when they do.
  await p.eval(`document.getElementById("frame").contentDocument.fonts.ready.then(() => true)`);
  await p.settle();
  const s = {
    ...tab(p),
    port, dir,
    disk: () => readFileSync(file, "utf8"),
    write: (text: string) => writeFileSync(file, text),
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
  say("\nHTML page");
  const s = await session(browser, "page", "index.html");
  const { p, F } = s;
  check("page rendered with units", (await s.count("[data-sw-id]")) >= 9);
  await p.eval(`${F}.body.style.background = "rgb(243, 236, 220)"`);
  check("the shell's canvas follows the page's background", await until(async () => await p.eval<string>(`getComputedStyle(document.documentElement).backgroundColor`) == "rgb(243, 236, 220)" && await p.eval<boolean>(`document.documentElement.classList.contains("page-light")`)));
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
  check("disk edits reach the page", await until(async () => (await s.textOf("figcaption")) == "Where the leads went."));
  const marks = s.marks;
  let m = await marks();
  check("disk edits patch the page in place", (await s.count("[data-sw-id]")) >= 9 && !(await p.eval<boolean>(`!!${F}.querySelector("figcaption.sw-flash")`)));
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
  check("a diagram added on disk shows up without a reload", await until(() => p.eval<boolean>(`!!${F}.getElementById("diagram")`)));
  await until(() => p.eval<boolean>(`!!${F}.querySelector("[data-sw-id]")`));
  check("and the page still edits", (await s.count("[data-sw-id]")) >= 9);

  // Another file in the folder changes: the page renders again and picks it up.
  const css = join(s.dir, "style.css");
  writeFileSync(css, readFileSync(css, "utf8") + "\nh1 { letter-spacing: 3px; }\n");
  check("a stylesheet change reaches the page", await until(() => p.eval<boolean>(`getComputedStyle(${F}.querySelector("h1")).letterSpacing == "3px"`)));

  await p.key("p", MOD.Meta | MOD.Shift);
  check("source view shows the file", await until(async () => await p.eval<boolean>(`document.body.classList.contains("source")`) && (await s.source()).includes("Where leads go now.")));
  await p.key("p", MOD.Meta | MOD.Shift);
  await until(() => p.eval<boolean>(`!document.body.classList.contains("source") && !!${F}.querySelector("h1[data-sw-id]")`));
  await s.clickEnd("h1");
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

async function mdScenario(browser: Browser) {
  say("\nMarkdown page");
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
  const s = await session(browser, "page", "index.html", { ANTHROPIC_API_KEY: "", SCRATCHWORK_AGENT_ENV_FILE: "/nonexistent/.env" });
  const { p } = s;
  await p.key("j", MOD.Meta);
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
}

/** Styling: the style bar, shortcuts across inline elements, Markdown as you type, and the view switcher. */
async function formatScenario(browser: Browser) {
  say("\nStyling and views");
  const s = await session(browser, "page", "index.html");
  const { p, F } = s;
  // Select from inside <strong>new</strong> into the plain text after it.
  const r = await p.eval<{ a: number; b: number; y: number }>(`(() => { const d = ${F}; const li = [...d.querySelectorAll("li")][1]; const st = li.querySelector("strong").firstChild, t = st.parentNode.nextSibling; const rg = d.createRange(); rg.setStart(st, 1); rg.setEnd(t, 4); const rs = rg.getClientRects(); const f = document.getElementById("frame").getBoundingClientRect(); return { a: f.left + rs[0].left + 1, b: f.left + rs[rs.length - 1].right - 1, y: f.top + rs[0].top + rs[0].height / 2 }; })()`);
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
  check("Enter at the end of a heading starts a well-formed paragraph", /<h2>Sub<\/h2>\s*<p><\/p>/.test(await s.source()), (await s.source()).match(/<h2>Sub[\s\S]{0,40}/)?.[0]);
  await p.type("- item");
  await Bun.sleep(150);
  check("'- ' makes a list, and typing straight after lands in it", /<ul>\s*<li>item<\/li>\s*<\/ul>/.test(await s.source()), (await s.source()).match(/<h2>Sub[\s\S]{0,80}/)?.[0]);
  await p.key("Enter"); await p.key("Enter");
  await Bun.sleep(150);
  check("Enter in an empty last item leaves the list", /<\/ul>\s*<p><\/p>/.test(await s.source()), (await s.source()).match(/<ul>\s*<li>item[\s\S]{0,60}/)?.[0]);
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
  const shot = await p.eval<{ png: number; width: number; height: number; errors: string[]; error?: string }>(`scratchPage.captureView({}).then((r) => ({ ...r, png: (r.png || "").length }))`);
  check("the page can be captured in the browser for the agent", shot.png > 1000 && shot.width > 300 && shot.height > 300 && !shot.error, JSON.stringify(shot));
  const fig = await p.eval<{ png: number; width: number; error?: string }>(`scratchPage.captureView({ selector: "figure" }).then((r) => ({ ...r, png: (r.png || "").length }))`);
  check("and so can one element", fig.png > 200 && fig.width > 100 && fig.width < 900 && !fig.error, JSON.stringify(fig));
  const none = await p.eval<{ error?: string }>(`scratchPage.captureView({ selector: "#nope" })`);
  check("a selector that matches nothing says so", /Nothing on the page matches #nope/.test(none.error ?? ""));

  // The view switcher.
  await p.eval(`document.querySelector("#mode [data-mode=text]").click()`);
  await Bun.sleep(100);
  check("clicking the view button shows all three views", await p.eval<boolean>(`document.getElementById("mode").classList.contains("open")`));
  await p.eval(`document.querySelector("#mode [data-mode=md]").click()`);
  await until(() => p.eval<boolean>(`!!document.querySelector("#source .cm-content")`));
  await p.settle();
  check("the Markdown view is as wide as the page's text column", await p.eval<boolean>(`(() => { const c = document.querySelector("#source .cm-content").getBoundingClientRect().width; const h = document.getElementById("frame").contentDocument.querySelector("h1").getBoundingClientRect().width; return Math.abs(c - h) < 4; })()`));
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
  check("the Markdown page stays light", (await p.eval<string>(`getComputedStyle(${F}.body).backgroundColor`)) == "rgb(255, 255, 255)");
  check("and so does the shell", (await p.eval<string>(`getComputedStyle(document.documentElement).backgroundColor`)) == "rgb(255, 255, 255)");
  check("there is no theme toggle", !(await p.eval<boolean>(`!!document.getElementById("btn-theme")`)));
  await s.close();
}

async function agentEmptyScenario(browser: Browser) {
  say("\nAgent, empty message");
  const s = await session(browser, "page", "index.html", { ANTHROPIC_API_KEY: "sk-ant-test-not-used", SCRATCHWORK_AGENT_ENV_FILE: "/nonexistent/.env" });
  const { p } = s;
  await p.key("j", MOD.Meta);
  await until(() => p.eval<boolean>(`/Type a message/.test(document.getElementById("agent-send").title)`));
  check("an empty message: Send says to type one", await p.eval<boolean>(`(() => { const b = document.getElementById("agent-send"); return b.getAttribute("aria-disabled") == "true" && /Type a message/.test(b.title); })()`));
  await p.key("Enter");
  await Bun.sleep(100);
  check("and pressing it says so in the panel", await p.eval<boolean>(`(() => { const h = document.getElementById("agent-hint"); return !h.hidden && /Type a message/.test(h.textContent); })()`));
  await p.type("x");
  await Bun.sleep(50);
  check("typing enables it and clears the hint", await p.eval<boolean>(`document.getElementById("agent-send").getAttribute("aria-disabled") == "false" && document.getElementById("agent-hint").hidden`));

  // A re-render (here, a stylesheet changing) doesn't pull focus out of the agent's input.
  await p.eval(`document.getElementById("agent-input").focus()`);
  writeFileSync(join(s.dir, "style.css"), readFileSync(join(s.dir, "style.css"), "utf8") + "\nh1 { color: rgb(1, 2, 3); }\n");
  await until(() => p.eval<boolean>(`getComputedStyle(document.getElementById("frame").contentDocument.querySelector("h1")).color == "rgb(1, 2, 3)"`));
  await p.settle();
  check("a page re-render leaves focus in the agent's input", (await p.eval<string>(`getComputedStyle(document.getElementById("frame").contentDocument.querySelector("h1")).color`)) == "rgb(1, 2, 3)" && (await p.eval<string>(`document.activeElement.id`)) == "agent-input");

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
  await p.eval(`location.reload()`);
  await Bun.sleep(150);
  check("an open pane is still open after a reload, from the first frame", await paneOpen());
  await loaded(p);
  await p.key("j", MOD.Meta);
  await p.settle();
  await p.eval(`location.reload()`);
  await Bun.sleep(50);
  await loaded(p);
  check("a collapsed pane stays collapsed after a reload", !(await paneOpen()) && (await p.eval<string>(`document.getElementById("agent-fab").getAttribute("aria-expanded")`)) == "false");
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
  check("the malformed paragraph is locked", await p.eval<boolean>(`${F}.querySelector(".box p").classList.contains("sw-locked")`));
  check("its neighbours aren't", await p.eval<boolean>(`!${F}.querySelector(".box h4").classList.contains("sw-locked") && !${F}.querySelector("body > p").classList.contains("sw-locked")`));
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

/** Parts marked data-sw-noedit: never editable by hand, and clicking them says so. */
async function noEditScenario(browser: Browser) {
  say("\nNo-edit parts");
  const s = await session(browser, "noedit", "index.html");
  const { p, F } = s;
  check("a no-edit section has no editable text", await p.eval<boolean>(`[...${F}.querySelectorAll(".fixed h2, .fixed p")].every((e) => !e.hasAttribute("data-sw-id") && !e.isContentEditable)`));
  check("a no-edit span inside a paragraph is fenced off", await p.eval<boolean>(`${F}.querySelector(".free").isContentEditable && !${F}.querySelector(".count").isContentEditable`));
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

/** The share button: a prompt with this page's API and a working token; Escape closes it. */
async function shareScenario(browser: Browser) {
  say("\nShare with an agent");
  const s = await session(browser, "noedit", "index.html");
  const { p } = s;
  await p.eval(`document.getElementById("btn-share").click()`);
  check("the share button opens its dialog", await p.eval<boolean>(`!document.getElementById("share").hidden && document.getElementById("btn-share").getAttribute("aria-expanded") == "true"`));
  check("with a prompt", await until(() => p.eval<boolean>(`document.getElementById("share-prompt").value.includes("Token: swx_")`)));
  const prompt = await p.eval<string>(`document.getElementById("share-prompt").value`);
  const token = /Token: (\S+)/.exec(prompt)?.[1], api = /API: (\S+)/.exec(prompt)?.[1];
  check("naming the API and the token, which works", !!api && !!token && (await fetch(api, { headers: { Authorization: `Bearer ${token}` } })).ok, prompt);
  await p.key("Escape");
  check("Escape closes it", await p.eval<boolean>(`document.getElementById("share").hidden`));
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  await s.close();
}

/** A page with problems nobody asked about/** A page with problems nobody asked about: each is explained in turn, with a button to have the agent fix it. */
async function brokenPageScenario(browser: Browser) {
  say("\nBroken page");
  const s = await session(browser, "broken", "index.html", { ANTHROPIC_API_KEY: "", SCRATCHWORK_AGENT_ENV_FILE: "/nonexistent/.env" });
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

const SCENARIOS: [string, (b: Browser) => Promise<void>][] = [
  ["html", htmlScenario], ["html", strayTagScenario], ["html", noEditScenario], ["html", brokenPageScenario],
  ["md", mdScenario], ["md", lightOnlyScenario],
  ["format", formatScenario],
  ["agent", agentOffScenario], ["agent", shareScenario], ["agent", agentEmptyScenario],
  ["reload", backdropReloadScenario],
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
  else await Promise.all(chosen.map(runOne));
} finally {
  if (!keep) browser.close();
}
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
