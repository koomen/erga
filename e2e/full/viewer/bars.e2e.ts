// The viewer's header (navigation invariants): the same two glass bars as the editor's, in the same places, with the same
// buttons where they apply. The owner, a reader and someone signed out; on a desktop and on a phone. Going into the
// editor moves nothing that is in both. On a phone the buttons open out of the avatar, and a tap on the page closes them.
import { expect, servers, settle, test, until, type Page } from "../../helpers/fixtures";
import { clickOn } from "../access/access";
import { controls, homeReady, openLong, wheel, type Mode } from "./scroll";
import { docShows, openViewer } from "./viewer";

// The homepage served directly, before any test (servers.main() gives nothing where the runner only lists the tests).
const main = await servers.main();
if (main) await homeReady(main);

type Box = { l: number; t: number; r: number; b: number };
/** What shows in the bars: each part's box, by its name in both pages. */
const PARTS = {
  view: {
    left: ".erga-crumbs",
    right: ".erga-view-buttons",
    brand: ".erga-brand",
    new: ".erga-new-btn",
    full: ".erga-full-button",
    edit: ".erga-edit-button",
    agent: ".erga-agent-share",
    docs: ".erga-docs-button",
    me: ".erga-account-btn",
  },
  edit: {
    left: "#nav-docs",
    right: ".chrome-top",
    brand: "#nav-brand",
    new: "#btn-new",
    full: "#btn-full",
    edit: "#btn-edit",
    agent: "#btn-agent-share",
    docs: "#btn-docs",
    me: ".me-slot .avatar",
  },
};

/** The parts that show (on top where they are), their boxes, and each bar's glass. */
const bars = (page: Page, mode: "view" | "edit") =>
  page.evaluate((parts) => {
    const out: Record<string, { l: number; t: number; r: number; b: number }> = {};
    for (const [name, sel] of Object.entries(parts)) {
      const el = document.querySelector(sel);
      const r = el?.getBoundingClientRect();
      if (!el || !r?.width) continue;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top || !el.contains(top)) continue;
      out[name] = {
        l: Math.round(r.left * 2) / 2,
        t: Math.round(r.top * 2) / 2,
        r: Math.round(r.right * 2) / 2,
        b: Math.round(r.bottom * 2) / 2,
      };
    }
    const glass = (sel: string) => {
      const s = getComputedStyle(document.querySelector(sel)!);
      return { radius: s.borderTopLeftRadius, blur: s.backdropFilter.includes("blur"), shadow: s.boxShadow != "none" };
    };
    return { parts: out, glass: [glass(parts.left), glass(parts.right)] };
  }, PARTS[mode]);

const GLASS = { radius: "14px", blur: true, shadow: true };

/** A document of the tester's, shared with anyone with the link to view: its address. */
async function sharedDoc(page: Page): Promise<string> {
  const server = await servers.main();
  const address = (await server.fixture("top/light")).address;
  const id = ((await (await fetch(`${address}/api/doc`)).json()) as { docName: { id: string } }).docName.id;
  await openViewer(page, address, { width: 1200, height: 760 });
  const r = await page.evaluate(
    (id) =>
      fetch("/api/tools/share_document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: id, login: "*", role: "viewer" }),
      }).then((r) => r.status),
    id
  );
  expect(r).toBe(200);
  return address;
}

test("desktop: the owner's viewer has the editor's bars and buttons in the editor's places; going into the editor moves none of them", async ({
  tab,
}) => {
  const page = tab.page;
  const address = (await (await servers.main()).fixture("top/light")).address;
  await openViewer(page, address, { width: 1200, height: 760 });
  await docShows(page, "A ");
  const view = await bars(page, "view");
  expect(view.glass).toEqual([GLASS, GLASS]);
  expect(Object.keys(view.parts)).toEqual(["left", "right", "brand", "new", "full", "edit", "agent", "docs", "me"]);
  // The editor's places: 6px and 8px from the sides, 8px from the top, 42px high.
  expect(view.parts.left).toMatchObject({ l: 6, t: 8, b: 50 });
  expect(view.parts.right).toMatchObject({ r: 1192, t: 8, b: 50 });
  // Clone is the New menu's last item, not a button.
  expect(
    await page.evaluate(() => [
      !!document.querySelector(".erga-clone-button"),
      document.querySelector(".erga-new-menu a:last-child b")?.textContent,
    ])
  ).toEqual([false, "Clone"]);
  await clickOn(page, ".erga-edit-button");
  await until(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready")), 10_000, "the editor is ready");
  // (Pause, Share and Document settings open out of the pencil: the bar grows to the left.)
  await expect.poll(async () => (await bars(page, "edit")).parts.left?.l).toBe(6);
  const edit = await bars(page, "edit");
  expect(edit.glass).toEqual([GLASS, GLASS]);
  for (const part of ["brand", "edit", "agent", "docs", "me"] as const) expect(edit.parts[part], part).toEqual(view.parts[part]);
  expect(edit.parts.right.r).toBe(view.parts.right.r);
  expect([edit.parts.left.t, edit.parts.left.b, edit.parts.right.t, edit.parts.right.b]).toEqual([8, 50, 8, 50]);
});

test("desktop: a reader and someone signed out have the bars too, with the buttons that apply to them in the same places", async ({
  tab,
}) => {
  const page = tab.page;
  const address = await sharedDoc(page);
  const owner = (await bars(page, "view")).parts;
  // A reader: no pencil; Share with an agent, Documents and the avatar where the owner has them.
  await page.goto(`${address}?user=reader`);
  await docShows(page, "A ");
  const reader = await bars(page, "view");
  expect(reader.glass).toEqual([GLASS, GLASS]);
  expect(Object.keys(reader.parts)).toEqual(["left", "right", "brand", "new", "full", "agent", "docs", "me"]);
  for (const part of ["brand", "agent", "docs", "me"] as const) expect(reader.parts[part], part).toEqual(owner[part]);
  // Signed out: the breadcrumbs are erga › the document; Share with an agent; the sign-in circle where the avatar is.
  const port = new URL((await servers.main()).root).port;
  await page.context().addCookies([{ name: `erga_signed_out_${port}`, value: "1", url: (await servers.main()).root }]);
  try {
    await page.goto(address);
    await docShows(page, "A ");
    const out = await bars(page, "view");
    expect(out.glass).toEqual([GLASS, GLASS]);
    expect(Object.keys(out.parts)).toEqual(["left", "right", "brand", "new", "full", "agent", "me"]);
    expect(out.parts.me).toEqual(owner.me);
    expect(out.parts.brand).toEqual(owner.brand);
    expect(await page.evaluate(() => [...document.querySelectorAll(".erga-crumbs > *")].map((e) => e.textContent!.trim()))).toEqual([
      "Erga",
      "A light page with content at the top",
    ]);
  } finally {
    await page.context().clearCookies({ name: `erga_signed_out_${port}` });
  }
});

test("Share with an agent in the viewer copies the one-line prompt, as the editor's", async ({ tab }) => {
  const page = tab.page;
  const address = (await (await servers.main()).fixture("top/light")).address;
  await openViewer(page, address, { width: 1200, height: 760 });
  await docShows(page, "A ");
  const origin = new URL(address).origin;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await clickOn(page, ".erga-agent-share");
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>(".erga-agent-share")!.dataset.tip)).toBe("Copied ✓");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Add Erga's MCP server, ${origin}/mcp, then open ${address}.`);
});

test("phone: at rest the buttons' bar is the avatar alone; a tap opens the quick actions and the menu; a tap on the page closes them; the editor's bar is the same", async ({
  tab,
}) => {
  const page = tab.page;
  const address = (await (await servers.main()).fixture("top/light")).address;
  await openViewer(page, address, { width: 390, height: 844 });
  await docShows(page, "A ");
  // (The breadcrumbs keep their end in sight: how far erga shows depends on the title.)
  const shown = async (mode: "view" | "edit" = "view") => Object.keys((await bars(page, mode)).parts).filter((p) => p != "brand");
  await expect.poll(() => shown()).toEqual(["left", "right", "me"]);
  const atRest = (await bars(page, "view")).parts;
  const me = atRest.me;
  await page.mouse.click((me.l + me.r) / 2, (me.t + me.b) / 2);
  await expect.poll(() => shown()).toEqual(["left", "right", "new", "full", "edit", "agent", "docs", "me"]);
  const open = (await bars(page, "view")).parts;
  expect(await page.evaluate(() => !document.querySelector<HTMLElement>(".erga-account-menu")!.hidden)).toBe(true);
  expect(open.left.r, "the breadcrumbs' bar ends before the buttons' bar").toBeLessThanOrEqual(open.right.l - 7.5);
  expect(open.me, "the avatar stays where it is").toEqual(me);
  // A tap on the page (in its frame) closes them.
  await page.mouse.click(195, 500);
  await expect.poll(() => shown()).toEqual(["left", "right", "me"]);
  // The editor's bars at rest: the same.
  await page.goto(`${address}?edit`);
  await until(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready")), 10_000, "the editor is ready");
  await expect.poll(() => shown("edit")).toEqual(["left", "right", "me"]);
  const edit = (await bars(page, "edit")).parts;
  for (const part of ["right", "me"] as const) expect(edit[part], part).toEqual(atRest[part]);
  expect([edit.left.l, edit.left.t, edit.left.b]).toEqual([atRest.left.l, atRest.left.t, atRest.left.b]);
});

for (const mode of ["doc", "home"] as Mode[])
  test(`${mode == "home" ? "the homepage" : "a document's page"}, scrolled: its bars stay whole over the page (they fade only while you type, in the editor)`, async ({
    tab,
  }) => {
    tab.strict = true;
    const page = tab.page;
    await openLong(page, await servers.main(), mode, { width: 1300, height: 860 });
    await wheel(page, mode, 650, 430, 900);
    await settle(page);
    const c = await controls(page, mode);
    expect(c.opacity.length).toBeGreaterThanOrEqual(2);
    expect(
      c.opacity.every((o) => o == 1),
      "the bars whole"
    ).toBe(true);
  });
