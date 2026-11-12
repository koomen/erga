// The pages tree (client/pages/pages-tree.ts) in a tab, for its journey: a copy of e2e/fixtures/multi linked as one of
// DEV_LOGIN's documents, the server's own view of its files, an agent's tools, and the tree's rows read and clicked.
//
// The fixture: index.html ("Field guide"), about.html ("About us"), contact.html (no title), blog/ (with drafts/),
// and files that aren't pages (style.css, assets/owl.svg, fonts/field.woff2). Several pages: it is a project.
//
// Trap: the tree draws all its rows again after each change, and once more when the server's "tree" event comes (a
// moment later, and later still on a busy machine). A press and its release that land on two drawings of a row make
// no click. So a step makes each change inside `changing`, which waits until the event has come and the tree has read
// the server again; where a tree opens, `answered` waits for its first read. The page counts both itself (`watchTree`).

import type { Page } from "playwright-core";
import { expect, settle, until, type Server } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";
import { clickOn } from "../helpers/press";
import { runTool, textOf } from "../helpers/tools";

export { agentClosed } from "./people";

/** Evaluates an expression in the tab, its value as any (for expect.poll, whose matchers need a type). */
export const js = (page: Page, expr: string) => page.evaluate(expr) as Promise<any>;

export const row = (path: string) => `.et-row[data-path="${path}"]`;

export type Doc = Awaited<ReturnType<typeof multi>>;

/** A fresh copy of e2e/fixtures/multi, linked as a document, with ways to read and change it as the server and an agent. */
export async function multi(server: Server) {
  const { dir, address: base } = await server.fixture("multi");
  const name = async () =>
    ((await (await fetch(`${server.root}/d/${id}/api/doc`)).json()) as { docName: { id: string; address: string; title: string } }).docName;
  const id = ((await (await fetch(`${base}/api/doc`)).json()) as { docName: { id: string } }).docName.id;
  let token = "";
  return {
    dir,
    id,
    root: server.root,
    /** The document's address when it was made (http://.../<owner>/<slug>). */
    base,
    /** Its title and its address now (a new title moves it). */
    name,
    /** Every file and folder that the server lists for it, sorted. */
    tree: async () =>
      ((await runTool(server.root, "ls", { document: id })).result as { entries: { path: string }[] }).entries.map((e) => e.path).sort(),
    /** One of the agents' tools, with a token of the owner's, on this document. */
    async agentTool(tool: string, args: Record<string, unknown> = {}) {
      if (!token) token = (await newToken(server.root, { label: "Tree journey" })).token;
      const r = await runTool(server.root, tool, { document: id, ...args }, { token });
      expect(r.ok, `the agent's ${tool}: ${JSON.stringify(r)}`).toBe(true);
      return textOf(r.result);
    },
  };
}

/**
 * Before the page opens: the tab keeps the server's "tree" events (window.__tree, each event's detail as JSON) and
 * counts its own calls of the operations that have no answer yet (window.__calls). A call counts as answered one task
 * after its answer is read, when the tree has drawn it.
 */
export const watchTree = (page: Page) =>
  page.addInitScript(() => {
    if (window.top != window) return;
    const w = window as unknown as { __tree: string[]; __calls: number; __open: string[] };
    w.__tree = [];
    w.__calls = 0;
    w.__open = [];
    window.addEventListener("erga-tree", (e) => w.__tree.push(JSON.stringify((e as CustomEvent).detail)));
    const send = window.fetch;
    window.fetch = ((...a: Parameters<typeof fetch>) => {
      if (!String(a[0] instanceof Request ? a[0].url : a[0]).includes("/api/tools/")) return send(...a);
      w.__calls++;
      const call = `${a[0] instanceof Request ? a[0].url : a[0]} ${(a[1]?.body as string | undefined)?.slice(0, 120) ?? ""}`;
      w.__open.push(call);
      const done = () =>
        setTimeout(() => {
          w.__calls--;
          w.__open.splice(w.__open.indexOf(call), 1);
        }, 0);
      return send(...a).then(
        (r) => {
          const json = r.json.bind(r);
          r.json = () => json().finally(done);
          return r;
        },
        (e) => {
          done();
          throw e;
        }
      );
    }) as typeof fetch;
  });

/** The "tree" events that the tab has heard: each one's detail, as JSON. */
export const treeEvents = (page: Page) => page.evaluate(() => (window as unknown as { __tree: string[] }).__tree);

/** Every call of an operation from the tab has its answer, and the tree has drawn it: its rows stay until the next change. */
export const answered = (page: Page) =>
  until(
    () => page.evaluate(() => !(window as unknown as { __calls?: number }).__calls),
    5000,
    "the tab's calls have their answers",
    () => page.evaluate(() => (window as unknown as { __open?: string[] }).__open)
  );

/**
 * The server's last event for a change: a new page or folder says "tree"; a move says "tree", then "moved" with the
 * two paths; a delete "tree", then "deleted"; a new kind says "kind".
 */
export type Last = "tree" | "moved" | "deleted" | "kind";

/**
 * Does `change` (a change of the tree, in the tab or from elsewhere), then waits until the tab has heard the server's
 * last event for it and the tree has read the server again: its rows stay now.
 */
export async function changing<T>(page: Page, change: () => Promise<T>, last: Last = "tree"): Promise<T> {
  const before = (await treeEvents(page)).length;
  const done = await change();
  await until(
    () =>
      page.evaluate(
        ([from, last]) => {
          const w = window as unknown as { __tree: string[]; __calls: number };
          return w.__tree.slice(from as number).some((e) => e.includes(`"${last}"`)) && w.__calls == 0;
        },
        [before, last]
      ),
    10_000,
    `the tree follows the server's "${last}" event`,
    () =>
      page.evaluate(() => {
        const w = window as unknown as { __tree: string[]; __calls: number };
        return [w.__tree, w.__calls];
      })
  );
  return done;
}

/** Opens the editor at `url` (an address) and waits until it is up with its title; the tree's script may not be there yet. */
export async function up(page: Page, url: string, query = "") {
  await page.goto(`${url}${query ? `${query}&edit` : "?edit"}`);
  await until(
    () =>
      page.evaluate(
        `document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden && !!window.ergaPage`
      ),
    10_000,
    "the editor is up with its title"
  );
}

/** The editor has mounted the tree (still closed, unless ?pages), and the page in its frame is rendered. */
export async function treeUp(page: Page) {
  await until(
    () => page.evaluate(`!!window.ergaTree && !!document.querySelector("#pages #pages-tree .et-row[data-path]")`),
    10_000,
    "the editor mounts the tree"
  );
  await until(
    async () => {
      for (const f of page.frames()) if (await f.evaluate(`!!window.ergaFrame?.page`).catch(() => false)) return true;
      return false;
    },
    10_000,
    "the page in the editor's frame is rendered"
  );
}

/**
 * The page in the editor's frame is rendered and has the focus, as a person sees the editor ready. The frame takes the
 * focus as it starts, a message after the shell gives it: a card opened before that loses its focus to the page.
 */
export const editorFocused = (page: Page) =>
  until(
    async () => {
      if (await page.evaluate(`document.activeElement?.id != "frame"`)) return false;
      for (const f of page.frames())
        if (await f.evaluate(`!!window.ergaFrame && document.hasFocus() && !!window.ergaFrame?.page`).catch(() => false)) return true;
      return false;
    },
    10_000,
    "the page in the editor's frame is rendered and has the focus"
  );

/** The rows that the tree shows: [path, label, depth, current]. */
export const rows = (page: Page, within = "") =>
  page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(`${within} .et-row[data-path]`.trim())})].map((r) => [r.dataset.path, r.querySelector(".et-name").textContent, +r.getAttribute("aria-level"), r.getAttribute("aria-current") == "page"])`
  ) as Promise<[string, string, number, boolean][]>;
export const paths = async (page: Page, within = "") => (await rows(page, within)).map((r) => r[0]);

/** The tree's rows as they read on the screen, one line each. */
export const lines = (page: Page, within: string) =>
  page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(`${within} .et-row[data-path]`)})].map((r) => r.innerText.replace(/\\s+/g, " ").trim())`
  ) as Promise<string[]>;

/** How many right edges the pages' file names have, rounded: one when they line up. */
export const edges = (page: Page, within: string) =>
  page.evaluate(
    `new Set([...document.querySelectorAll(${JSON.stringify(`${within} .et-ext`)})].map((e) => Math.round(e.getBoundingClientRect().right))).size`
  ) as Promise<number>;

/**
 * The middle of the first element that `selector` names, once it can be clicked: on the page, with nothing over it,
 * and its bar showing. The editor's bars hide while the page changes and come back as the pointer moves: so the pointer
 * moves to the place while it waits, as a person's does.
 */
export async function centre(page: Page, selector: string) {
  let at: { x: number; y: number } | null = null;
  await until(
    async () => {
      const r = (await page.evaluate((s) => {
        const el = document.querySelector(s),
          r = el?.getBoundingClientRect();
        if (!el || !r?.width) return null;
        const x = r.x + r.width / 2,
          y = r.y + r.height / 2,
          top = document.elementFromPoint(x, y);
        return { x, y, free: !!top && (el == top || el.contains(top)) && getComputedStyle(el.closest(".chrome") ?? el).opacity == "1" };
      }, selector)) as { x: number; y: number; free: boolean } | null;
      if (!r) return false;
      if (r.free) return (at = r);
      await page.mouse.move(r.x + (at ? 0 : 3), r.y, { steps: 2 });
      at = null;
      return false;
    },
    5000,
    `${selector} can be clicked`
  );
  return at!;
}
/** Hovers a row (its buttons show), then clicks one of them; a menu button's menu opens. */
export async function act(page: Page, path: string, which: "add" | "more" | "rename", within = "") {
  const sel = `${within} ${row(path)}`.trim();
  const r = await centre(page, sel);
  await page.mouse.move(r.x, r.y);
  await clickOn(page, `${sel} [data-act="${which}"]`);
  if (which != "rename")
    await until(() => page.evaluate(`!!document.querySelector(".et-menu")`), 3000, `${which} on ${path} opens its menu`);
}

/** The open menu's items. */
export const menuItems = (page: Page) =>
  page.evaluate(`[...document.querySelectorAll('.et-menu [role="menuitem"]')].map((b) => b.textContent.trim())`) as Promise<string[]>;

/** Clicks the open menu's item labelled `label`. */
export async function menuItem(page: Page, label: string) {
  await until(
    () =>
      page.evaluate((label) => {
        const b = [...document.querySelectorAll('.et-menu [role="menuitem"]')].find((b) => b.textContent!.trim() == label);
        b?.setAttribute("data-pick", "");
        return !!b;
      }, label),
    3000,
    `the menu has ${label}`,
    () => menuItems(page)
  );
  await clickOn(page, ".et-menu [data-pick]");
}

/** Where the focus is: a row's path, "input" for the tree's name field, else the focused element's tag. */
export const focused = (page: Page) =>
  page.evaluate(
    `document.activeElement?.closest?.("[data-path]")?.dataset.path ?? (document.activeElement?.classList.contains("et-input") ? "input" : document.activeElement?.tagName ?? null)`
  ) as Promise<string | null>;

/** Windows key codes for the keys sent as plain DevTools key events. */
const RAW: Record<string, number> = { Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, F2: 113 };

/** Presses a key. Home, End, the arrows and F2 go as plain DevTools key events: Playwright on a Mac turns some into the Mac's own editing commands. */
export async function press(page: Page, key: string) {
  if (key in RAW) {
    const cdp = await page.context().newCDPSession(page);
    const k = { key, code: key, windowsVirtualKeyCode: RAW[key] };
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
    await cdp.detach();
  } else await page.keyboard.press(key);
  await settle(page);
}

/** Types text as input events, a character at a time. */
export async function type(page: Page, text: string) {
  for (const ch of text) await page.keyboard.insertText(ch);
}

/** Opens the editor's title card and waits for its rows. */
export async function openCard(page: Page) {
  await clickOn(page, "#doc-title");
  await until(
    () => page.evaluate(`!document.getElementById("pages").hidden && document.querySelectorAll("#pages .et-row[data-path]").length >= 1`),
    5000,
    "the tree shows"
  );
  // (The tree reads the server as it opens, and draws its rows again.)
  await answered(page);
}
