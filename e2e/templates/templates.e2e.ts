// New documents from the templates: the picker on the documents page, in the viewer and on the homepage makes each
// one. A deck of slides steps by its buttons, the arrow keys and its list, viewing and editing; it goes full screen
// and comes back at the same step; and a presentation keeps working served as it is, with no viewer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { F, openEditor, type Editor } from "../helpers/editor";
import { ROOT } from "../helpers/env";
import { expect, journey, servers, settle, test, until, type Page } from "../helpers/fixtures";
import { pointerOnPage } from "../helpers/press";
import { idOf } from "../helpers/tools";
import {
  atStep,
  bar,
  clickAway,
  clickOn,
  clickTextEnd,
  controlAt,
  controlShown,
  editorReady,
  escape,
  fills,
  focusOn,
  full,
  fullBar,
  inPage,
  newDoc,
  openTab,
  rawKey,
  scrollToStep,
  viewerBack,
} from "./templates";

const s = await servers.main();

journey("a new document from the picker", () => {
  let page: Page;
  /** The requests of the journey's tab to Google's fonts. */
  const askedGoogle: string[] = [];
  // The picker's root: the page's own document, or the homepage's controls' shadow root when it is served directly.
  const ROOT_OF = `(document.querySelector("erga-controls")?.shadowRoot ?? document)`;
  const ROWS = ["Document", "Slides", "Canvas", "Project"];
  const picker = () =>
    page.evaluate(`(() => {
      const r = ${ROOT_OF}, menu = r.querySelector(".erga-new-menu");
      return { open: !!menu && !menu.hidden,
        expanded: r.querySelector('.erga-new-btn[aria-expanded="true"]')?.getAttribute("aria-label") ?? null,
        rows: [...(menu?.querySelectorAll("a") ?? [])].filter((a) => a.getClientRects().length).map((a) => a.querySelector("b").textContent.trim()),
        icons: [...(menu?.querySelectorAll("a") ?? [])].some((a) => a.querySelector("svg")) };
    })()`) as Promise<{ open: boolean; rows: string[]; expanded: string | null; icons: boolean }>;
  /** Clicks the middle of the first visible element that matches `selector` (in the picker's root). */
  async function clickIn(selector: string) {
    const r = await until(
      () =>
        page.evaluate(
          `(() => { const e = [...${ROOT_OF}.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getClientRects().length && getComputedStyle(e).visibility != "hidden"); const r = e?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`
        ) as Promise<{ x: number; y: number } | null>,
      5000,
      `${selector} on the page`
    );
    await page.mouse.click(r!.x, r!.y);
    // A click that leaves the page has nothing to settle.
    await settle(page).catch(() => {});
  }
  /** Every option in Inter (loaded, not a fallback), 14px, 600. */
  async function sameTypeface() {
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.fonts.load("600 14px Inter").then((f) => f.some((x) => x.family.replace(/["']/g, "") == "Inter" && x.status == "loaded"))
        )
      )
      .toBe(true);
    const t = (await page.evaluate(`(() => {
      const els = [...${ROOT_OF}.querySelectorAll(".erga-new-menu a b")];
      const font = (e) => { const c = getComputedStyle(e); return c.fontFamily + " " + c.fontSize + " " + c.fontWeight + " " + c.fontStyle; };
      return { fonts: [...new Set(els.map(font))], family: els.length ? getComputedStyle(els[0]).fontFamily : "" };
    })()`)) as { fonts: string[]; family: string };
    expect(t.fonts.length).toBe(1);
    expect(t.family).toMatch(/^"?Inter"?,/);
    expect(t.fonts[0]).toMatch(/ 14px 600 normal$/);
  }
  /** The menu is under its button, in the window. */
  const placed = (button: string) =>
    page.evaluate((button) => {
      const menu = document.querySelector(".erga-new-menu")!.getBoundingClientRect(),
        btn = document.querySelector(button)!.getBoundingClientRect();
      return menu.top > btn.bottom && menu.right <= innerWidth;
    }, button);
  /** The new document's page, as the server has it; and a template's page. */
  const fileOf = async (address: string) => (await fetch(`${s.root}/d/${await idOf(address)}/doc/index.html`)).text();
  const template = (name: string) => readFileSync(join(ROOT, "assets/templates", name, "index.html"), "utf8");
  /** The tab is in the editor of a document other than `from`: its address. */
  const inNewEditor = async (from: string) => {
    await expect.poll(() => new URL(page.url()).search).toBe("?edit");
    await expect.poll(() => new URL(page.url()).pathname).not.toBe(from);
    return s.root + new URL(page.url()).pathname;
  };

  test("the documents page's New opens the picker under it, without icons; Escape closes it; Project makes a project and opens it in the editor", async ({
    tab,
  }) => {
    page = tab.page;
    page.on("request", (r) => {
      if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) askedGoogle.push(r.url());
    });
    await openTab(tab, `${s.root}/docs`);
    await clickIn("header .erga-new-btn");
    expect(await picker()).toEqual({ open: true, rows: ROWS, expanded: "New document", icons: false });
    await sameTypeface();
    expect(await placed("header .erga-new-btn")).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await picker()).open).toBe(false);
    await clickIn("header .erga-new-btn");
    // (Not clickIn: the page leaves at once, before its settle.)
    await page.click('.erga-new-menu a[data-template="project"]');
    expect(await fileOf(await inNewEditor("/docs"))).toBe(template("project"));
  });

  test("the viewer's + opens the picker, in one typeface, with Clone last; Escape closes it; Document makes a blank document and opens it in the editor", async () => {
    const from = new URL(page.url()).pathname;
    await editorReady(page);
    // The template's typefaces come from Erga itself: the new document asks Google for nothing.
    const typefaces = () =>
      inPage<string[]>(
        page,
        `document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status == "loaded").map((f) => f.family.replace(/["']/g, "")))`
      );
    await expect.poll(typefaces).toContain("Literata");
    expect(await typefaces()).toContain("Instrument Sans");
    expect(askedGoogle).toEqual([]);
    await page.locator("#btn-edit").click();
    await viewerBack(page);
    // A page without steps has no step controls.
    expect((await bar(page)).shown).toBe(false);
    await clickIn(".erga-view-buttons .erga-new-btn");
    // No icons: names and their lines only.
    expect(await picker()).toEqual({ open: true, rows: [...ROWS, "Clone"], expanded: "New document", icons: false });
    await sameTypeface();
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await picker()).open).toBe(false);
    await clickIn(".erga-view-buttons .erga-new-btn");
    await clickIn('.erga-new-menu a[data-template="page"]');
    expect(await fileOf(await inNewEditor(from))).toBe(template("doc"));
  });

  test("signed out, the homepage's + opens the picker, with Clone last, and a template goes to sign-in and comes back to make the document", async ({
    tab,
  }) => {
    const out = (await fetch(`${s.root}/auth/logout`, { method: "POST", headers: { Origin: s.root }, redirect: "manual" })).headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    await page.goto(`${s.root}/auth/logout`);
    await openTab(tab, `${s.root}/`);
    await clickIn(".erga-view-buttons .erga-new-btn");
    expect(await picker()).toMatchObject({ open: true, rows: [...ROWS, "Clone"] });
    await sameTypeface();
    const href = (await page.evaluate(`${ROOT_OF}.querySelector('.erga-new-menu a[data-template="page"]').getAttribute("href")`)) as string;
    const r = await fetch(s.root + href, { redirect: "manual", headers: { Cookie: out } });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/auth/sign-in?next=${encodeURIComponent("/new?template=page")}`);
  });
});

journey("the Slides template: a deck of two slides", () => {
  let page: Page;
  const LABELS = ["Untitled presentation", "Second slide"];
  /** One 16:9 slide shown, as large as the frame allows, in the middle. */
  async function fits() {
    const v = await inPage<{ w: number; h: number; x: number; y: number; vw: number; vh: number; shown: number } | null>(
      page,
      `(() => {
        const all = [...document.querySelectorAll(".slide")], s = all.find((e) => !e.hidden);
        if (!s) return null;
        const r = s.getBoundingClientRect();
        return { w: r.width, h: r.height, x: r.left, y: r.top, vw: innerWidth, vh: innerHeight, shown: all.filter((e) => e.getClientRects().length).length };
      })()`
    );
    const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
    return (
      !!v &&
      v.shown == 1 &&
      near(v.w / v.h, 16 / 9) &&
      (near(v.w, v.vw) || near(v.h, v.vh)) &&
      v.w <= v.vw + 1 &&
      v.h <= v.vh + 1 &&
      near(v.x, (v.vw - v.w) / 2) &&
      near(v.y, (v.vh - v.h) / 2)
    );
  }
  /** The list open, both slides drawn small in it, with their titles. */
  async function listShown() {
    if (!(await bar(page)).open) await clickOn(page, ".toggle");
    await expect
      .poll(async () => {
        const b = await bar(page);
        return b.open && b.items.length == 2 && b.items.every((i) => i.img.startsWith("blob:") && i.drawn > 0);
      })
      .toBe(true);
    const b = await bar(page);
    expect(b.items.map((i) => i.label)).toEqual(LABELS);
    return b;
  }

  test("/new?template=slides makes a document; viewing at 1200 × 800, one slide fits; forward, ← and → step; the list shows both slides and a click goes to one", async ({
    tab,
  }) => {
    page = tab.page;
    const made = await newDoc(s, "slides");
    expect(made.status).toBe(302);
    await openTab(tab, made.address, { width: 1200, height: 800 });
    await expect.poll(async () => (await bar(page)).shown).toBe(true);
    await atStep(page, 0, 2);
    await expect.poll(fits).toBe(true);
    await clickOn(page, ".next");
    await atStep(page, 1, 2);
    await page.keyboard.press("ArrowLeft");
    await atStep(page, 0, 2);
    await page.keyboard.press("ArrowRight");
    await atStep(page, 1, 2);
    await listShown();
    await clickOn(page, ".step", 0);
    await atStep(page, 0, 2);
  });

  test("editing: one slide fits; forward, back and → outside the text step; an edit to a title shows in the list with a new picture", async () => {
    await page.locator(".erga-edit-button").click();
    await editorReady(page);
    await expect.poll(async () => (await bar(page)).shown && (await inPage<number>(page, "ergaSteps.current()")) == 0).toBe(true);
    await expect.poll(fits).toBe(true);
    await clickOn(page, ".next");
    await atStep(page, 1, 2);
    await clickOn(page, ".back");
    await atStep(page, 0, 2);
    await inPage(page, "document.activeElement.blur(), getSelection().removeAllRanges(), true");
    await rawKey(page, "ArrowRight");
    await atStep(page, 1, 2);
    const before = await listShown();
    // Type into the second slide's title: the list's label and picture follow.
    await clickTextEnd(page, "h2");
    await rawKey(page, "End");
    await page.keyboard.insertText("!");
    await expect
      .poll(async () => {
        const b = await bar(page);
        return (
          b.items[1]?.label == "Second slide!" &&
          b.items[1].img.startsWith("blob:") &&
          b.items[1].img != before.items[1].img &&
          b.items[1].drawn > 0
        );
      })
      .toBe(true);
  });
});

journey("a page with steps: its controls, viewing and editing, and full screen", () => {
  let page: Page;
  /** Clicks the bar's way out of full screen, with the mouse. */
  async function exit() {
    const at = await controlAt(page, ".exit");
    await pointerOnPage(page, at.x, at.y);
    await page.mouse.click(at.x, at.y);
  }
  /** The pointer moves over the page. */
  async function movePointer() {
    await page.mouse.move(300, 300);
    await page.mouse.move(320, 310);
  }

  test("viewing: 1 / 4 with back off; forward, → in the page and ← on the controls go to a step; the page going by itself shows; forward is off at the last", async ({
    tab,
  }) => {
    page = tab.page;
    const { address } = await s.fixture("steps");
    await openTab(tab, address);
    await expect.poll(async () => (await bar(page)).shown).toBe(true);
    const b = await bar(page);
    expect([b.at, b.back, b.next]).toEqual(["1 / 4", true, false]);
    await clickOn(page, ".next");
    await atStep(page, 1, 4);
    // A click in the page, away from its text, then → there.
    await clickAway(page, 30, 30);
    await page.keyboard.press("ArrowRight");
    await atStep(page, 2, 4);
    await focusOn(page, ".back");
    await page.keyboard.press("ArrowLeft");
    await atStep(page, 1, 4);
    await inPage(page, "ergaSteps.go(3), true");
    await atStep(page, 3, 4);
    expect((await bar(page)).next).toBe(true);
  });

  test("viewing: the button makes the page full screen; the arrows step it; the controls show, go while the pointer is still, and come back; Escape leaves at the same step", async () => {
    // Outside full screen, no way out on the controls.
    expect(await controlShown(page, ".exit")).toBe(false);
    const button = page.locator(".erga-view-buttons .erga-full-button");
    await expect.poll(() => button.isVisible()).toBe(true);
    await button.click();
    await expect.poll(() => full(page)).toBe("page");
    expect(await fills(page)).toBe(true);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await atStep(page, 1, 4);
    expect((await fullBar(page)).over).toBe(true);
    // The pointer still: the controls go; it moves over the page: they come back.
    await expect.poll(async () => (await fullBar(page)).still, { timeout: 5000 }).toBe(true);
    await movePointer();
    await expect.poll(async () => (await fullBar(page)).still).toBe(false);
    await escape(page);
    await expect.poll(() => full(page)).toBe("");
    await atStep(page, 1, 4);
    await expect.poll(() => fills(page)).toBe(false);
    expect(await fullBar(page)).toEqual({ over: true, still: false });
    expect(await button.isVisible()).toBe(true);
  });

  test("editing: forward and → outside the text go to a step; ← in the heading's text stays; an edit gives the list a new label and new pictures", async () => {
    await page.locator(".erga-edit-button").click();
    await editorReady(page);
    await expect.poll(async () => (await bar(page)).shown && (await inPage<number>(page, "ergaSteps.current()")) == 1).toBe(true);
    // The editor's notes (a confirmation, the alerts) sit over the steps bar, not on it.
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector(".notes")!).bottom)).toBe("58px");
    // The list open first: a click on its toggle later would take the caret out of the page.
    await clickOn(page, ".toggle");
    await expect.poll(async () => (await bar(page)).open).toBe(true);
    await clickOn(page, ".next");
    await atStep(page, 2, 4);
    // A click in the page puts the caret in the nearest text: out of it, the page has the keys.
    await clickAway(page, 30, 30);
    await inPage(page, "document.activeElement.blur(), getSelection().removeAllRanges(), true");
    await rawKey(page, "ArrowRight");
    await atStep(page, 3, 4);
    // Into the heading's text: the arrows move the caret there.
    await clickTextEnd(page, "h1", 4);
    const caret = () => inPage<number>(page, "getSelection().anchorOffset");
    const before = await caret();
    await rawKey(page, "ArrowLeft");
    await expect.poll(caret).toBe(before - 1);
    expect(await inPage<number>(page, "ergaSteps.current()")).toBe(3);
    expect((await bar(page)).at).toBe("4 / 4");
    await expect
      .poll(async () => (await bar(page)).items.length == 4 && (await bar(page)).items.every((i) => i.img.startsWith("blob:")))
      .toBe(true);
    const pictures = (await bar(page)).items.map((i) => i.img);
    await page.keyboard.insertText("s");
    await expect
      .poll(async () => {
        const b = await bar(page);
        return (
          b.items[3].label.length == 15 &&
          b.items[3].label != "How to see one" &&
          b.items.every((i, k) => i.img.startsWith("blob:") && i.img != pictures[k])
        );
      })
      .toBe(true);
    await clickOn(page, ".toggle");
    await expect.poll(async () => (await bar(page)).open).toBe(false);
  });

  test("editing: in full screen the controls show over the page; the arrows step, not the caret; the way out leaves at the same step", async () => {
    await page.locator("#btn-full").click();
    await expect.poll(() => full(page)).toBe("page");
    await page.keyboard.press("ArrowLeft");
    await atStep(page, 2, 4);
    await movePointer();
    await expect.poll(() => fullBar(page)).toEqual({ over: true, still: false });
    await exit();
    await expect.poll(() => full(page)).toBe("");
    await atStep(page, 2, 4);
    expect(await bar(page)).toMatchObject({ shown: true, open: false });
  });
});

journey("a deck whose slides build up in parts", () => {
  let page: Page;
  /** The tab's hash, the text of the slide shown, the counter, and the buttons [back off, forward off], once they agree. */
  async function at(hash: string, text: string, counter: string, off: [boolean, boolean]) {
    await expect
      .poll(async () => {
        const b = await bar(page);
        return [
          new URL(page.url()).hash,
          await inPage<string>(page, `document.querySelector(".slide.current").innerText.replace(/\\s+/g, " ").trim()`),
          b.at,
          b.back,
          b.next,
        ];
      })
      .toEqual([hash, text, counter, ...off]);
  }
  const ONE = "First slide One.",
    TWO = "First slide One. Two.",
    THREE = "First slide One. Two. Three.",
    SECOND = "Second slide No parts here.",
    RED = "Third slide Red.",
    GREEN = "Third slide Red. Green.",
    BLUE = "Third slide Red. Green. Blue.";
  const key = (k: "ArrowLeft" | "ArrowRight") => page.keyboard.press(k);

  // A slide's parts were not steps: the counter and the keys went slide by slide.
  test("viewing: each part is a step (1.1 / 3 … 3.3 / 3): → and forward, ← and back go part by part, and forward is off only at the very last part", async ({
    tab,
  }) => {
    page = tab.page;
    const { address } = await s.fixture("builds");
    await openTab(tab, address);
    await expect.poll(async () => (await bar(page)).shown).toBe(true);
    // The keys pressed in the page: a click on it, away from its text, first.
    await clickAway(page, 30, 300);
    await at("#1", ONE, "1.1 / 3", [true, false]);
    await key("ArrowRight");
    await at("#1.2", TWO, "1.2 / 3", [false, false]);
    await clickOn(page, ".next");
    await at("#1.3", THREE, "1.3 / 3", [false, false]);
    await key("ArrowRight");
    await at("#2", SECOND, "2 / 3", [false, false]);
    await clickOn(page, ".next");
    await at("#3", RED, "3.1 / 3", [false, false]);
    await key("ArrowRight");
    await at("#3.2", GREEN, "3.2 / 3", [false, false]);
    await clickOn(page, ".next");
    // The very last part: forward is off, and → stays.
    await at("#3.3", BLUE, "3.3 / 3", [false, true]);
    await key("ArrowRight");
    await settle(page);
    await at("#3.3", BLUE, "3.3 / 3", [false, true]);
    // ← and back, part by part, to the slide before with all its parts.
    await key("ArrowLeft");
    await at("#3.2", GREEN, "3.2 / 3", [false, false]);
    await clickOn(page, ".back");
    await at("#3", RED, "3.1 / 3", [false, false]);
    await key("ArrowLeft");
    await at("#2", SECOND, "2 / 3", [false, false]);
    await clickOn(page, ".back");
    await at("#1.3", THREE, "1.3 / 3", [false, false]);
  });

  test("the list shows each part with its picture, numbered by slide and part; a click on 3.2 goes there, and a reload opens at #3.2", async () => {
    await clickOn(page, ".toggle");
    // (The list asks for the pictures in sight: each in turn is scrolled to.)
    await expect
      .poll(async () => {
        const b = await bar(page);
        const k = b.items.findIndex((i) => !i.drawn);
        if (k >= 0) await scrollToStep(page, k);
        return b.open && b.items.length == 7 && k < 0;
      })
      .toBe(true);
    const b = await bar(page);
    expect(b.items.map((i) => i.n)).toEqual(["1.1", "1.2", "1.3", "2", "3.1", "3.2", "3.3"]);
    expect(b.items.map((i) => i.label)).toEqual([
      "First slide",
      "First slide",
      "First slide",
      "Second slide",
      "Third slide",
      "Third slide",
      "Third slide",
    ]);
    // A new slide's first step is marked.
    expect(b.items.map((i) => i.first)).toEqual([false, false, false, true, true, false, false]);
    expect(new Set(b.items.map((i) => i.img)).size).toBe(7);
    await clickOn(page, ".step", 5);
    await at("#3.2", GREEN, "3.2 / 3", [false, false]);
    expect((await bar(page)).items.map((i) => i.current)).toEqual([false, false, false, false, false, true, false]);
    await page.reload();
    await at("#3.2", GREEN, "3.2 / 3", [false, false]);
  });
});

journey("full screen in the editor, on a deck that steps by its own keys", () => {
  let ed: Editor, page: Page;

  // After full screen the text had the keys still: typing edited the page that nobody saw being edited.
  test("after full screen the text is left, as after Escape: typing edits nothing; a click on text edits again", async ({ tab }) => {
    ed = await openEditor(tab, s, "deck");
    page = tab.page;
    const before = await ed.source();
    await ed.clickEnd("h1");
    await ed.shows(`
      # First slide|

      The arrows move between slides.
    `);
    await page.locator("#btn-full").click();
    await expect.poll(() => full(page)).toBe("page");
    await escape(page);
    await expect.poll(() => full(page)).toBe("");
    // (The editor in the page stops for full screen and starts again after it: a click before it is back edits nothing.)
    await expect.poll(() => ed.frame<boolean>("!!window.ergaFrame?.page")).toBe(true);
    expect(await ed.eval<boolean>(`document.activeElement?.id == "frame"`)).toBe(true);
    await ed.type("x");
    expect(await ed.source()).toBe(before);
    await ed.clickEnd("h1");
    await ed.type("!");
    await expect.poll(() => ed.source()).toContain("<h1>First slide!</h1>");
  });

  test("the caret in a slide's title: full screen shows the deck; the arrows step it and typing edits nothing; Escape leaves at slide 3, #3", async () => {
    const before = await ed.source();
    await ed.shows(`
      # First slide!|

      The arrows move between slides.
    `);
    await page.locator("#btn-full").click();
    await expect.poll(() => full(page)).toBe("page");
    expect(await fills(page)).toBe(true);
    // The focus is off the text, in the page.
    await expect.poll(() => ed.frame<boolean>(`!${F}.activeElement?.closest("[contenteditable]")`)).toBe(true);
    await ed.press("ArrowRight");
    await ed.press("ArrowRight");
    await ed.shows(`
      # Third slide

      The last one.
    `);
    await ed.type("x");
    await escape(page);
    await expect.poll(() => full(page)).toBe("");
    await ed.shows(`
      # Third slide

      The last one.
    `);
    expect(await ed.eval<string>(`location.hash`)).toBe("#3");
    expect(await ed.source()).toBe(before);
    await expect.poll(() => fills(page)).toBe(false);
    // The editor as it was: its controls, and the focus in the page.
    expect(await page.locator("#btn-full").isVisible()).toBe(true);
    expect(await ed.eval<boolean>(`document.activeElement?.id == "frame"`)).toBe(true);
  });
});

journey("a presentation served as it is, with no viewer", () => {
  let page: Page;
  const SITE = "https://site.example/";
  /** The step bar (erga/steps' shadow root), as the page shows it. */
  const stepBar = () =>
    page.evaluate(() => {
      const c = document.querySelector("erga-steps")?.shadowRoot,
        b = c?.querySelector<HTMLElement>(".bar");
      return {
        shown: !!b && !b.hidden && b.getClientRects().length > 0,
        at: b?.querySelector(".at")?.textContent ?? "",
        steps: [...(c?.querySelectorAll(".step .name span") ?? [])].map((e) => e.textContent),
      };
    });
  const control = (selector: string) =>
    page.evaluate((sel) => document.querySelector("erga-steps")!.shadowRoot!.querySelector<HTMLElement>(sel)!.click(), selector);

  test("the slides template: the bar shows the steps; → and the bar's buttons step; the list names the slides", async ({ tab }) => {
    page = tab.page;
    // A template's files at SITE, as a server gives its homepage's site: each page as it is, and Erga's libraries at
    // their paths there (/erga/<name>/editor.js, and the build it imports). The page's text names no server.
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
    await page.route(`${SITE}**`, async (r) => {
      const path = new URL(r.request().url()).pathname;
      if (/^\/_?erga\//.test(path)) {
        const res = await fetch(s.root + path);
        return r.fulfill({
          status: res.status,
          contentType: res.headers.get("content-type") ?? "text/javascript",
          body: Buffer.from(await res.arrayBuffer()),
        });
      }
      const [template, file = "index.html"] = new URL(r.request().url()).pathname.slice(1).split("/");
      try {
        return r.fulfill({
          contentType: file.endsWith(".js") ? "text/javascript" : "text/html",
          body: readFileSync(join(ROOT, "assets/templates", template, file || "index.html")),
        });
      } catch {
        return r.fulfill({ status: 404, body: "" });
      }
    });
    await page.goto(`${SITE}slides/index.html`);
    await expect.poll(async () => (await stepBar()).at).toBe("1 / 2");
    expect((await stepBar()).shown).toBe(true);
    await page.mouse.click(5, 5);
    await rawKey(page, "ArrowRight");
    await expect.poll(async () => (await stepBar()).at).toBe("2 / 2");
    expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".slide")].map((s) => !s.hidden))).toEqual([false, true]);
    expect(new URL(page.url()).hash).toBe("#2");
    await control(".back");
    await expect.poll(async () => (await stepBar()).at).toBe("1 / 2");
    await control(".toggle");
    await expect.poll(async () => (await stepBar()).steps).toEqual(["Untitled presentation", "Second slide"]);
    // No editor without the viewer: the deck's bar for the slides stays hidden.
    expect(await page.evaluate(() => document.querySelector("slide-bar")?.shadowRoot?.querySelector<HTMLElement>(".bar")?.hidden)).toBe(
      true
    );
  });

  test("the canvas template: the bar shows its frames, and → moves the camera to the next one", async () => {
    await page.goto(`${SITE}canvas/index.html`);
    await expect.poll(async () => (await stepBar()).at).toMatch(/^1 \/ \d+$/);
    const count = Number((await stepBar()).at.split(" / ")[1]);
    expect(count).toBeGreaterThan(1);
    await page.mouse.click(5, 5);
    await rawKey(page, "ArrowRight");
    await expect.poll(async () => (await stepBar()).at).toBe(`2 / ${count}`);
    expect(await page.evaluate(() => [...document.querySelectorAll(".frame")].findIndex((f) => f.classList.contains("current")))).toBe(1);
    expect(new URL(page.url()).hash).toBe("#2");
  });
});
