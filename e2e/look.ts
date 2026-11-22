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
import { copyFixture, descendants, startServer, type Server } from "./helpers/server";

const HELP = `bun run look [--doc <fixture | file.html | folder>] [--out <file.png>] [--source] [--latency <ms>] [--keep | --stop] [step ...]
bun run look --view [--doc ...] [--out <file.png>] [tap:<selector> | type:<text> | <key> | shows:<selector>]...
                                                            the document as a reader sees it, with no editor
bun run look --path /documents [--out <file.png>] [tap:<selector> | type:<text> | <key> | shows:<selector>]...
                                                            a page of the server by its path, signed in
bun run look --ops <host>[/<tab>] [--out <file.png>] [hover:<selector> | tap:<selector>]...
                                                            the ops page (bun erga) of an instance, with made-up facts

Opens a copy of the document in the editor, clicks at the end of its first text block, runs the steps,
then saves a screenshot and prints the page as a person sees it: "|" is the caret, "[" "]" a selection.

  --doc     a folder of e2e/fixtures (default: empty, one empty paragraph), or an HTML file or folder
  --out     where the screenshot goes (default: a new folder in .e2e/shots/ of this checkout)
  --width   the window's width in px (default 1100; a phone: 390), and --height (default 800)
  --dark    the browser asks for dark pages (prefers-color-scheme: dark)
  --real    the editor's timed behaviour at a person's speed (default: ten times faster, as in the journeys):
            the save mark's check stays its 3 s
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
  triple:<selector>    clicks three times in the element's text: the browser selects its block
  tap:<selector>       clicks a control of Erga's window around the page: tap:#btn-settings opens the settings
  bar:<selector>       clicks a control of the editor's own bar on the page (over a selection): bar:#type opens the type menu
  say:<text>           sends the text to the agent in its panel, and waits for the turn's end. The agent is the
                       scripted test model (agents/models.ts): "@script [steps]" in the text plays the steps.
                       (A server that --keep left running before a look with say: has no agent.)
  ask:<text>           sends the text to the agent, and does not wait: the screenshot shows the turn as it runs
                       (a script's last step with "delay": 20000 holds it). The look stops the turn at its end.
  wait:<text>          waits until the page shows the text: an edit of the agent's, for example
  open:<fixture>       opens another document in the same tab, in the editor: a copy of that folder of e2e/fixtures.
                       The same name opens the same copy again (the name of --doc: the first document). The agent's
                       panel is open there if it was open.
  shows:<selector>     waits until Erga's window around the page has an element that matches: shows:#save-state[data-at=error].
                       After 5 s with none, it says so and goes on.
  offline              the connection goes: the browser is offline, and each open socket closes. online: it is back.
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
    await fetch(`${k.root}/documents`, { redirect: "manual", signal: AbortSignal.timeout(5000) }).then(
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
  dark = flag("--dark"),
  real = flag("--real"),
  view = flag("--view");
const pathArg = option("--path");
const opsArg = option("--ops");
const viewport = { width: Number(option("--width")) || 1100, height: Number(option("--height")) || 800 };
const unknown = args.find((a) => a.startsWith("--"));
if (unknown) {
  console.error(`unknown option ${unknown}\n\n${HELP}`);
  process.exit(2);
}

// The ops page of this checkout (deploy/cli/ops-page.ts), on a small clone of its own with three made-up instances:
// example.net and notes.example.org track main, staging.example.net tracks staging. No instance is asked, and nothing
// deploys. The page is whole in this file: a proof runs this file in the folder of "before" too (deploy/cli/proof.ts).
if (opsArg != undefined) {
  const top = mkdtempSync(join(tmpdir(), "erga-look-ops-"));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: top, encoding: "utf8" }).stdout.trim();
  const erga = join(top, ".erga");
  let code = 0;
  let stop = () => {};
  const browser = await chromium.launch();
  try {
    git("init", "--quiet", "-b", "work");
    const subjects = [
      "The list shows each document's owner",
      "A page keeps its place after a reload",
      "Sign-in says why it refused",
      "Search finds a document by its title",
    ];
    const more = ["A comment shows its author's picture", "The editor keeps the caret after an undo", "Export makes a PDF of a page"];
    const now = Date.now();
    const commit = (subject: string, ago: number) => {
      const date = `${Math.round((now - ago * 60_000) / 1000)} +0000`;
      writeFileSync(join(top, `${subject.length}-${ago}.txt`), subject);
      git("add", "-A");
      spawnSync("git", ["-c", "user.name=Sam Reed", "-c", "user.email=sam@example.com", "commit", "--quiet", "-m", subject], {
        cwd: top,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
      return git("rev-parse", "HEAD");
    };
    const shas = [...subjects.map((x, i) => commit(x, 3000 - i * 300)), ...more.map((x, i) => commit(x, 200 - i * 80))];
    const main = shas[3],
      staging = shas[6];
    git("update-ref", "refs/remotes/origin/main", main);
    git("update-ref", "refs/remotes/origin/staging", staging);
    const feature = commit("A table sorts by a click on its head", 12);
    git("update-ref", "refs/remotes/origin/sort-tables", feature);
    const entry = (host: string, branch: string, upstream?: object) => ({
      host,
      repo: "example.net/team/erga",
      branch,
      ...(upstream ? { upstream } : {}),
      account: "a",
      worker: "w",
      database: "d",
      app: { kind: "workers.dev" },
      pages: { kind: "shared" },
      vars: {},
    });
    mkdirSync(join(erga, "jobs"), { recursive: true });
    writeFileSync(
      join(erga, "config.json"),
      JSON.stringify({
        instances: [
          entry("example.net", "main", { repo: "example.net/team/erga", branch: "staging" }),
          entry("staging.example.net", "staging", { repo: "example.net/team/erga", branch: "main" }),
          entry("notes.example.org", "main"),
        ],
      })
    );
    const runs: Record<string, string> = { "example.net": main, "staging.example.net": shas[5], "notes.example.org": shas[2] };
    /** A job of an instance's own record: a deploy of `sha` (a rollback with no commit), which ended well, or with `error`. */
    const jobs: import("../deploy/cli/ops-view").JobRecord[] = [];
    const job = (host: string, sha: string | null, ago: number, from: string, error?: string) =>
      jobs.unshift({
        kind: sha ? "deploy" : "rollback",
        host,
        commit: sha,
        branch: null,
        phase: error ? "failed" : "ok",
        id: String(jobs.length + 1),
        command: sha ? `bun erga deploy ${sha.slice(0, 12)} ${host}` : `bun erga rollback ${host}`,
        from,
        started: new Date(now - ago * 60_000).toISOString(),
        ended: new Date(now - ago * 60_000 + 64_000).toISOString(),
        ...(error ? { error } : {}),
        out: [error ? `FAIL  ${error}` : `PASS  ${host} runs ${sha ? sha.slice(0, 12) : "the version from before"}.`],
      });
    // Each head has a job, so auto-deploy starts nothing and the buttons are on. staging.example.net's deploy of
    // its head failed; notes.example.org took its head, and then a rollback.
    job("example.net", main, 290, "auto-deploy");
    job("staging.example.net", shas[5], 110, "auto-deploy");
    job("staging.example.net", staging, 38, "auto-deploy", `1 test failed on ${staging.slice(0, 12)}.`);
    job("notes.example.org", shas[2], 2300, "terminal");
    job("notes.example.org", main, 250, "auto-deploy");
    job("notes.example.org", null, 240, "terminal");
    const { serveOpsPage } = (await import(join(ROOT, "deploy/cli/ops-page.ts"))) as typeof import("../deploy/cli/ops-page");
    const served = serveOpsPage({
      dir: erga,
      cwd: top,
      port: 0,
      autoDeploy: true,
      ask: async (e) => ({ version: runs[e.host].slice(0, 12), healthy: true }),
      jobs: async (e) => ({
        jobs: jobs.filter((j) => j.host == e.host),
        cloud: false,
        autoMode: e.host == "staging.example.net" ? "commits" : "releases",
      }),
      fetch: async () => null,
      heads: async (_cwd, _repo, branches) => ({
        heads: Object.fromEntries(branches.map((b) => [b, b == "staging" ? staging : main])),
        tags: [
          { tag: "v0.4.0", sha: shas[2] },
          { tag: "v0.3.0", sha: shas[1] },
        ],
        error: null,
      }),
      // No deploy and no rollback: a job that a step starts never ends, and does nothing.
      run: () => ({ pid: 1, done: new Promise(() => {}) }),
    });
    stop = () => served.stop();
    const page = await browser.newPage({ viewport });
    await page.goto(`http://127.0.0.1:${served.server.port}/#${opsArg}`);
    await page
      .locator(".main .row")
      .first()
      .or(page.locator(".main .logs, .main .history, .main .note"))
      .first()
      .waitFor({ timeout: 15_000 });
    await page
      .locator(".dep.live")
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
    // The steps: the mouse over an element, or a click on it.
    for (const step of args) {
      const [, what, selector] = /^(hover|tap):(.+)$/.exec(step) ?? [];
      if (!what) throw new Error(`the ops page has no step ${step}: hover:<selector> or tap:<selector>`);
      await (what == "hover" ? page.hover(selector) : page.click(selector));
    }
    await page.screenshot({ path: out, fullPage: true });
    console.log(`screenshot: ${out}`);
  } catch (e) {
    console.error((e as Error).message);
    code = 1;
  } finally {
    await browser.close();
    stop();
    rmSync(top, { recursive: true, force: true });
  }
  process.exit(code);
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
  // (With a say: step, or a step that types "@script" (a comment to the agent), the agent is on, on the scripted model.)
  const s = await startServer({
    keep,
    latency,
    env: {
      ...(args.some((a) => /^(say|ask):/.test(a) || a.includes("@script")) ? { ERGA_AGENT_MODEL: "script" } : {}),
    },
  });
  ({ root, scratch } = s);
  if (keep) {
    writeFileSync(KEPT, JSON.stringify({ pid: s.pid()!, root, scratch } satisfies Kept));
  } else stop = () => s.dispose();
}
/** The documents open so far, by name: the first one (--doc), and each fixture of an open: step. */
const opened = new Map<string, { dir: string; address: string }>();
/** What openEditor needs of a server: a copy of the document, opened; the same copy for the same name. */
const server = {
  async fixture(name: string) {
    const was = opened.get(name);
    if (was) return was;
    const dir = join(scratch, "docs", `look-${Date.now()}`);
    if (name != docArg) copyFixture(name, dir);
    else if (path == fixtureDir) copyFixture(isDir ? docArg : dirname(docArg), dir);
    else cpSync(isDir ? path : dirname(path), dir, { recursive: true });
    const r = await fetch(`${root}/__erga/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dir }),
      redirect: "manual",
    });
    if (r.status != 303) throw new Error(`opening ${dir}: ${r.status} ${await r.text()}`);
    const doc = { dir, address: root + r.headers.get("location")!.replace(/[?&]edit$/, "") };
    opened.set(name, doc);
    return doc;
  },
} as unknown as Server;

const browser = await chromium.launch();
let code = 0;
try {
  const page = await browser.newPage({ viewport, colorScheme: dark ? "dark" : "light" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // And the page editor's check: where the page does not show its HTML (libs/text/ui/check.ts).
  page.on("console", (m) => {
    if (m.type() == "error" && m.text().includes("does not show its HTML")) errors.push(m.text());
  });
  if (view || pathArg) {
    // No editor: the page as it loads, once its requests and its fonts are done. Then the steps: a click on each control.
    await page.goto(pathArg ? root + pathArg : (await server.fixture(docArg)).address);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    for (const f of page.frames()) await f.evaluate(() => document.fonts.ready.then(() => null)).catch(() => {});
    for (const step of args) {
      // A click on a control; then keys into what has the focus (a field of a settings page), and a wait for a state.
      const [, verb, rest] = /^(tap|type|shows):([\s\S]*)$/.exec(step) ?? [];
      if (verb == "tap") await page.click(rest);
      else if (verb == "type") await page.keyboard.type(rest);
      else if (verb == "shows")
        await page
          .waitForSelector(rest, { state: "attached", timeout: 5000 })
          .catch(() => console.log(`shows: nothing matched ${rest} in 5 s`));
      else await page.keyboard.press(step);
      // (What the click opened has come to rest: no animation runs.)
      await page
        .waitForFunction(() => !document.getAnimations().some((a) => a.playState == "running"), null, { timeout: 5_000 })
        .catch(() => {});
    }
    await page.screenshot({ path: out });
    console.log(`screenshot: ${out}`);
    if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
    throw null;
  }
  const tab = { page, errors, strict: false, own: () => Promise.reject(new Error("no server of its own")) };
  // For the step offline: every socket that a page of the tab opens, in each frame, to close them as a lost connection
  // does. (In this file: a proof runs it in the folder of "before" too, with that folder's helpers.)
  await page.addInitScript(() => {
    const sockets: WebSocket[] = ((window as any).__sockets = []);
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    } as typeof WebSocket;
  });
  const speed = real ? { timescale: 1 } : {};
  let ed = await openEditor(tab, server, docArg, { ...speed, file: isDir ? undefined : basename(path) });
  await ed.clickEnd("[data-erga-text]:not(.erga-locked)");
  await ed.idle();
  /** The editor's own bar on the page is at rest: drawn (in the frame after a change), and its fade done. */
  const barRests = () =>
    ed
      .frame(
        `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => Promise.all((document.querySelector("erga-controls")?.shadowRoot.getAnimations() ?? []).map((a) => a.finished.catch(() => null))).then(() => done(null)))))`
      )
      .catch(() => {});
  for (const step of args) {
    const [, verb, rest] = /^(type|click|triple|tap|bar|shot|say|ask|wait|shows|open):([\s\S]*)$/.exec(step) ?? [];
    if (verb == "type") await ed.type(rest);
    else if (step == "offline") {
      await page.context().setOffline(true);
      for (const f of page.frames()) await f.evaluate(`(window.__sockets ?? []).forEach((s) => s.close())`).catch(() => {});
    } else if (step == "online") await page.context().setOffline(false);
    else if (verb == "shows")
      await page
        .waitForSelector(rest, { state: "attached", timeout: 5000 })
        .catch(() => console.log(`shows: nothing matched ${rest} in 5 s`));
    else if (verb == "open") {
      const agentOpen = () => page.evaluate(() => document.body.classList.contains("agent-open"));
      const was = await agentOpen();
      ed = await openEditor(tab, server, rest, { ...speed, ...(rest == docArg && !isDir ? { file: basename(path) } : {}) });
      // The agent's panel as it was (a phone's closes on each page), once it has read its thread.
      if (was && !(await agentOpen())) await page.click("#agent-fab");
      if (was) await page.waitForFunction(() => document.getElementById("agent-model")!.textContent, null, { timeout: 10_000 });
    }
    else if (verb == "wait") await page.frameLocator("#frame").getByText(rest).first().waitFor({ timeout: 15_000 });
    else if (verb == "say" || verb == "ask") {
      // The turn's end: one more answer or error in the panel, and the agent no longer at work.
      const ended = () =>
        page.evaluate(() =>
          document.getElementById("agent-fab")!.classList.contains("busy") || document.querySelector("#agent-log .msg-user.pending")
            ? -1
            : document.querySelectorAll("#agent-log .msg-assistant, #agent-log .msg-error").length
        );
      const before = await ended();
      if (!(await page.evaluate(() => document.body.classList.contains("agent-open")))) await page.click("#agent-fab");
      await page.focus("#agent-input");
      await page.keyboard.insertText(rest);
      await page.keyboard.press("Enter");
      if (verb == "say")
        await page.waitForFunction(
        (n) =>
          !document.getElementById("agent-fab")!.classList.contains("busy") &&
          !document.querySelector("#agent-log .msg-user.pending") &&
          document.querySelectorAll("#agent-log .msg-assistant, #agent-log .msg-error").length > n,
        Math.max(0, before),
        { timeout: 15_000 }
      );
    } else if (verb == "click") {
      await ed.clickEnd(rest);
      // (A click where the caret can't go: a widget, a part not editable by hand.)
      await ed.idle().catch(() => ed.settle());
    } else if (verb == "triple") {
      const at = await ed.rectOf(rest, 0.3);
      await ed.click(at.x, at.y, { clickCount: 3 });
    } else if (verb == "bar") {
      await barRests();
      await ed.clickIn("erga-controls", rest);
      await ed.settle();
    } else if (verb == "tap") {
      await page.click(rest);
      await ed.settle();
    } else if (verb == "shot") {
      await ed.settle();
      await barRests();
      await page.screenshot({ path: resolve(rest) });
      console.log(`screenshot: ${resolve(rest)}`);
    } else {
      const [, key, times] = /^(.+?)(?:\*(\d+))?$/.exec(step)!;
      for (let i = 0; i < Number(times ?? 1); i++) await ed.press(key);
    }
  }
  await ed.idle().catch(() => ed.settle());
  await barRests();
  await page.screenshot({ path: out });
  // A turn that still runs (ask:) stops here: the next look on a kept server finds the agent at rest.
  if (await page.locator("#agent-send.stop").count()) {
    await page.click("#agent-send.stop");
    await page.waitForFunction(() => !document.getElementById("agent-fab")!.classList.contains("busy"));
  }
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
