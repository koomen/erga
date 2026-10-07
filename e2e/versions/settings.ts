// Helpers for the document settings tests (src/page/settings.ts) on
// servers.short(): documents whose every version is its own draft ("Draft n"
// in the page), the editor opened at a document's #edit address, and the
// settings popover's parts.

import type { Page } from "playwright-core";
import { editor } from "../editor";
import { settle, until, type Server, type Tab } from "../fixtures";
import { Participant, person, roomOf } from "./versions";

/** A page whose paragraph says which draft it is: each version of the documents here has its own. */
export const draftPage = (title: string, n: number, style = "body{font:18px/1.6 Georgia,serif;max-width:36rem;margin:12vh auto;padding:0 20px}") =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title><style>${style}</style></head>\n<body><h1>${title}</h1>\n<p id="draft">Draft ${n}</p>\n<p>Each version of this page says which draft it is.</p>\n</body></html>\n`;

/** DEV_LOGIN ("tester", an admin), whom the tests' tabs are signed in as. */
export const tester = (server: Server) => person(server, "tester");

/** The documents' room connections, closed after each test (closeDrafts, in test.afterEach). */
const open = new Set<Participant>();
export const closeDrafts = () => { for (const p of open) p.disconnect(); open.clear(); };

/**
 * A new document of DEV_LOGIN's with versions 1..upTo, each version n its own draft: written by someone in its room
 * (as an editor's tab does, so the versions follow the people's rules, not an agent's turn), then cut by a publish of
 * what's published already, so nothing changes for viewers in "manual". `address` follows the title once the page has
 * one.
 */
export async function draftDoc(server: Server, title: string, upTo: number, style?: string) {
  const owner = await tester(server);
  const { id } = await owner.newDoc();
  const ada = await Participant.join(roomOf(server, id), "tester");
  open.add(ada);
  let first = true;
  const doc = {
    id, owner, address: "", room: ada,
    /** Writes draft n (not cut: a version once the edits pause, or at the next publish). */
    draft(n: number) {
      ada.edit((t) => {
        if (first) { t.delete(0, t.length); t.insert(0, draftPage(title, n, style)); first = false; return; }
        const m = /Draft \d+/.exec(t.toString())!;
        t.delete(m.index, m[0].length);
        t.insert(m.index, `Draft ${n}`);
      });
    },
    /**
     * Holds back the cut of what's pending until `release()`: the room waits for an agent mid-turn (its busy flag on
     * awareness, worker/doc-host.ts agentWorking), so edits stay "not in a version" however slow the test is.
     */
    async hold() {
      const agent = await Participant.join(roomOf(server, id), "tester");
      open.add(agent);
      agent.provider.awareness.setLocalState({ user: { ...agent.me, kind: "agent" }, busy: true, cursor: null });
      return { release: () => { agent.disconnect(); open.delete(agent); } };
    },
    /** Versions up to `upTo`, each its own draft. */
    async versions(upTo: number) {
      for (let n = (await owner.versions(id)).total + 1; n <= upTo; n++) {
        doc.draft(n);
        await until(async () => (await owner.versions(id)).pending, 5_000, `the edit for version ${n} reaches the room`);
        const { published } = await owner.versions(id);
        const r = await owner.publish(id, published.mode == "latest" ? { mode: "latest" } : { mode: "manual", versionId: published.version.id });
        if (!r.ok) throw new Error(`cutting version ${n}: ${r.status}`);
      }
      const s = await owner.versions(id);
      if (s.total != upTo) throw new Error(`the document has ${s.total} versions, not ${upTo}`);
    },
  };
  await doc.versions(upTo);
  // Its address follows its title (the page's first heading) once it's no longer blank.
  doc.address = await until(async () => { const a = ((await (await owner.get(`/d/${id}/api/name`)).json()) as { address: string }).address; return a.includes(slug(title)) && a; }, 5_000, "the document takes its title's address");
  return doc;
}

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export interface EditorOptions { width?: number; height?: number; user?: string; dark?: boolean; mobile?: boolean }

/** The editor on a document, at its #edit address, in `page`, as someone who keeps the agent pane closed; once the gear shows. */
export async function openDocEditor(page: Page, server: Server, address: string, o: EditorOptions = {}) {
  await page.setViewportSize({ width: o.width ?? 1200, height: o.height ?? 820 });
  if (o.dark) await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    if (window.top != window) return;
    try { if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}'); } catch { /* no storage */ }
  });
  await page.goto(`${server.root}${address}${o.user ? `?user=${o.user}` : ""}#edit`);
  await until(() => rect(page, "#btn-settings"), 10_000, "the gear shows");
  return settings(page);
}

type Rect = { x: number; y: number; w: number; h: number; top: number; right: number; bottom: number; left: number };
export const rect = (p: Page, sel: string) => p.evaluate((sel) => {
  const r = document.querySelector(sel)?.getBoundingClientRect();
  return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left } : null;
}, sel) as Promise<Rect | null>;

/** The settings popover in an editor tab. */
export function settings(p: Page) {
  const ed = editor(p, { address: "", dir: "", file: "" });
  const s = {
    page: p, ed,
    eval: <T = any>(expr: string) => p.evaluate(expr) as Promise<T>,
    rect: (sel: string) => rect(p, sel),
    /** Where it is once it holds still (a list that scrolls or grows, or a toolbar that lays out, moves it). */
    async steadyRect(sel: string) {
      let r = await rect(p, sel);
      for (let i = 0; i < 20; i++) {
        await settle(p);
        const again = await rect(p, sel);
        if (r && again && again.x == r.x && again.y == r.y) break;
        r = again;
      }
      return r;
    },
    async clickOn(sel: string) {
      await p.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "nearest" }), sel);
      const r = await s.steadyRect(sel);
      if (!r) throw new Error(`${sel} isn't on the page`);
      await p.mouse.click(r.x, r.y);
    },
    isOpen: () => p.evaluate(() => !!document.getElementById("doc-settings") && !document.getElementById("doc-settings")!.hidden),
    text: (sel: string) => p.evaluate((sel) => document.querySelector(sel)?.textContent?.trim() ?? "", sel),
    attr: (sel: string, name: string) => p.evaluate(([sel, name]) => document.querySelector(sel!)?.getAttribute(name!) ?? null, [sel, name]),
    firstRow: () => p.evaluate(() => document.querySelector("#ds-list li")?.textContent ?? ""),
    /** The open menu's rows: version numbers, and "…N" for a row of N more. */
    menuRows: () => p.evaluate(() => [...document.querySelectorAll(".ds-menu [role=option]")].map((o) => (o.id.startsWith("ds-ver-") ? o.id.slice(7) : "…" + ((o.textContent ?? "").match(/\d+/) || [""])[0])).join(" ")),
    hasMenu: () => p.evaluate(() => !!document.querySelector(".ds-menu")),
    focused: () => p.evaluate(() => document.activeElement?.id ?? ""),
    /** Opens the popover, once the gear can be clicked (the editor's controls fade in as it comes up), and its versions are in. */
    async open() {
      await until(() => p.evaluate(() => { const g = document.getElementById("btn-settings"), r = g?.getBoundingClientRect(); return !!r?.width && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("#btn-settings") == g && getComputedStyle(g!.closest(".chrome")!).opacity == "1"; }), 10_000, "the gear can be clicked");
      if (!(await s.isOpen())) await s.clickOn("#btn-settings");
      await until(() => s.isOpen(), 5_000, "the settings open");
      await until(async () => !["Loading…", ""].includes(await s.text("#ds-mode")), 5_000, "the versions load");
    },
    async close() {
      if (await s.isOpen()) { await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); }
      await until(async () => !(await s.isOpen()), 5_000, "the settings close");
    },
    /** A publish has finished saving (the menus are off limits while it saves). */
    saved: () => until(async () => (await s.attr("#ds-mode", "aria-disabled")) == null, 5_000, "the publish is saved"),
    /** Every status line the homepage section showed, from now on (a deploy can be quick: each one is caught as it's drawn). */
    watchStatus: () => p.evaluate(() => {
      const w = window as any;
      w.__seen = []; w.__locked = [];
      const el = document.getElementById("ds-status")!, btn = document.getElementById("ds-redeploy")!;
      const note = () => { const t = el.textContent!.trim(); if (t && w.__seen.at(-1) != t) { w.__seen.push(t); w.__locked.push(btn.getAttribute("aria-disabled") == "true"); } };
      note();
      new MutationObserver(note).observe(el, { childList: true, subtree: true, characterData: true });
    }),
    seen: () => p.evaluate(() => (window as any).__seen as string[] ?? []),
    /** Whether Redeploy now was off limits each time the status said Deploying (and it did say it). */
    lockedWhileDeploying: () => p.evaluate(() => { const w = window as any; return w.__seen.some((t: string) => t.startsWith("Deploying")) && w.__seen.every((t: string, i: number) => !t.startsWith("Deploying") || w.__locked[i]); }),
  };
  return s;
}
export type Settings = ReturnType<typeof settings>;

/** What the document's viewer shows (its page's #draft, in the frame), opened afresh in `v`. */
export async function viewerShows(v: Page, server: Server, address: string, want: string, user?: string) {
  await v.goto(`${server.root}${address}${user ? `?user=${user}` : ""}`);
  const draft = v.frameLocator("#frame").frameLocator("#view").locator("#draft");
  await until(async () => (await draft.textContent({ timeout: 500 }).catch(() => "")) == want, 5_000, `the viewer shows "${want}"`);
  return v.frameLocator("#frame").frameLocator("#view").locator("body").innerText();
}

/** A second page in the test's browser context (the viewer beside the editor). */
export const another = (tab: Tab) => tab.page.context().newPage();
