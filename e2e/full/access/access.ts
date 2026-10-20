// Helpers for the tests of who may do what: the account corner,
// the admin pages' layout and guard, scoped tokens
// and a document's page kept apart from its viewer
//. Requests go to a worker's server as DEV_LOGIN
// ("tester", local development's admin) unless they say otherwise (?user=,
// a cookie, a token); each test makes its own people, documents and tokens.

import { expect, settle, until, type Page } from "../../fixtures";

/** A request to the server, its redirects not followed. */
export const getter = (root: string) => (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });

/** A name no other test (nor a repeat of this one) uses: for logins, slugs and labels. */
export const unique = (name: string) => `${name}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

/** A new document from /new: its editor address (with ?edit) and id. */
export async function newDoc(root: string): Promise<{ at: string; id: string }> {
  const get = getter(root);
  const at = (await get("/new")).headers.get("location")!;
  expect(at).toMatch(/[?&]edit=?$/);
  const id = ((await (await get(`${at.replace(/[?&]edit=?$/, "")}/api/name`)).json()) as { id: string }).id;
  return { at, id };
}

/** The account corner (data-erga-account) as the page shows it. */
export const corner = (page: Page) => page.evaluate(() => {
  const root = document.querySelector<HTMLElement>("[data-erga-account]"), btn = root?.querySelector("button"), menu = root?.querySelector<HTMLElement>(".erga-account-menu");
  const r = btn?.getBoundingClientRect();
  return {
    state: root?.dataset.ergaAccount ?? null, label: btn?.getAttribute("aria-label") ?? null, img: btn?.querySelector("img")?.getAttribute("src") ?? null,
    initial: btn?.querySelector("span")?.textContent ?? "", open: !!menu && !menu.hidden, who: menu?.querySelector(".erga-account-who")?.textContent ?? "",
    links: [...(menu?.querySelectorAll("a") ?? [])].map((a) => ({ text: a.textContent!.trim(), href: a.getAttribute("href") })),
    rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
  };
});

/**
 * Clicks the middle of an element of the tab's own document, once nothing else is on top of it there: coming into
 * the editor, the viewer's own buttons stay over the editor's for their 200 ms fade, and take the click.
 */
export async function clickOn(page: Page, selector: string) {
  const r = await until(() => page.evaluate((s) => {
    const el = document.querySelector(s), r = el?.getBoundingClientRect();
    if (!el || !r?.width) return null;
    const x = r.x + r.width / 2, y = r.y + r.height / 2, top = document.elementFromPoint(x, y);
    return top && (el == top || el.contains(top)) ? { x, y } : null;
  }, selector), 5000, `${selector} on the page, uncovered`);
  await page.mouse.click(r!.x, r!.y);
  // A click that navigates leaves nothing to settle.
  await settle(page).catch(() => {});
}

/** Evaluates in every frame but the tab's own (a document's page on its own origin, the page editor's frame). */
export const inFrames = <T>(page: Page, expr: string): Promise<(T | null)[]> =>
  Promise.all(page.frames().filter((f) => f != page.mainFrame()).map((f) => f.evaluate(expr).then((v) => v as T, () => null)));

/** Evaluates in the document's page: the viewer's frame, on the document's own origin (the editor runs in it too). */
export const inPage = <T>(page: Page, expr: string) =>
  inFrames<T>(page, `(() => parent == top ? window.eval(${JSON.stringify(expr)}) : null)()`);

/** Signs in as someone by the dev sign-in (no `as`: DEV_LOGIN, an admin): their session cookie. */
export async function signIn(root: string, as: string | null): Promise<string> {
  const r = await getter(root)(`/auth/github?${as ? `as=${as}&` : ""}next=/docs`);
  return r.headers.getSetCookie().map((x) => x.split(";")[0]).find((x) => /^erga_session(_\d+)?=/.test(x))!;
}

/** Makes a token at /tokens (with a session cookie, else as DEV_LOGIN): the token, or "" and the page's error. */
export async function mint(root: string, cookie: string | null, fields: Record<string, string>): Promise<{ token: string; page: string }> {
  const page = await (await getter(root)("/tokens/new", { method: "POST", headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: root }, body: new URLSearchParams(fields) })).text();
  return { token: /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1] ?? "", page };
}

/** Calls one of the outside agents' tools with a token. */
export async function tool(root: string, token: string, name: string, args: unknown = {}) {
  const r = await fetch(`${root}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const body = (await r.json()) as { content?: { text: string }[]; error?: string };
  return { status: r.status, text: body.content?.[0]?.text ?? body.error ?? "" };
}

/** Publishes a document with a documents token: its id and address. */
export async function publish(root: string, token: string, title: string) {
  const r = await fetch(`${root}/api/publish`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title, files: { "index.html": `<h1>${title}</h1>` } }) });
  return await r.json() as { id: string; address: string };
}
