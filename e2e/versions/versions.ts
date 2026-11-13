// Helpers for the versions' journey (versions.e2e.ts): a document whose page says which draft it is, its versions and
// its homepage state as the tools answer them, a scripted turn of the person's agent, and the settings popover in an
// editor tab.
//
// Trap: a version of a person's edits is cut once the edits pause (SHORT.idle, a second). Three things make a version
// with no wait: a restore, the end of an agent's turn, and the last editor leaving. Make the versions that a check
// only counts with restores.
// Trap: a tool call with a token is an outside agent's turn, which ends 8 s after its last call: until then no version
// of a person's edits is cut. So nothing here uses a token on the journey's document.
import type { Page } from "playwright-core";
import { editor } from "../helpers/editor";
import { agentClosed, settle, until, type Server } from "../helpers/fixtures";
import { pressOn } from "../helpers/press";
import { runTool } from "../helpers/tools";

export interface V {
  id: string;
  n: number;
  at: string;
  authors: string[];
  description: string | null;
}
export interface State {
  current: V;
  versions: V[];
  total: number;
  canEdit: boolean;
  pending: boolean;
}
export interface HomeState {
  isHome: boolean;
  canDeploy: boolean;
  deploy: { state: string; version: number | null; at: string | null; error?: string | null };
}

/** A name that no other test (nor a repeat of this one) uses: for logins and titles. */
export const unique = (name: string) => `${name}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

/** Signs in as someone by the dev sign-in (/auth/github?as=): their session cookie. */
export async function signIn(server: Server, as: string): Promise<string> {
  const r = await fetch(`${server.root}/auth/github?as=${as}&next=/docs`, { redirect: "manual" });
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => /^erga_session(_\d+)?=/.test(c));
  if (!cookie) throw new Error(`signing in as ${as}: ${r.status}`);
  return cookie;
}

/** A page whose paragraph says which draft it is. */
export const draftPage = (title: string, n: string) =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title><style>body{font:18px/1.6 Georgia,serif;max-width:36rem;margin:12vh auto;padding:0 20px}</style></head>\n<body><h1>${title}</h1>\n<p id="draft">Draft ${n}</p>\n<p>Each version of this page says which draft it is.</p>\n</body></html>\n`;

/** A new document of DEV_LOGIN's with that page, at version 1 (draft A): its id and address (/tester/<slug>). */
export async function draftDoc(server: Server, title: string) {
  const made = await runTool<{ id: string; address: string }>(server.root, "create_document", {
    title,
    files: { "index.html": draftPage(title, "A") },
  });
  if (!made.ok) throw new Error(`create_document: ${made.error}`);
  return made.result!;
}

/** A document's versions, as the settings list them (DEV_LOGIN reads them, or `user`). */
export const versionsOf = async (server: Server, id: string, q: { before?: string; limit?: number } = {}) =>
  (await runTool(server.root, "versions", { document: id, ...q })).result as State;

/** The homepage's state, as ls answers it; not the homepage: { isHome: false }. */
export const homeOf = async (server: Server, id: string) =>
  ((await runTool(server.root, "ls", { document: id })).result?.homepage ?? { isHome: false }) as HomeState;

/** What the room holds for the document's page now, as the server serves it. */
export const served = async (server: Server, id: string) => (await fetch(`${server.root}/d/${id}/doc/index.html`)).text();

/** / as served to someone signed out (someone signed in goes to /docs): the homepage's live page. */
export const front = async (server: Server) =>
  (await fetch(`${server.root}/`, { headers: { Cookie: `erga_signed_out_${server.port}=1` } })).text();

/** Sends DEV_LOGIN's agent a scripted turn (the script model: `@script [steps]`) from the document's page. */
export const scripted = (server: Server, id: string, steps: unknown[]) =>
  fetch(`${server.root}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: server.root },
    body: JSON.stringify({ text: `@script ${JSON.stringify(steps)}`, doc: id }),
  });

/** The editor on a document, at its ?edit address, as someone who keeps the agent pane closed; once the gear shows. */
export async function openDocEditor(page: Page, server: Server, address: string, user?: string) {
  await page.setViewportSize(WIDE);
  await agentClosed(page);
  await page.addInitScript(() => {
    // The page editor checks after each change that the page shows its HTML (libs/text/ui/check.ts).
    if (window.top == window) (window as any).__ergaCheck = true;
  });
  await page.goto(`${server.root}${address}${user ? `?user=${user}&edit` : "?edit"}`);
  await until(() => rect(page, "#btn-settings"), 10_000, "the gear shows");
  return settings(page);
}

/** The tab's size on a desktop, and on a phone. */
export const WIDE = { width: 1200, height: 820 };
export const PHONE = { width: 390, height: 780 };

type Rect = { x: number; y: number; w: number; h: number; top: number; right: number; bottom: number; left: number };
export const rect = (p: Page, sel: string) =>
  p.evaluate((sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    return r && r.width
      ? { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left }
      : null;
  }, sel) as Promise<Rect | null>;

/** The settings popover in an editor tab, and the editor on its page (`ed`). */
export function settings(p: Page) {
  const ed = editor(p, { address: "", dir: "", file: "" });
  const s = {
    page: p,
    ed,
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
    clickOn: (sel: string) => pressOn(p, sel),
    isOpen: () => p.evaluate(() => !!document.getElementById("doc-settings") && !document.getElementById("doc-settings")!.hidden),
    text: (sel: string) => p.evaluate((sel) => document.querySelector(sel)?.textContent?.trim() ?? "", sel),
    attr: (sel: string, name: string) =>
      p.evaluate(([sel, name]) => document.querySelector(sel!)?.getAttribute(name!) ?? null, [sel, name]),
    /** The list's rows, newest first, each as its text. */
    rows: () => p.evaluate(() => [...document.querySelectorAll("#ds-list li")].map((li) => li.textContent!.replace(/\s+/g, " ").trim())),
    /** The version numbers the list shows, newest first. */
    listed: () => p.evaluate(() => [...document.querySelectorAll<HTMLElement>("#ds-list li[data-n]")].map((li) => Number(li.dataset.n))),
    focused: () => p.evaluate(() => document.activeElement?.id ?? ""),
    /** What the page in the editor says its draft is. */
    draft: () => ed.frame<string>(`document.getElementById("draft")?.textContent ?? ""`),
    /**
     * Opens the popover, once the gear can be clicked (the editor's controls fade in as it comes up), and its versions
     * are in (`versions` false: for someone who gets none).
     */
    async open(versions = true) {
      // On a phone the gear is among the quick actions, which open out of the avatar.
      if (await p.evaluate(() => matchMedia("(max-width: 759.98px)").matches && !document.body.classList.contains("quick-open"))) {
        // (Once the viewer's own controls have gone from over it: client/inline/viewer.css.)
        await until(
          () =>
            p.evaluate(() => {
              const a = document.querySelector(".me-slot .avatar"),
                r = a?.getBoundingClientRect();
              return !!r?.width && !!a?.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            }),
          10_000,
          "the avatar can be clicked"
        );
        await s.clickOn(".me-slot .avatar");
      }
      await until(
        () =>
          p.evaluate(() => {
            const g = document.getElementById("btn-settings"),
              r = g?.getBoundingClientRect();
            return (
              !!r?.width &&
              document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("#btn-settings") == g &&
              // (The controls are dim on purpose while a person types, client/shell/chrome.ts: the gear works.)
              (getComputedStyle(g!.closest(".chrome")!).opacity == "1" || document.body.classList.contains("chrome-hidden"))
            );
          }),
        10_000,
        "the gear can be clicked"
      );
      if (!(await s.isOpen())) await s.clickOn("#btn-settings");
      await until(() => s.isOpen(), 5_000, "the settings open");
      if (versions) await until(() => p.evaluate(() => !!document.querySelector("#ds-list li[data-n]")), 5_000, "the versions load");
    },
    async close() {
      if (await s.isOpen()) {
        await p.keyboard.press("Escape");
        await p.keyboard.press("Escape");
      }
      await until(async () => !(await s.isOpen()), 5_000, "the settings close");
    },
    /** Every status line the homepage section showed, from now on (a deploy can be quick: each one is caught as it's drawn). */
    watchStatus: () =>
      p.evaluate(() => {
        const w = window as any;
        w.__seen = [];
        w.__locked = [];
        const el = document.getElementById("ds-status")!,
          btn = document.getElementById("ds-redeploy")!;
        const note = () => {
          const t = el.textContent!.trim();
          if (t && w.__seen.at(-1) != t) {
            w.__seen.push(t);
            w.__locked.push(btn.getAttribute("aria-disabled") == "true");
          }
        };
        note();
        new MutationObserver(note).observe(el, { childList: true, subtree: true, characterData: true });
      }),
    seen: () => p.evaluate(() => ((window as any).__seen as string[]) ?? []),
    lockedWhileDeploying: () =>
      p.evaluate(() => {
        const w = window as any;
        return (
          w.__seen.some((t: string) => t.startsWith("Deploying")) &&
          w.__seen.every((t: string, i: number) => !t.startsWith("Deploying") || w.__locked[i])
        );
      }),
  };
  return s;
}
export type Settings = ReturnType<typeof settings>;
