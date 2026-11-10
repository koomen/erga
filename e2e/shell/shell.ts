// Helpers for the shell's journeys (the editor's way in and out, its panels and bars, offline): a document's page in
// the viewer or the editor without openEditor's wait, and what the shell shows around the page.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Frame, Page } from "playwright-core";
import { TIMESCALE } from "../helpers/editor";
import { ROOT } from "../helpers/env";
import { expect, settle, until, type Server } from "../helpers/fixtures";

/** expect.poll that looks again every 20 ms (its own pause is 100 ms): for a state that comes within a frame or two. */
export const soon = <T>(read: () => T | Promise<T>, timeout?: number) =>
  expect.poll(read, { interval: 20, ...(timeout ? { timeout } : {}) });

let copies = 0;

/** A copy of e2e/fixtures/<name> with `files` put over it, linked as a document: its folder and address. */
export async function fixtureWith(server: Server, name: string, files: Record<string, string>) {
  const dir = join(server.scratch, "docs", `shell-${name}-${process.pid}-${++copies}`);
  cpSync(join(ROOT, "e2e/fixtures", name), dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { dir, address: await server.open(dir) };
}

/**
 * What openEditor sets in the tab before a page loads: the editor's timers at `timescale`, its check that the page
 * shows its HTML, and the agent pane kept closed. For a page that a journey opens itself (a held start, the viewer).
 */
export const asTester = (page: Page, timescale = TIMESCALE) =>
  page.addInitScript((timescale) => {
    if (window.top != window) return;
    (window as any).__ergaTimescale = timescale;
    (window as any).__ergaCheck = true;
    try {
      if (!sessionStorage.getItem("erga-test:agent-seeded")) {
        sessionStorage.setItem("erga-test:agent-seeded", "1");
        if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}');
      }
    } catch {
      /* no storage */
    }
  }, timescale);

/** Opens `url` in the tab and waits for its fonts: the viewer (or any page that openEditor does not open). */
export async function openPage(page: Page, url: string) {
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await settle(page);
}

/** The document's page in the tab's frame, viewing and editing alike. */
export const docFrame = (page: Page) =>
  page.frames().find((f) => f.parentFrame() == page.mainFrame() && /\/t\//.test(f.url())) as Frame | undefined;

/** Evaluates `expr` in the frames of the tab's own: the first answer that isn't null. */
export async function inPage<T>(page: Page, expr: string): Promise<T | null> {
  for (const f of page.frames()) {
    if (f.parentFrame() != page.mainFrame()) continue;
    const v = await f.evaluate(expr).catch(() => null);
    if (v != null) return v as T;
  }
  return null;
}

/** The page's heading, in the viewer or the editor. */
export const h1Of = (page: Page) => inPage<string>(page, `document.querySelector("h1")?.textContent ?? null`);

/** The tab's address: its path and query. */
export const where = (page: Page) => page.evaluate(() => location.pathname + location.search).catch(() => "");

/** The editor is up: its controls in the tab, and its half in the page, which has joined the room. */
export const editorUp = async (page: Page) =>
  (await page
    .evaluate(() => ["erga-editor-ready", "erga-editing", "erga-listening"].every((c) => document.body.classList.contains(c)))
    .catch(() => false)) &&
  (
    await Promise.all(
      page
        .frames()
        .filter((f) => f != page.mainFrame())
        .map((f) => f.evaluate("!!window.ergaFrame?.page && !ergaFrame.reloading").catch(() => false))
    )
  ).some(Boolean);

/** The viewer shows: its pencil up and not pressed, and the editor's controls hidden. */
export const viewing = (page: Page) =>
  page
    .evaluate(() => {
      const pencil = document.querySelector(".erga-edit-button");
      const wrap = document.getElementById("erga-editor");
      return (
        !!pencil &&
        getComputedStyle(pencil).visibility == "visible" &&
        pencil.getAttribute("aria-pressed") != "true" &&
        !(wrap && getComputedStyle(wrap).opacity != "0")
      );
    })
    .catch(() => false);

/** The bars' lowest edge, and the frame's top and height, in the tab. */
export const bars = (page: Page) =>
  page.evaluate(() => {
    const frame = document.getElementById("frame")!.getBoundingClientRect();
    return {
      bottom: Math.max(...[".chrome-nav", ".chrome-top"].map((s) => document.querySelector(s)!.getBoundingClientRect().bottom)),
      frame: frame.top,
      height: frame.height,
    };
  });

/** The text of the editor's welcome, if a person sees it: shown, not transparent, and on top at its middle. */
export const welcome = (page: Page) =>
  page.evaluate(() => {
    const w = document.getElementById("welcome")?.querySelector("p");
    if (!w?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return "";
    const r = w.getBoundingClientRect();
    return w.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) ? (w.parentElement!.textContent ?? "") : "";
  });

/**
 * A server that stalls: holds the editor's start (GET /api/start) and the shell's socket to the room until `release()`.
 * `drop()` closes the shell's sockets, as a network that goes away does. The socket, while held:
 *   "silent"  it is open, what the tab sends reaches the room, and what the room sends waits;
 *   "closed"  it does not reach the server at all: what happens to the document meanwhile comes before the room's hello.
 */
export async function hold(page: Page, socket: "silent" | "closed" = "silent") {
  let release = () => {};
  const released = new Promise<void>((r) => (release = r));
  const sockets: { close(): Promise<void> }[] = [];
  await page.route(/\/api\/start/, async (route) => {
    await released;
    await route.continue().catch(() => {});
  });
  await page.routeWebSocket(/\/api\/room\?events=1/, async (ws) => {
    sockets.push(ws);
    if (socket == "closed") await released;
    const server = ws.connectToServer();
    server.onMessage((m) => void released.then(() => ws.send(m)));
  });
  return {
    release,
    opened: () => sockets.length,
    drop: async () => {
      for (const ws of sockets.splice(0)) await ws.close().catch(() => {});
    },
  };
}

/** An element's box in the tab, once it rests: the same in two looks that follow each other (it slides in). */
export async function atRest(page: Page, selector: string) {
  await settle(page);
  let last = "";
  await until(
    async () => {
      const was = last;
      last = JSON.stringify(await page.locator(selector).boundingBox());
      return was == last && last != "null";
    },
    5000,
    `${selector} rests`
  );
  return JSON.parse(last) as { x: number; y: number; width: number; height: number };
}

/** The page that the editor edits (window.ergaPage.pagePath). */
export const editing = (page: Page) => page.evaluate(() => (window as any).ergaPage?.pagePath ?? "").catch(() => "");

type LogItem = { kind: string; name?: string; status?: string };

/** A scripted turn of the person's agent on a document (servers.main: "@script [...]"): the tool calls it made, once it is done. */
export async function agentTurn(server: Server, doc: string, text: string, steps: unknown[]) {
  const log = async () =>
    ((await (await fetch(`${server.root}/api/agent/conversation`)).json()) as { log: { busy: boolean; items: LogItem[] } }).log;
  const before = (await log()).items.length;
  const tools = steps.filter((x) => (x as { tool?: string }).tool).length;
  const sent = await fetch(`${server.root}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: server.root },
    body: JSON.stringify({ text: `${text} @script ${JSON.stringify(steps)}`, doc }),
  });
  if (!sent.ok) throw new Error(`the agent didn't take the prompt: ${sent.status}`);
  const done = await until(
    async () => {
      const l = await log();
      return !l.busy && l.items.slice(before).filter((i) => i.kind == "tool").length >= tools ? l : null;
    },
    10_000,
    "the agent's turn ends"
  );
  return done!.items.slice(before).filter((i) => i.kind == "tool");
}
