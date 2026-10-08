// Helpers for the tree's tests (src/page/tree.ts, built as pages-tree.js):
// a fresh copy of
// e2e/fixtures/multi linked as one of DEV_LOGIN's documents, the server's
// own view of its files, the agents' tools over a token, and the tree's rows
// read and clicked in a tab (the editor's title card, or a row on Documents).
//
// The fixture: index.html ("Field guide"), about.html ("About us"),
// contact.html, blog/ (index.html, spring-migration.html, drafts/owls.html),
// and files that aren't documents (style.css, assets/owl.svg,
// fonts/field.woff2), which the tree never shows.

import type { Page } from "playwright-core";
import { expect, settle, until, type Server, type Tab } from "../../fixtures";

/** What a person never sees in the tree: a document's stylesheets, scripts, fonts, images and data, and folders of only those. */
export const NOT_DOCUMENTS = /\.(css|js|mjs|json|svg|png|jpe?g|gif|webp|woff2?|ttf|otf|txt|csv)$|^(assets|fonts)$/i;

/** Evaluates an expression in the tab, its value as any (for expect.poll, whose matchers need a type). */
export const js = (page: Page, expr: string) => page.evaluate(expr) as Promise<any>;

export const row = (path: string) => `.et-row[data-path="${path}"]`;

/** Signs in (locally, /auth/github?as= signs in anyone; none: DEV_LOGIN): the session's cookie. */
export async function signIn(server: Server, as: string | null) {
  const r = await fetch(`${server.root}/auth/github?${as ? `as=${as}&` : ""}next=/docs`, { redirect: "manual" });
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => /^erga_session(_\d+)?=/.test(c));
  if (!cookie) throw new Error(`signing in: ${r.status}`);
  return cookie;
}

export type Doc = Awaited<ReturnType<typeof multi>>;

/** A fresh copy of e2e/fixtures/multi, linked as a document, with ways to read and change it as the server and an agent. */
export async function multi(server: Server) {
  const { dir, address: base } = await server.fixture("multi");
  const info = (await (await fetch(`${base}/api/doc`)).json()) as { docName: { id: string; address: string } };
  const { id, address } = info.docName;
  let token = "";
  const doc = {
    dir, id, root: server.root,
    /** The document's address (http://.../<owner>/<id>), and its path alone. */
    base, address,
    /** Every file and folder the server lists for it (agents see them all), sorted. */
    tree: async () => ((await (await fetch(`${server.root}/api/docs/${id}/tree`)).json()) as { entries: { path: string }[] }).entries.map((e) => e.path).sort(),
    /** One of the agents' tools, over the token API, on this document, as its owner. */
    async agentTool(name: string, args: Record<string, unknown> = {}) {
      if (!token) token = await agentToken(server);
      const r = await fetch(`${server.root}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ document: id, ...args }) });
      const body = (await r.json()) as { ok: boolean; content?: { text?: string }[]; error?: string };
      expect(body.ok, `the agent's ${name}: ${JSON.stringify(body)}`).toBe(true);
      return body.content?.map((c) => c.text ?? "").join("\n") ?? "";
    },
  };
  return doc;
}

/** An agent token for DEV_LOGIN, made on /tokens as a person does. */
async function agentToken(server: Server) {
  const owner = await signIn(server, null);
  const page = await until(async () => {
    const t = await (await fetch(`${server.root}/tokens/new`, { method: "POST", redirect: "manual", headers: { Cookie: owner, Origin: server.root }, body: new URLSearchParams({ label: "Tree test" }) })).text();
    return t.includes('class="secret"') ? t : "";
  }, 5000, "an agent token");
  return /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)![1];
}

/** As someone who keeps the agent pane closed (it opens by itself in the editor otherwise, and takes the focus). */
export const agentClosed = (page: Page) => page.addInitScript(() => {
  if (window.top != window) return;
  try {
    if (!sessionStorage.getItem("erga-test:agent-seeded")) {
      sessionStorage.setItem("erga-test:agent-seeded", "1");
      if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}');
    }
  } catch { /* no storage */ }
});

/**
 * The editor at `url` (an address, without #edit), up: the shell ready with the document's title, the tree's script
 * mounted (still closed), and the page in its frame rendered and focused.
 *
 * That last part is the editor's own ready state, and it matters: the shell focuses the page each time the frame
 * reports a render (main.ts, onUpdate), unless the focus is in a card, and the frame takes the focus a message later
 * (Remote.focus, then frame.ts's "focus"). If the frame starts late (a busy machine), a card opened meanwhile loses
 * its focus to it. So the tests wait until the page has the focus, as a person sees the editor ready, before they open
 * a card.
 */
export async function openTreeEditor(tab: Tab, url: string, opts: { query?: string; focus?: boolean } = {}) {
  const page = tab.page;
  tab.strict = true;
  await agentClosed(page);
  await page.goto(`${url}${opts.query ?? ""}#edit`);
  await until(() => page.evaluate(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden && !!window.ergaPage`), 10_000, "the editor is up with its title");
  await until(() => page.evaluate(`!!window.ergaTree && !!document.querySelector("#pages #pages-tree .et-row[data-path]")`), 10_000, "the editor loads pages-tree.js once it is up, and mounts the tree");
  if (opts.focus ?? !opts.query) await editorFocused(page);
}

/** The page in the editor's frame is rendered and has the focus (see openTreeEditor). */
export const editorFocused = (page: Page) => until(async () => {
  if (await page.evaluate(`document.activeElement?.id != "frame"`)) return false;
  for (const f of page.frames()) if (await f.evaluate(`!!window.ergaFrame && document.hasFocus() && !!document.getElementById("page")?.dataset.ready`).catch(() => false)) return true;
  return false;
}, 10_000, "the page in the editor's frame is rendered and has the focus");

/** The rows the tree shows: [path, label, depth, current]. */
export const rows = (page: Page, within = "") => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${within} .et-row[data-path]`.trim())})].map((r) => [r.dataset.path, r.querySelector(".et-name").textContent, +r.getAttribute("aria-level"), r.getAttribute("aria-current") == "page"])`) as Promise<[string, string, number, boolean][]>;
export const paths = async (page: Page, within = "") => (await rows(page, within)).map((r) => r[0]);

/** The middle of the first element `selector` names, on screen. */
export async function centre(page: Page, selector: string) {
  return until(() => page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`) as Promise<{ x: number; y: number } | null>, 3000, `${selector} is on the page`) as Promise<{ x: number; y: number }>;
}
export async function clickOn(page: Page, selector: string) {
  const r = await centre(page, selector);
  await page.mouse.click(r.x, r.y);
  await settle(page);
}

// The tree draws its rows again after each change, and when the server says the tree changed (a moment later, and
// later still on a busy machine). If that happens between a press and its release, they land on different rows, and
// the browser sends no click. So a click on a row that must open a menu or a page is tried again until it does.

/** Clicks a row that leaves the page, until the tab is at `want` (a path and hash). */
export async function clickToGo(page: Page, selector: string, want: string) {
  for (let tries = 0; ; tries++) {
    const r = await centre(page, selector);
    await page.mouse.click(r.x, r.y);
    try { return await until(() => { const u = new URL(page.url()); return u.pathname + u.hash == want; }, 2500, `the tab goes to ${want}`); }
    catch (e) { if (tries == 2) throw e; }
  }
}

/** Hovers a row (its buttons show), then clicks one of them; a menu button until its menu opens. */
export async function act(page: Page, path: string, which: "add" | "more" | "rename", within = "") {
  const sel = `${within} ${row(path)}`.trim();
  const press = async () => {
    const r = await centre(page, sel);
    await page.mouse.move(r.x, r.y);
    await clickOn(page, `${sel} [data-act="${which}"]`);
  };
  if (which == "rename") return press();
  for (let tries = 0; ; tries++) {
    await press();
    try { return await until(() => page.evaluate(`!!document.querySelector(".et-menu")`), 2000, `${which} on ${path} opens its menu`); }
    catch (e) { if (tries == 2) throw e; }
  }
}

/** The open menu's items. */
export const menuItems = (page: Page) => page.evaluate(`[...document.querySelectorAll('.et-menu [role="menuitem"]')].map((b) => b.textContent.trim())`) as Promise<string[]>;

/** Clicks the open menu's item labelled `label`. */
export async function menuItem(page: Page, label: string) {
  const found = await until(() => page.evaluate(`(() => { const b = [...document.querySelectorAll('.et-menu [role="menuitem"]')].find((b) => b.textContent.trim() == ${JSON.stringify(label)}); if (b) b.setAttribute("data-pick", ""); return !!b; })()`), 2000, `the menu has ${label}`).catch(async () => { throw new Error(`the menu has no ${label}: ${(await menuItems(page)).join(", ")}`); });
  expect(found).toBe(true);
  await clickOn(page, ".et-menu [data-pick]");
}

/** Where the focus is: a row's path, "input" for the tree's name field, else the focused element's tag. */
export const focused = (page: Page) => page.evaluate(`document.activeElement?.closest?.("[data-path]")?.dataset.path ?? (document.activeElement?.classList.contains("et-input") ? "input" : document.activeElement?.tagName ?? null)`) as Promise<string | null>;

/** Windows key codes for the keys sent as plain DevTools key events. */
const RAW: Record<string, number> = { Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, F2: 113 };

/**
 * Presses a key. Home, End, the arrows and F2 go as plain DevTools key events: Playwright
 * on a Mac turns some into the Mac's own editing commands.
 */
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
export async function openCard(page: Page, atLeast = 1) {
  await clickOn(page, "#doc-title");
  await until(() => page.evaluate(`!document.getElementById("pages").hidden && document.querySelectorAll("#pages .et-row[data-path]").length >= ${atLeast}`), 5000, "the tree shows");
}
