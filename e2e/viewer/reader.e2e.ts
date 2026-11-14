// A reader opens a document: the page shows whole with its stylesheets, Erga's two bars sit in their places for the
// owner, a reader and someone signed out, on a desktop and on a phone, and links stay in the viewer. The pencil goes
// into the editor and back on the same page.
import { join } from "node:path";
import { editor, F, type Editor } from "../helpers/editor";
import { expect, journey, servers, test, until, type Page } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";
import { runTool, textOf } from "../helpers/tools";
import { diff, layout, layoutOk, type Layout } from "./band";
import { bars, docFrame, docShows, editorUp, GLASS, inDoc, openViewer, site, styled, viewing, where, type Box } from "./viewer";
import { clickOn, pointerOnPage } from "../helpers/press";

const s = await servers.main();

journey("a reader opens a document with several pages", () => {
  let page: Page, doc: Awaited<ReturnType<typeof site>>, ed: Editor;
  /** The owner's bars in the viewer, on a desktop. */
  let owner: Record<string, Box>;
  /** A tab that a click opens: its address, once it has one; the tab closes. */
  const opened = async (click: () => Promise<unknown>) => {
    const tab = page.context().waitForEvent("page");
    await click();
    const p = await tab;
    await until(() => p.url() != "about:blank", 5000, "the new tab has an address");
    const url = p.url();
    await p.close();
    return url;
  };
  const link = (name: string) => page.frameLocator("#frame").getByRole("link", { name, exact: true });
  /** The details in the head of the blog's page, as the server lists them. */
  const head = async () =>
    ((await runTool(s.root, "ls", { document: doc.id })).result.entries as { path: string; head?: object }[]).find(
      (e) => e.path == "blog/index.html"
    )?.head;
  /** The document's title in the breadcrumbs, as the editor shows it; null while the viewer's shows. */
  const editorCrumb = () =>
    page.evaluate(() => {
      const e = document.getElementById("doc-title-text");
      return e?.checkVisibility() ? (e.textContent?.trim() ?? null) : null;
    });

  test("a page in a folder shows with its folder's stylesheet and the document's; the owner has the two bars", async ({ tab }) => {
    page = tab.page;
    // (Strict, for the whole journey: a request that the server refuses fails the step.)
    tab.strict = true;
    doc = await site(s);
    await openViewer(page, `${doc.address}/blog/spring-migration`);
    await expect.poll(() => styled(page)).toEqual({ h1: "Spring migration", color: "rgb(180, 40, 30)", width: "608px" });
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
    owner = view.parts;
  });

  test("a link opens the other page in the frame: the address follows, and the viewer does not load again", async () => {
    await page.evaluate(() => {
      (window as any).__same = true;
    });
    await link("Blog").click();
    await expect.poll(async () => `${await where(page)} ${(await styled(page))?.h1}`).toBe(`${doc.path}/blog The blog`);
    expect(await page.evaluate(() => (window as any).__same)).toBe(true);
  });

  // A page in a folder asked for its files at the document's root first: a 404 at every render.
  test("the pencil opens the page shown in the editor, with its folder's stylesheet; the bars stay where they are", async () => {
    await clickOn(page, ".erga-edit-button");
    await expect.poll(async () => `${await where(page)} ${await editorUp(page)}`).toBe(`${doc.path}/blog?edit true`);
    ed = editor(page, { address: doc.address, dir: doc.dir, file: join(doc.dir, "blog/index.html") });
    await ed.loaded();
    expect(await ed.eval<string>(`ergaPage.pagePath`)).toBe("blog/index.html");
    expect(
      await ed.frame<string[]>(`(() => { const h = ${F}.querySelector("h1"); return [h.textContent, getComputedStyle(h).color]; })()`)
    ).toEqual(["The blog", "rgb(180, 40, 30)"]);
    // (Share and Document settings open out of the pencil: the bar grows to the left.)
    await expect.poll(async () => (await bars(page, "edit")).parts.left?.l).toBe(6);
    const edit = await bars(page, "edit");
    expect(edit.glass).toEqual([GLASS, GLASS]);
    for (const part of ["brand", "edit", "agent", "docs", "me"] as const) expect(edit.parts[part], part).toEqual(owner[part]);
    expect(edit.parts.right.r).toBe(owner.right.r);
    expect([edit.parts.left.t, edit.parts.left.b, edit.parts.right.t, edit.parts.right.b]).toEqual([8, 50, 8, 50]);
  });

  test("in the editor, a click on a link in the text puts the caret there; a ⌘-click opens the page's address in a new tab, and so does a link out of the document", async () => {
    await ed.settle();
    await link("about us").click();
    await expect.poll(() => ed.caretIn("a")).toBe(true);
    expect(page.context().pages()).toHaveLength(1);
    expect(await opened(() => link("about us").click({ modifiers: ["ControlOrMeta"] }))).toBe(`${doc.address}/about`);
    // Out of the document (/docs, and with the server's name): Erga's page, never in the frame.
    for (const name of ["Docs", "Full docs"]) expect(await opened(() => link(name).click()), name).toBe(`${s.root}/docs`);
    expect(`${await where(page)} ${await ed.textOf("h1")}`).toBe(`${doc.path}/blog?edit The blog`);
  });

  test("the pencil leaves the editor, and Back and Forward go in and out of it: the address follows, and the viewer does not load again", async () => {
    await page.locator("#btn-edit").click();
    await expect.poll(() => where(page)).toBe(`${doc.path}/blog`);
    await expect.poll(() => page.getAttribute(".erga-edit-button", "aria-pressed")).toBe("false");
    await page.evaluate(() => history.back());
    await expect.poll(async () => `${await where(page)} ${await editorUp(page)}`).toBe(`${doc.path}/blog?edit true`);
    await page.evaluate(() => history.forward());
    await expect.poll(async () => `${await where(page)} ${await viewing(page)}`).toBe(`${doc.path}/blog true`);
    expect(await page.evaluate(() => (window as any).__same)).toBe(true);
    expect((await styled(page))?.h1).toBe("The blog");
  });

  test("⌘P prints the page in the frame, from the bars and from the page; in print, the bars hide", async () => {
    const frame = docFrame(page)!;
    // The page's own print, counted (the test's browser shows no print dialog).
    await frame.evaluate(`window.print = () => { window.__printed = (window.__printed || 0) + 1; }`);
    const printed = () => frame.evaluate<number>(`window.__printed || 0`);
    await page.locator(".erga-crumbs").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("ControlOrMeta+p");
    await expect.poll(printed).toBe(1);
    await pointerOnPage(page, 600, 600);
    await page.mouse.click(600, 600);
    await page.keyboard.press("ControlOrMeta+p");
    await expect.poll(printed).toBe(2);
    // The browser's own Print: no bars, and the page from the sheet's top.
    const look = () =>
      page.evaluate(() => ({
        bars: [...document.querySelectorAll(".erga-crumbs, .erga-view-buttons")].some((e) => e.getClientRects().length > 0),
        top: document.getElementById("frame")!.getBoundingClientRect().top,
      }));
    expect((await look()).bars).toBe(true);
    await page.emulateMedia({ media: "print" });
    expect(await look()).toEqual({ bars: false, top: 0 });
    await page.emulateMedia({ media: null });
    // In the page, the editor's own parts (carets, controls, comments) never print.
    expect(
      await frame.evaluate<boolean>(`[...document.querySelectorAll("style[data-erga]")].some((s) => /@media print/.test(s.textContent))`)
    ).toBe(true);
  });

  test("Share with an agent copies the one-line prompt, or a prompt with a token for the time and scope picked; the token works", async () => {
    const origin = s.root;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const copied = () => page.evaluate(() => navigator.clipboard.readText());
    await clickOn(page, ".erga-agent-share");
    await clickOn(page, ".erga-agent-menu:not([hidden]) .am-mcp");
    await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>(".erga-agent-share")!.dataset.tip)).toBe("Copied ✓");
    expect(await copied()).toBe(`Add Erga's MCP server, ${origin}/mcp, then open ${doc.address}.`);
    await clickOn(page, ".erga-agent-share");
    // The dev server's person is an admin: Admin comes as a choice.
    await expect
      .poll(() => page.locator(".erga-agent-menu:not([hidden]) select[name=scope] option").allTextContents())
      .toEqual(["My documents", "Admin"]);
    await page.selectOption(".erga-agent-menu:not([hidden]) select[name=hours]", "24");
    await clickOn(page, ".erga-agent-menu:not([hidden]) .am-copy");
    // (The button says so once the prompt is copied; the card closes a moment later.)
    await expect.poll(() => page.locator(".erga-agent-menu:not([hidden]) .am-copy").textContent()).toBe("Copied ✓");
    const prompt = await copied();
    expect(prompt).toContain(`claude mcp add --transport http erga ${origin}/mcp --header "Authorization: Bearer erga_`);
    expect(prompt).toContain(`Then open ${doc.address}.`);
    const token = prompt.match(/Token: (erga_\S+)/)![1];
    const mine = (await runTool(origin, "whoami", {}, { token })).result.token as { label: string; scope: string; expires: string };
    expect([mine.label, mine.scope]).toEqual(["Share with an agent", "documents"]);
    const left = Date.parse(mine.expires) - Date.now();
    expect(left > 23.9 * 3600_000 && left <= 24 * 3600_000).toBe(true);
  });

  test("a link written as the page's Erga address opens that page in the frame; a ⌘-click or a middle click opens a page's address in a new tab", async () => {
    await link("About").click();
    await expect.poll(async () => `${await where(page)} ${(await styled(page))?.h1}`).toBe(`${doc.path}/about About us`);
    expect(await page.evaluate(() => (window as any).__same)).toBe(true);
    expect(page.context().pages()).toHaveLength(1);
    expect(await opened(() => link("A post").click({ modifiers: ["ControlOrMeta"] }))).toBe(`${doc.address}/blog/spring-migration`);
    expect(await opened(() => link("Blog").click({ button: "middle" }))).toBe(`${doc.address}/blog`);
    expect(`${await where(page)} ${(await styled(page))?.h1}`).toBe(`${doc.path}/about About us`);
  });

  test("from the reader, the pencil to the first edit: typing edits the page's own file", async () => {
    await page.evaluate(() => history.back());
    await expect.poll(async () => `${await where(page)} ${(await styled(page))?.h1}`).toBe(`${doc.path}/blog The blog`);
    await clickOn(page, ".erga-edit-button");
    await ed.loaded();
    await ed.settle();
    await ed.clickEnd("p");
    await ed.press("End");
    await ed.type(" Edited here.");
    await expect.poll(() => ed.textOf("p")).toBe("Every post, newest first. Edited here.");
    await expect.poll(() => ed.disk()).toContain("newest first. Edited here.</p>");
  });

  test("the owner sets the page's title, description and icon in Page details: the tab, the settings and a reader's first answer show them", async () => {
    const TITLE = "Pete's <Page>",
      ABOUT = "Everything about the page.",
      ICON = "../assets/owl.svg";
    await clickOn(page, "#btn-settings");
    await page.locator("#ds-page-edit").click();
    const dialog = page.locator("#erga-page-head");
    await dialog.waitFor();
    // The title box has the focus, with the page's title: the owner types over it, then Tab to the description.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText(TITLE);
    await page.keyboard.press("Tab");
    await page.keyboard.insertText(ABOUT);
    // (The icon is a file of the document, from the page's own folder.)
    await page.locator("#ph-icon").fill(ICON);
    expect(await dialog.locator(".ph-tab-title").textContent()).toBe(TITLE);
    expect(await dialog.locator(".ph-desc").textContent()).toBe(ABOUT);
    await dialog.locator(".ph-save").click();
    await dialog.waitFor({ state: "detached" });
    // The page's source has the tags, and the tab follows the page's head at once.
    await expect.poll(head).toEqual({ title: TITLE, description: ABOUT, icon: ICON });
    await expect.poll(() => page.title()).toBe(TITLE);
    await expect
      .poll(() => page.evaluate(() => document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? ""))
      .toMatch(/\/assets\/owl\.svg$/);
    // Page details in the settings show them, with Edit.
    await clickOn(page, "#btn-settings");
    await expect.poll(() => page.locator("#ds-page-tab").textContent()).toBe(TITLE);
    expect(await page.locator("#ds-page-desc").textContent()).toBe(ABOUT);
    await expect.poll(() => page.evaluate(() => document.querySelector<HTMLImageElement>("#ds-page-tab img")?.naturalWidth ?? 0)).toBe(120);
    expect(await page.locator("#ds-page-edit").textContent()).toBe("Edit");
    // A reader's (or a link preview's) first answer has them in the viewer's own head.
    const html = await (await fetch(`${doc.address}/blog`)).text();
    expect(html).toContain("<title>Pete&#39;s &lt;Page&gt;</title>");
    expect(html).toContain(`<meta name="description" content="${ABOUT}">`);
    expect(html).toMatch(/<link rel="icon" href="[^"]+\/assets\/owl\.svg">/);
  });

  test("the owner hides Erga's bars from readers in Document settings", async () => {
    expect(await page.locator("#ds-bars-on").isChecked()).toBe(true);
    await page.locator("#ds-bars-on").click();
    await expect.poll(async () => (await runTool(s.root, "ls", { document: doc.id })).result?.access?.readerBars).toBe(false);
    await page.keyboard.press("Escape");
    // The page's details empty again: the tab shows the document's title.
    expect(
      (await runTool(s.root, "set_head", { document: doc.id, path: "blog/index.html", title: "", description: "", icon: "" })).result.head
    ).toEqual({});
    await expect.poll(() => page.title()).not.toBe("Pete's <Page>");
  });

  // (After the steps that change the page's head: while an agent works, and for 8 s after its last call, the editor
  // does not make the page afresh, so a new icon would reach the tab only then.)
  test("an agent's eval_in_page reads the page that the editor shows, changes nothing, and has a time limit", async () => {
    const { token } = await newToken(s.root, { label: "Reader journey" });
    const evalInPage = async (args: object) => {
      const r = await runTool(s.root, "eval_in_page", { document: doc.id, ...args }, { token });
      return { ok: r.ok, text: r.ok ? textOf(r.result) : (r.error ?? "") };
    };
    // The agent's expression runs in that page (path names it); one that never ends stops at its time limit.
    const [read, stuck] = await Promise.all([
      evalInPage({
        path: "blog/index.html",
        expression: `({ color: getComputedStyle(document.querySelector("h1")).color, h1: document.querySelector("h1").getBoundingClientRect().height > 0 })`,
      }),
      evalInPage({ expression: "new Promise(() => {})", timeout: 200 }),
    ]);
    expect([read.ok, read.text.startsWith('{"color":"rgb(180, 40, 30)","h1":true}')], read.text).toEqual([true, true]);
    expect(stuck.ok).toBe(false);
    expect(stuck.text).toMatch(/didn't finish within 200 ms/);
    // It changes nothing: not the document, and not the page that the person has open.
    const before = await ed.source();
    const meddled = await evalInPage({ path: "blog/index.html", expression: `document.querySelector("h1").textContent = "Meddled"` });
    expect([meddled.ok, meddled.text.startsWith('"Meddled"')], meddled.text).toEqual([true, true]);
    await ed.settle();
    expect(await ed.source()).toBe(before);
    await expect.poll(() => ed.disk()).toBe(before);
    expect(await ed.textOf("h1")).toBe("The blog");
  });

  test("on a phone, the buttons' bar is the avatar alone; a tap opens the quick actions and the menu; a tap on the page closes them; the editor's bar is the same", async () => {
    const shown = async (mode: "view" | "edit") => Object.keys((await bars(page, mode)).parts).filter((p) => p != "brand");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${doc.address}/blog`);
    await expect.poll(async () => (await styled(page))?.h1).toBe("The blog");
    // (The breadcrumbs keep their end in sight: how far erga shows depends on the title.)
    await expect.poll(() => shown("view")).toEqual(["left", "right", "me"]);
    const atRest = (await bars(page, "view")).parts;
    const me = atRest.me;
    await page.mouse.click((me.l + me.r) / 2, (me.t + me.b) / 2);
    await expect.poll(() => shown("view")).toEqual(["left", "right", "new", "full", "edit", "agent", "docs", "me"]);
    expect(await page.evaluate(() => !document.querySelector<HTMLElement>(".erga-account-menu")!.hidden)).toBe(true);
    // (The breadcrumbs' bar gets narrower as the buttons' bar opens: it ends before it once both are at rest.)
    await expect
      .poll(
        async () => {
          const open = (await bars(page, "view")).parts;
          return open.left.r <= open.right.l - 7.5;
        },
        { message: "the breadcrumbs' bar ends before the buttons' bar" }
      )
      .toBe(true);
    expect((await bars(page, "view")).parts.me, "the avatar stays where it is").toEqual(me);
    // A tap on the page (in its frame) closes them.
    await pointerOnPage(page, 195, 500);
    await page.mouse.click(195, 500);
    await expect.poll(() => shown("view")).toEqual(["left", "right", "me"]);
    // ?edit opens the editor as the page loads. Its bars at rest: the same.
    await page.goto(`${doc.address}/blog?edit`);
    await expect.poll(async () => `${await where(page)} ${await editorUp(page)}`).toBe(`${doc.path}/blog?edit true`);
    await expect.poll(() => shown("edit")).toEqual(["left", "right", "me"]);
    const edit = (await bars(page, "edit")).parts;
    for (const part of ["right", "me"] as const) expect(edit[part], part).toEqual(atRest[part]);
    expect([edit.left.l, edit.left.t, edit.left.b]).toEqual([atRest.left.l, atRest.left.t, atRest.left.b]);
  });

  test("readers have no bars while the owner hides them, and editors keep them; with the bars, a reader and someone signed out have the buttons that apply to them in the owner's places", async () => {
    await page.setViewportSize({ width: 1200, height: 760 });
    const share = (args: object) => runTool(s.root, "share_document", { document: doc.id, ...args });
    expect((await share({ login: "*", role: "viewer" })).ok).toBe(true);
    expect((await share({ login: "ed", role: "editor" })).ok).toBe(true);
    /** What `who` sees: whether the buttons' bar shows, and where the page's frame starts. */
    const view = async (who: string) => {
      await page.goto(`${doc.address}?user=${who}`);
      await expect.poll(async () => (await styled(page))?.h1).toBe("Field guide");
      return page.evaluate(() => ({
        bars: !!document.querySelector(".erga-view-buttons")?.getClientRects().length,
        top: document.getElementById("frame")!.getBoundingClientRect().top,
      }));
    };
    // The owner hid the bars: a reader's page fills the window, from its top. An editor has the bars.
    expect(await view("reader"), "a reader, the bars hidden").toEqual({ bars: false, top: 0 });
    expect((await view("ed")).bars, "an editor").toBe(true);
    // On again. A reader: no pencil; Share with an agent, Documents and the avatar where the owner has them.
    expect((await share({ reader_bars: true })).ok).toBe(true);
    expect((await view("reader")).bars, "a reader, the bars on again").toBe(true);
    const reader = await bars(page, "view");
    expect(reader.glass).toEqual([GLASS, GLASS]);
    expect(Object.keys(reader.parts)).toEqual(["left", "right", "brand", "new", "full", "agent", "docs", "me"]);
    for (const part of ["brand", "agent", "docs", "me"] as const) expect(reader.parts[part], part).toEqual(owner[part]);
    // Signed out: the breadcrumbs are Erga › the document; the sign-in circle where the avatar is.
    const cookie = `erga_signed_out_${new URL(s.root).port}`;
    await page.context().addCookies([{ name: cookie, value: "1", url: s.root }]);
    try {
      await page.goto(doc.address);
      await expect.poll(async () => (await styled(page))?.h1).toBe("Field guide");
      const out = await bars(page, "view");
      expect(out.glass).toEqual([GLASS, GLASS]);
      expect(Object.keys(out.parts)).toEqual(["left", "right", "brand", "new", "full", "agent", "me"]);
      expect(out.parts.me).toEqual(owner.me);
      expect(out.parts.brand).toEqual(owner.brand);
      expect(
        await page.evaluate(() => [...document.querySelectorAll(".erga-crumbs > :not(.erga-sep)")].map((e) => e.textContent!.trim()))
      ).toEqual(["Erga", "Field guide"]);
    } finally {
      await page.context().clearCookies({ name: cookie });
    }
  });

  // A folder on disk had its <title>, "A deck", or "Untitled" in the viewer's breadcrumbs.
  test("a deck's breadcrumb says its first heading, Launch plan, in the viewer and in the editor", async () => {
    await page.goto((await s.fixture("slides")).address);
    await expect
      .poll(() => page.evaluate(() => document.querySelector(".erga-crumbs .erga-here > span")?.textContent?.trim() ?? null))
      .toBe("Launch plan");
    await clickOn(page, ".erga-edit-button");
    await expect.poll(editorCrumb).toBe("Launch plan");
  });

  test("every app page has Share with an agent in its bar: on Documents it copies the prompt for Documents", async () => {
    await page.goto(`${s.root}/docs`);
    await clickOn(page, ".erga-agent-share");
    await clickOn(page, ".erga-agent-menu:not([hidden]) .am-mcp");
    await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>(".erga-agent-share")!.dataset.tip)).toBe("Copied ✓");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `Add Erga's MCP server, ${s.root}/mcp, then open ${s.root}/docs.`
    );
    // On an admin page, Admin is picked for the token.
    await page.goto(`${s.root}/admin`);
    await clickOn(page, "#btn-share");
    expect(await page.inputValue(".erga-agent-menu:not([hidden]) select[name=scope]")).toBe("admin");
  });

  test("a page two folders down shows whole at its own address on the document's origin: its stylesheet, image and font come from the folders above", async () => {
    const viewer = await (await fetch(doc.address)).text();
    const files = /<meta name="erga-pages" content="([^"]+)">/.exec(viewer)![1].replaceAll("&amp;", "&");
    await page.goto(`${files}blog/drafts/owls.html`);
    const look = () =>
      page.evaluate(async () => {
        if (document.readyState != "complete") return null;
        await document.fonts.ready;
        const img = document.getElementById("owl") as HTMLImageElement;
        return {
          width: getComputedStyle(document.body).maxWidth,
          image: img.complete ? img.naturalWidth : 0,
          font: [...document.fonts].some((f) => f.family.replace(/["']/g, "") == "Field" && f.status == "loaded"),
        };
      });
    await expect.poll(look).toEqual({ width: "608px", image: 120, font: true });
  });
});

// The pages of e2e/fixtures/top: their first line sits at the page's very top edge, where the controls once covered it.
journey("the band over a page whose text starts at its top edge", () => {
  let page: Page;
  /** Opens the page at 1200px: no control covers its text, the controls sit above its first line, the band has its colour. */
  async function band(name: "gradient" | "light", tone: "light" | "dark") {
    await openViewer(page, (await s.fixture(`top/${name}`)).address);
    await docShows(page, "A ");
    // Settled: the controls have come in and the band has its colour.
    let last: Layout | null = null;
    await until(async () => layoutOk((last = await layout(page)), tone), 5000, "the band and the controls settle").catch(() => {});
    const l = last!;
    expect(l.controls, "found the controls").toBeGreaterThanOrEqual(2);
    expect(l.text, "found the document's first line").toBeGreaterThanOrEqual(3);
    expect(l.overlaps, "controls that cover the document's text").toEqual([]);
    expect(l.lowest, "the controls sit above the document's first line").toBeLessThanOrEqual(l.top);
    expect(diff(l.band, l.edge), `the band (${l.band}) is the document's colour at its top edge (${l.edge})`).toBeLessThanOrEqual(12);
    expect(diff(l.band2, l.edge), `the band beside the document (${l.band2}) too`).toBeLessThanOrEqual(12);
    expect(l.tone).toBe(tone);
  }

  test("a gradient page, viewing: no control covers the text; the band is the page's colour; the controls are light", async ({ tab }) => {
    page = tab.page;
    tab.strict = true;
    await band("gradient", "dark");
  });

  test("a light page, viewing: no control covers the text; the band is the page's colour; the controls are dark", async () => {
    await band("light", "light");
  });

  test("a page at rest checks nothing; a change of its colour, its styles or its hash reaches the viewer", async () => {
    // What the viewer hears from the page.
    await page.evaluate(() => {
      const w = window as any;
      w.__said = [];
      addEventListener("message", (e) => {
        if (e.data?.type == "erga-band") w.__said.push(e.data.color);
        if (e.data?.type == "erga-hash") w.__said.push(e.data.hash);
      });
    });
    const said = () => page.evaluate(() => (window as any).__said as string[]);
    // The styles that the page's script computes, counted.
    await inDoc(
      page,
      `(() => { window.__styles = 0; const real = window.getComputedStyle; window.getComputedStyle = function (...a) { window.__styles++; return real.apply(this, a); }; return 1; })()`
    );
    /** At rest: the count is the same over 10 of the page's frames (each check of the old loop computed a style, on every frame). */
    const atRest = () =>
      expect
        .poll(() =>
          inDoc<boolean>(
            page,
            `new Promise((done) => { const was = window.__styles; let n = 0; (function frame() { if (++n < 10) requestAnimationFrame(frame); else done(window.__styles == was); })(); })`
          )
        )
        .toBe(true);
    await atRest();
    await inDoc(page, `(document.documentElement.style.background = "rgb(1, 2, 3)", 1)`);
    await expect.poll(said).toContain("rgb(1, 2, 3)");
    // A stylesheet that comes later, anywhere in the page.
    await inDoc(page, `(document.body.insertAdjacentHTML("beforeend", "<style>html { background: rgb(4, 5, 6) !important }</style>"), 1)`);
    await expect.poll(said).toContain("rgb(4, 5, 6)");
    // A colour that changes over time is followed to its end.
    await inDoc(
      page,
      `(document.body.insertAdjacentHTML("beforeend", "<style>html { transition: background-color 0.3s; background: rgb(7, 8, 9) !important }</style>"), 1)`
    );
    await expect.poll(said).toContain("rgb(7, 8, 9)");
    // The page's place, set with no event of its own.
    await inDoc(page, `(history.replaceState(null, "", "#part-2"), 1)`);
    await expect.poll(said).toContain("#part-2");
    await atRest();
  });
});
