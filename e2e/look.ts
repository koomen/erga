#!/usr/bin/env bun
// bun run look: opens a document in the editor in headless Chromium, presses keys as a person would, then saves a
// screenshot and prints the visible snapshot (e2e/helpers/visible.ts). The way to see a change as a person does.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { openEditor } from "./helpers/editor";
import { ROOT } from "./helpers/env";
import { descendants, startServer, type Server } from "./helpers/server";

const HELP = `bun run look [--doc <fixture | file.html | folder>] [--out <file.png>] [--source] [--latency <ms>] [--keep | --stop] [step ...]
bun run look --view [--doc ...] [--out <file.png>]     the document as a reader sees it, with no editor and no steps
bun run look --path /docs [--out <file.png>]           a page of the server by its path, signed in

Opens a copy of the document in the editor, clicks at the end of its first text block, runs the steps,
then saves a screenshot and prints the page as a person sees it: "|" is the caret, "[" "]" a selection.

  --doc     a folder of e2e/fixtures (default: empty, one empty paragraph), or an HTML file or folder
  --out     where the screenshot goes (default: a new folder in .e2e/shots/ of this checkout)
  --width   the window's width in px (default 1100; a phone: 390), and --height (default 800)
  --source  print the page's body as HTML too
  --latency a network's delay between the tab and the room, each way: 120, or a range 60-180 (ms);
            a server left running with --keep has the delay it started with
  --keep    leave the dev server running, for the next look (a new server takes about 10 s)
  --stop    stop the server that --keep left running

Steps, one argument each, in order:
  type:<text>          types the text, a character at a time
  <key>                presses a key or combination: Enter, Tab, Shift+Tab, Backspace, ArrowUp, Home,
                       Shift+Enter, ControlOrMeta+z (undo), ControlOrMeta+Shift+z (redo), ...
  <key>*<n>            presses it n times: Backspace*3
  click:<selector>     clicks at the end of the element's text (a CSS selector in the page)
  shot:<file.png>      a screenshot at this step, too

Example:
  bun run look 'type:Groceries' Enter 'type:- Milk' Enter 'type:Eggs' Enter Tab 'type:Brown'`;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
if (flag("--help") || flag("-h")) {
  console.log(HELP);
  process.exit(0);
}

/** The kept server's record, one for each checkout. */
const KEPT = join(tmpdir(), `erga-look-${Bun.hash(ROOT).toString(36)}.json`);
type Kept = { pid: number; root: string; scratch: string };
/** The kept server, if it still answers. */
const kept = async (): Promise<Kept | null> => {
  if (!existsSync(KEPT)) return null;
  const k = JSON.parse(readFileSync(KEPT, "utf8")) as Kept;
  if (
    await fetch(`${k.root}/docs`, { redirect: "manual", signal: AbortSignal.timeout(5000) }).then(
      (r) => r.ok,
      () => false
    )
  )
    return k;
  // Gone: its PID may be another process's by now, so nothing is killed.
  rmSync(k.scratch, { recursive: true, force: true });
  rmSync(KEPT, { force: true });
  return null;
};
const stopKept = (k: Kept) => {
  for (const p of [k.pid, ...descendants(k.pid)])
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* gone */
    }
  rmSync(k.scratch, { recursive: true, force: true });
  rmSync(KEPT, { force: true });
};

if (flag("--stop")) {
  const k = await kept();
  if (k) stopKept(k);
  console.log(k ? `stopped the server at ${k.root} (pid ${k.pid})` : "no server was kept");
  process.exit(0);
}

const docArg = option("--doc") ?? "empty";
// In the checkout, not the system's temporary folder: an agent may read only its own worktree.
const shots = join(ROOT, ".e2e", "shots");
mkdirSync(shots, { recursive: true });
const out = resolve(option("--out") ?? join(mkdtempSync(join(shots, "look-")), "page.png"));
const latency = option("--latency");
const keep = flag("--keep"),
  source = flag("--source"),
  view = flag("--view");
const pathArg = option("--path");
const viewport = { width: Number(option("--width")) || 1100, height: Number(option("--height")) || 800 };
const unknown = args.find((a) => a.startsWith("--"));
if (unknown) {
  console.error(`unknown option ${unknown}\n\n${HELP}`);
  process.exit(2);
}

// The document: a fixture's folder, or a file or folder of yours. A copy opens, so the steps never change the original.
const fixtureDir = join(ROOT, "e2e/fixtures", docArg);
const path = existsSync(fixtureDir) ? fixtureDir : resolve(docArg);
if (!existsSync(path)) {
  console.error(`no fixture, file or folder ${docArg}\n\n${HELP}`);
  process.exit(2);
}
const isDir = statSync(path).isDirectory();

// The editor's files, built for the server (startServer runs it with ERGA_BUILT).
const built = spawnSync("bun", [join(ROOT, "client/build.ts")], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
if (built.status != 0) process.exit(built.status ?? 1);

/** The server: the kept one, or a new one (kept, or stopped at the end, by its PID). */
let root: string, scratch: string, stop: (() => void) | undefined;
const k = await kept();
if (k) ({ root, scratch } = k);
else {
  const s = await startServer({ keep, latency });
  ({ root, scratch } = s);
  if (keep) {
    writeFileSync(KEPT, JSON.stringify({ pid: s.pid()!, root, scratch } satisfies Kept));
  } else stop = () => s.dispose();
}
/** What openEditor needs of a server: a copy of the document, opened. */
const server = {
  async fixture() {
    const dir = join(scratch, "docs", `look-${Date.now()}`);
    cpSync(isDir ? path : dirname(path), dir, { recursive: true });
    const r = await fetch(`${root}/__erga/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dir }),
      redirect: "manual",
    });
    if (r.status != 303) throw new Error(`opening ${dir}: ${r.status} ${await r.text()}`);
    return { dir, address: root + r.headers.get("location")!.replace(/[?&]edit$/, "") };
  },
} as unknown as Server;

const browser = await chromium.launch();
let code = 0;
try {
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // And the page editor's check: where the page does not show its HTML (libs/text/ui/check.ts).
  page.on("console", (m) => {
    if (m.type() == "error" && m.text().includes("does not show its HTML")) errors.push(m.text());
  });
  if (view || pathArg) {
    // No editor: the page as it loads, once its requests and its fonts are done.
    await page.goto(pathArg ? root + pathArg : (await server.fixture(docArg)).address);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    for (const f of page.frames()) await f.evaluate(() => document.fonts.ready.then(() => null)).catch(() => {});
    await page.screenshot({ path: out });
    console.log(`screenshot: ${out}`);
    if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
    throw null;
  }
  const tab = { page, errors, strict: false, own: () => Promise.reject(new Error("no server of its own")) };
  const ed = await openEditor(tab, server, docArg, { file: isDir ? undefined : basename(path) });
  await ed.clickEnd("[data-erga-text]:not(.erga-locked)");
  await ed.idle();
  for (const step of args) {
    const [, verb, rest] = /^(type|click|shot):([\s\S]*)$/.exec(step) ?? [];
    if (verb == "type") await ed.type(rest);
    else if (verb == "click") {
      await ed.clickEnd(rest);
      await ed.idle();
    } else if (verb == "shot") {
      await ed.settle();
      await page.screenshot({ path: resolve(rest) });
      console.log(`screenshot: ${resolve(rest)}`);
    } else {
      const [, key, times] = /^(.+?)(?:\*(\d+))?$/.exec(step)!;
      for (let i = 0; i < Number(times ?? 1); i++) await ed.press(key);
    }
  }
  await ed.idle().catch(() => ed.settle());
  await page.screenshot({ path: out });
  console.log(await ed.visible());
  if (source) console.log(`\n${(await ed.source()).replace(/[\s\S]*<body[^>]*>\n?|<\/body>[\s\S]*/g, "")}`);
  console.log(`\nscreenshot: ${out}`);
  if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
} catch (e) {
  // null: the picture of --view or --path is done.
  if (e) {
    console.error((e as Error).message);
    code = 1;
  }
} finally {
  await browser.close();
  stop?.();
}
process.exit(code);
