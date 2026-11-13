// Helpers for the journeys of who may do what: sign-in, sharing, tokens and the admin pages.
// A request goes to a test server as DEV_LOGIN ("tester", an admin) unless it says otherwise: `?user=<login>`, a
// session cookie, or a token. Each journey makes its own people, documents and tokens.
//
// Trap: a browser that signed in as someone (`/auth/dev`, `/auth/github?as=`) keeps that person's cookie. A later
// page of the admin's names the admin (`?user=tester`).

import { expect, settle, until, type Page, type Server } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";
import type { Replica } from "../helpers/room";
import { runTool, textOf } from "../helpers/tools";

/**
 * expect.poll that reads every 20 ms (not every 100 ms): a state that comes in a few ms costs a few ms. For what
 * follows a click or a request at once: a row drawn again, a dialog, a live change.
 */
export const soon = <T>(read: () => T | Promise<T>, timeout = 5000) => expect.poll(read, { interval: 20, timeout });

/** A request to the server, its redirects not followed. */
export const getter =
  (root: string) =>
  (path: string, init: RequestInit = {}) =>
    fetch(root + path, { redirect: "manual", ...init });

/** A name no other test (nor a repeat of this one) uses: for logins, slugs and labels. */
export const unique = (name: string) => `${name}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

/** A 1×1 PNG, for the pictures of GitHub and Google that a test serves itself (a picture that fails takes itself off). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
export const servePictures = (page: Page) =>
  page.route(/^https:\/\/(avatars\.githubusercontent\.com|[a-z0-9]+\.googleusercontent\.com)\//, (r) =>
    r.fulfill({ contentType: "image/png", body: PNG })
  );

/** A document's address without the editor's mark. */
export const plain = (at: string) => at.replace(/[?&]edit=?$/, "");

/** A new document from /new, as the person of `cookie` (none: DEV_LOGIN): its editor address (a path, with ?edit), its address and its id. */
export async function newDoc(root: string, cookie?: string): Promise<{ at: string; address: string; id: string }> {
  const get = (path: string) => fetch(root + path, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
  const at = (await get("/new")).headers.get("location")!;
  expect(at).toMatch(/[?&]edit=?$/);
  const address = plain(at);
  const id = ((await (await get(`${address}/api/doc`)).json()) as { docName: { id: string } }).docName.id;
  return { at, address, id };
}

/** Shares a document as its owner `as` (none: DEV_LOGIN) with someone ("*": anyone with the link); "none" stops it. */
export const share = (root: string, id: string, who: string, role: "editor" | "commenter" | "viewer" | "none", as?: string) =>
  runTool<{ permissions: { login: string; role: string }[] }>(root, "share_document", { document: id, login: who, role }, { user: as });

/** The account corner (data-erga-account) as the page shows it. */
export const corner = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-erga-account]"),
      btn = root?.querySelector("button"),
      menu = root?.querySelector<HTMLElement>(".erga-account-menu");
    const r = btn?.getBoundingClientRect();
    return {
      state: root?.dataset.ergaAccount ?? null,
      label: btn?.getAttribute("aria-label") ?? null,
      img: btn?.querySelector("img")?.getAttribute("src") ?? null,
      initial: btn?.querySelector("span")?.textContent ?? "",
      open: !!menu && !menu.hidden,
      who: menu?.querySelector(".erga-account-who")?.textContent ?? "",
      links: [...(menu?.querySelectorAll("a") ?? [])].map((a) => ({ text: a.textContent!.trim(), href: a.getAttribute("href") })),
      rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
    };
  });

/** Evaluates in every frame but the tab's own (a document's page on its own origin, the page editor's frame). */
export const inFrames = <T>(page: Page, expr: string): Promise<(T | null)[]> =>
  Promise.all(
    page
      .frames()
      .filter((f) => f != page.mainFrame())
      .map((f) =>
        f.evaluate(expr).then(
          (v) => v as T,
          () => null
        )
      )
  );

/** Evaluates in the document's page: the viewer's frame, on the document's own origin (the editor runs in it too). */
export const inPage = <T>(page: Page, expr: string) =>
  inFrames<T>(page, `(() => parent == top ? window.eval(${JSON.stringify(expr)}) : null)()`);

/** The tab's address: its path and query. */
export const where = (page: Page) => page.evaluate(() => location.pathname + location.search).catch(() => "");

/**
 * Waits until the editor is up in the tab: its controls out and its own actions in their places (they slide in: a
 * click before they settle can miss its button), and its half in the page.
 */
export async function editorUp(page: Page) {
  await until(
    () =>
      page.evaluate(
        () => document.body.classList.contains("erga-editor-ready") && document.getElementById("edit-group")!.classList.contains("settled")
      ),
    10_000,
    "the editor is ready, its own actions out"
  );
  await until(
    async () => (await inPage<boolean>(page, "!!window.ergaFrame?.page")).includes(true),
    10_000,
    "the editor's half is in the page"
  );
}

/** Signs in as someone by the dev sign-in (no `as`: DEV_LOGIN, an admin): their session cookie. */
export async function signIn(root: string, as: string | null): Promise<string> {
  const r = await getter(root)(`/auth/github?${as ? `as=${as}&` : ""}next=/docs`);
  return r.headers
    .getSetCookie()
    .map((x) => x.split(";")[0])
    .find((x) => /^erga_session(_\d+)?=/.test(x))!;
}

/** Makes a token as the Settings dialog does (POST /tokens/new), with a session cookie (none: DEV_LOGIN): the token, or "". */
export const mint = async (root: string, cookie: string | null, fields: Record<string, string>) =>
  (await newToken(root, fields, cookie)).token;

/** Calls a tool with a token, as an outside agent does: its status, and its result as text (or the error). */
export async function tool(root: string, token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await runTool(root, name, args, { token });
  return { status: r.status, text: r.ok ? textOf(r.result) : (r.error ?? "") };
}

/** Publishes a document with a documents token: its id and address. */
export async function publish(root: string, token: string, title: string) {
  const r = await fetch(`${root}/api/publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title, files: { "index.html": `<h1>${title}</h1>` } }),
  });
  return (await r.json()) as { id: string; address: string };
}

/** The cookie of a browser that signed out (locally, a browser with no cookie is DEV_LOGIN): its name. */
export const signedOutCookie = (s: Server) => `erga_signed_out_${s.port}`;
/** What someone who is not signed in sends. */
export const signedOut = (s: Server) => ({ Cookie: `${signedOutCookie(s)}=1` });

/** Whether all that a person in a room with no browser (joinRoom, e2e/helpers/room.ts) sent has left for the room. */
export const sent = (r: Replica) => r.socket.ws?.bufferedAmount === 0;
