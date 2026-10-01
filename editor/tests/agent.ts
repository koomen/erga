// Live check of the embedded agent: starts the host on a scratch copy of the
// HTML fixture, opens the agent panel with ⌘J, asks for two edits (one to
// the page, one to its stylesheet), and checks that they land on disk and in
// the open page without a reload. Calls the real API, so it needs
// ANTHROPIC_API_KEY (in wip/editor/.env or the environment) and costs a little.
//   bun tests/agent.ts [--keep]

import { Browser, MOD, ROOT } from "./cdp";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "fs";
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

const port = 4500 + Math.floor(Math.random() * 400);
const dir = mkdtempSync(join(tmpdir(), "sw-agent-"));
cpSync(`${ROOT}editor/tests/fixtures/page`, dir, { recursive: true });
const file = join(dir, "index.html");
const host = Bun.spawn(["bun", `${ROOT}editor/open.ts`, dir, "--port", String(port), "--no-open"], { stdout: "pipe", stderr: "pipe" });
const browser = await Browser.launch();
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/doc`)).ok) break; } catch {}
    await Bun.sleep(100);
  }
  const info = await (await fetch(`http://127.0.0.1:${port}/api/agent`)).json() as { enabled: boolean; reason?: string; model?: string };
  check("agent is on", info.enabled, info.reason);
  if (!info.enabled) throw new Error("agent off");
  console.log(`     model: ${info.model}`);

  const p = await browser.page();
  await p.open(`http://127.0.0.1:${port}/`, { clear: false, width: 1280, height: 800 });
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
  check("sending clears the saved draft", (await p.eval<string | null>(`localStorage.getItem("scratchwork-editor:agent-draft:v1")`)) == null);
  console.log(`     took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const disk = readFileSync(file, "utf8");
  check("the edits are on disk", disk.includes("<h1>Notes from the field</h1>") && disk.includes("<li>Buy seeds</li>"), disk.slice(0, 300));
  check("the page shows them", (await p.eval<string>(`${F}.querySelector("h1").textContent`)) == "Notes from the field"
    && (await p.eval<string>(`${F}.querySelector("ul").textContent`)).includes("Buy seeds"));
  check("without a reload", await p.eval<boolean>(`document.getElementById("frame").contentWindow.__marker == 1`));
  check("the panel shows the edit", await p.eval<boolean>(`[...document.querySelectorAll(".msg-tool")].some((e) => /Edited/.test(e.textContent))`));
  check("and a reply", await p.eval<boolean>(`!!document.querySelector(".msg-assistant")?.textContent.trim()`));

  await ask(`Make the h1 color red (#c00) in style.css.`);
  check("the stylesheet edit is on disk", /#c00|red/i.test(readFileSync(join(dir, "style.css"), "utf8")));
  check("and reaches the page", await until(async () => (await p.eval<string>(`getComputedStyle(${F}.querySelector("h1")).color`)) == "rgb(204, 0, 0)", 3000));

  await ask(`Add a small inline SVG bar chart with id "chart" right after the first list. Plain SVG, no script. Then look at it on the page to check it renders.`);
  check("a diagram from the agent appears without a manual refresh", await until(() => p.eval<boolean>(`!!${F}.getElementById("chart")`), 4000),
    JSON.stringify({ disk: readFileSync(file, "utf8").includes('id="chart"'), stale: await p.eval(`scratchPage.page.stale`), pill: await p.eval(`document.getElementById("refresh-pill").hidden`), mode: await p.eval(`document.body.className`), tools: await p.eval(`[...document.querySelectorAll(".msg-tool")].map(e => e.textContent).join(" | ")`) }));
  check("and the refresh pill is gone once it finishes", await p.eval<boolean>(`document.getElementById("refresh-pill").hidden`));
  check("the agent looked at its work, and the panel shows what it saw", await p.eval<boolean>(`[...document.querySelectorAll(".msg-tool")].some((e) => /Looked at the page/.test(e.textContent) && e.querySelector("img.shot")?.naturalWidth > 0)`),
    await p.eval<string>(`[...document.querySelectorAll(".msg-tool")].map((e) => e.textContent).join(" | ")`));

  const log = await (await fetch(`http://127.0.0.1:${port}/api/agent`)).json() as { log: { items: unknown[] } };
  check("the host keeps the transcript", log.log.items.length >= 4);
  await p.screenshot(`${ROOT}editor/screenshots/page-agent.png`);
  check("no page errors", p.errors.length == 0, p.errors.join("\n"));
  if (keep) {
    console.log(`\nhost kept at http://127.0.0.1:${port}/  (${dir})`);
    await new Promise(() => {});
  }
} finally {
  if (!keep) { browser.close(); host.kill(); rmSync(dir, { recursive: true, force: true }); }
}
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
