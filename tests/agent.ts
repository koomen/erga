// Live check of the agent editor: starts the host on a scratch copy of the
// HTML fixture, opens the agent panel with ⌘J, asks for two edits (one to
// the page, one to its stylesheet), and checks that they reach the open page
// through the document room without a reload, and the disk after it, that
// the agent shows up as a participant, and that its last change can be undone. Calls the real API, so it needs
// ANTHROPIC_API_KEY (in .env or the environment) and costs a little.
//   bun tests/agent.ts [--keep]

import { Browser, MOD, ROOT } from "./cdp";
import { startHost } from "./host";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const keep = process.argv.includes("--keep");
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : "\n     " + detail}`);
  if (!ok) failures++;
};
async function until(f: () => Promise<boolean> | boolean, ms: number) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await Bun.sleep(100); }
  return f();
}

const dir = mkdtempSync(join(tmpdir(), "erga-agent-"));
cpSync(`${ROOT}tests/fixtures/page`, dir, { recursive: true });
const file = join(dir, "index.html");
const host = await startHost(dir);
const browser = await Browser.launch();
try {
  const info = await (await fetch(`${host.base}/api/agent`)).json() as { enabled: boolean; reason?: string; model?: string };
  check("agent is on", info.enabled, info.reason);
  if (!info.enabled) throw new Error("agent off");
  console.log(`     model: ${info.model}`);

  const p = await browser.page();
  await p.open(`${host.base}/`, { clear: false, width: 1280, height: 800 });
  await Bun.sleep(500);
  const F = `document.getElementById("frame").contentDocument`;
  await p.eval(`document.getElementById("frame").contentWindow.__marker = 1`);

  await p.key("j", MOD.Meta);
  await Bun.sleep(200);
  check("⌘J opens the panel with the input focused", await p.eval<boolean>(`document.body.classList.contains("agent-open") && document.activeElement.id == "agent-input"`));

  const ask = async (text: string) => {
    await p.type(text);
    await p.key("Enter");
    await until(() => p.eval<boolean>(`document.getElementById("agent-send").textContent == "Stop"`), 5000);
    return until(async () => !(await p.eval<boolean>(`document.getElementById("agent-send").classList.contains("stop")`)), 90_000);
  };

  const t0 = Date.now();
  const done = await ask(`Change the first heading to "Notes from the field", and add a list item "Buy seeds" at the end of the first list.`);
  check("the agent finishes", done);
  check("sending clears the saved draft", (await p.eval<string | null>(`localStorage.getItem("erga:agent-draft:v1")`)) == null);
  console.log(`     took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const onDisk = () => { const d = readFileSync(file, "utf8"); return d.includes("<h1>Notes from the field</h1>") && d.includes("<li>Buy seeds</li>"); };
  check("the edits are on disk", await until(onDisk, 2000), readFileSync(file, "utf8").slice(0, 300));
  check("the page shows them", (await p.eval<string>(`${F}.querySelector("h1").textContent`)) == "Notes from the field"
    && (await p.eval<string>(`${F}.querySelector("ul").textContent`)).includes("Buy seeds"));
  check("without a reload", await p.eval<boolean>(`document.getElementById("frame").contentWindow.__marker == 1`));
  check("the panel shows the edit", await p.eval<boolean>(`[...document.querySelectorAll(".msg-tool")].some((e) => /Edited/.test(e.textContent))`));
  check("and a reply", await p.eval<boolean>(`!!document.querySelector(".msg-assistant")?.textContent.trim()`));
  check("the agent is a participant: its badge is on its owner's avatar", await p.eval<boolean>(`[...document.querySelectorAll("#people .agent-badge")].some((e) => /agent/.test(e.dataset.tip))`));
  check("and its caret sits where it last edited", await p.eval<boolean>(`[...${F}.querySelectorAll("erga-peer[data-agent] erga-peer-name")].some((e) => /agent/.test(e.textContent))`));

  // Undo the agent's last change (one tool call), from the panel.
  const before = await p.eval<string>(`ergaPage.state.doc.toString()`);
  check("its undo is on", (await p.eval<string>(`document.getElementById("agent-undo").getAttribute("aria-disabled")`)) == "false");
  await p.eval(`document.getElementById("agent-undo").click()`);
  check("undo takes back the agent's last change", await until(async () => (await p.eval<string>(`ergaPage.state.doc.toString()`)) != before, 2000));
  const undone = await p.eval<string>(`ergaPage.state.doc.toString()`);
  check("and only that", (undone.includes("Notes from the field") != undone.includes("Buy seeds")) || (!undone.includes("Notes from the field") && !undone.includes("Buy seeds")), undone.slice(0, 400));

  await ask(`Make the h1 color red (#c00) in style.css.`);
  check("the stylesheet edit is on disk", /#c00|red/i.test(readFileSync(join(dir, "style.css"), "utf8")));
  check("and reaches the page", await until(async () => (await p.eval<string | null>(`(() => { const h = ${F}?.querySelector("h1"); return h && getComputedStyle(h).color; })()`)) == "rgb(204, 0, 0)", 3000));

  await ask(`Add a small inline SVG bar chart with id "chart" right after the first list. Plain SVG, no script. Then look at it on the page to check it renders.`);
  check("a diagram from the agent appears without a manual refresh", await until(() => p.eval<boolean>(`!!${F}.getElementById("chart")`), 4000),
    JSON.stringify({ disk: readFileSync(file, "utf8").includes('id="chart"'), stale: await p.eval(`ergaPage.page.stale`), pill: await p.eval(`document.getElementById("refresh-pill").hidden`), mode: await p.eval(`document.body.className`), tools: await p.eval(`[...document.querySelectorAll(".msg-tool")].map(e => e.textContent).join(" | ")`) }));
  check("and the refresh pill is gone once it finishes", await p.eval<boolean>(`document.getElementById("refresh-pill").hidden`));
  check("the agent looked at its work, and the panel shows what it saw", await p.eval<boolean>(`[...document.querySelectorAll(".msg-tool")].some((e) => /Looked at the page/.test(e.textContent) && e.querySelector("img.shot")?.naturalWidth > 0)`),
    await p.eval<string>(`[...document.querySelectorAll(".msg-tool")].map((e) => e.textContent).join(" | ")`));

  // A paragraph broken on disk: clicking it explains, and "Fix with agent" repairs it.
  writeFileSync(file, readFileSync(file, "utf8").replace("things &amp; ship them.", "things</h2> &amp; ship them."));
  check("the broken paragraph gets locked", await until(() => p.eval<boolean>(`!!${F}.querySelector("p.lede.erga-locked")`), 5000));
  const lede = await p.eval<{ x: number; y: number }>(`(() => { const r = ${F}.querySelector("p.lede").getBoundingClientRect(), f = document.getElementById("frame").getBoundingClientRect(); return { x: f.left + r.left + 20, y: f.top + r.top + r.height / 2 }; })()`);
  await p.click(lede.x, lede.y);
  await Bun.sleep(150);
  check("clicking it offers the agent's help", await p.eval<boolean>(`!!document.querySelector("#toast.show .toast-fix")`));
  await p.eval(`document.querySelector("#toast .toast-fix").click()`);
  check("the agent sets to work", await until(() => p.eval<boolean>(`document.getElementById("agent-send").classList.contains("stop")`), 5000));
  await until(async () => !(await p.eval<boolean>(`document.getElementById("agent-send").classList.contains("stop")`)), 90_000);
  check("and fixes it: the paragraph edits again", await until(() => p.eval<boolean>(`!!${F}.querySelector("p.lede") && !${F}.querySelector("p.lede").classList.contains("erga-locked")`), 5000));
  const fixedLede = readFileSync(file, "utf8").match(/<p class="lede">[\s\S]*?<\/p>/)?.[0] ?? "";
  check("with its text untouched", fixedLede == `<p class="lede">Build <em>cool</em> things &amp; ship them. This paragraph has <a href="https://example.com">a link</a> and <code>code</code>.</p>`, fixedLede);

  const log = await (await fetch(`${host.base}/api/agent`)).json() as { log: { items: unknown[] } };
  check("the host keeps the transcript", log.log.items.length >= 4);
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  if (keep) {
    console.log(`\nhost kept at ${host.base}/  (${dir})`);
    await new Promise(() => {});
  }
} finally {
  if (!keep) { browser.close(); await host.dispose(); rmSync(dir, { recursive: true, force: true }); }
}
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
