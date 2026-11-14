// The editor's panels and bars over one page: the Share card and Share with an agent, the zoom of the page (the bars
// keep their size), the agent pane's colours on a dark page, a reload at a phone's width, and the bars on a phone. And
// a canvas, which has the whole window under them.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { openNew } from "../editor/caret-helpers";
import { DISK_MS, F, openEditor, type Editor } from "../helpers/editor";
import { expect, journey, servers, test } from "../helpers/fixtures";
import { pointerOnPage, pressOn } from "../helpers/press";
import { atRest, soon } from "./shell";

const s = await servers.main();

/** The page's frame in the window: its left and top. */
const FRAME = `(() => { const r = document.getElementById("frame").getBoundingClientRect(); return [r.left, r.top]; })()`;
/** Where the room beside the agent's pane ends: the left edge of what the pane leaves clear (--frame-l). */
const PANE = `parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--frame-l"))`;

journey("the panels and the bars over a page", () => {
  let ed: Editor, page: Page;
  /** The page's size before any zoom, and the sizes of Erga's own parts with the agent's pane open. */
  let before: { scale: number; width: number; height: number }, shell: Awaited<ReturnType<typeof chrome>>;

  /**
   * A click as a person makes it: the mouse goes to the element (which brings back the controls that typing hid; they
   * move in as they come), then clicks at its middle, once nothing covers it there.
   */
  const clickOn = async (selector: string) => {
    const centre = () =>
      page.evaluate((sel) => {
        const r = document.querySelector(sel)!.getBoundingClientRect(),
          x = r.x + r.width / 2,
          y = r.y + r.height / 2;
        return document.querySelector(sel)!.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
      }, selector);
    const box = (await page.locator(selector).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await soon(centre).toBeTruthy();
    await pressOn(page, selector);
  };
  const cardOpen = () => ed.eval<boolean>(`!document.getElementById("sharing").hidden`);
  const agentTip = () => ed.eval<string>(`document.getElementById("btn-agent-share").dataset.tip`);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  /** The page's scripts from Erga's origin: the library's address, and its build. */
  const library = () =>
    ed.frame<string[]>(
      `[...${F}.querySelectorAll("script[src]")].map((x) => x.src).filter((u) => u.startsWith(${JSON.stringify(`${s.root}/erga/`)}))`
    );
  /** The page's scale, and the h1's box as the tab draws it. */
  const zoomed = () =>
    ed.frame<{ scale: number; width: number; height: number }>(`(() => {
      const scale = window.ergaFrame?.zoom ?? 1, h = ${F}.querySelector("h1").getBoundingClientRect();
      return { scale, width: h.width * scale, height: h.height * scale };
    })()`);
  const scale = async () => (await zoomed()).scale;
  /** The sizes of Erga's own parts. */
  const chrome = () =>
    ed.eval<{ header: number; font: number; agent: number; agentFont: number; dpr: number }>(`(() => {
      const h = document.querySelector(".chrome-top"), a = document.getElementById("agent");
      return { header: h.getBoundingClientRect().height, font: parseFloat(getComputedStyle(h).fontSize), agent: a.getBoundingClientRect().width,
        agentFont: parseFloat(getComputedStyle(document.getElementById("agent-input")).fontSize), dpr: devicePixelRatio };
    })()`);
  /** A point in the tab, `at` along an element's width, on the page as it is drawn (scaled). */
  const pointOn = async (selector: string, at = 0.5) => {
    const f = await ed.frameAt();
    const r = await ed.frame<{ x: number; y: number }>(`(() => {
      const k = window.ergaFrame?.zoom ?? 1, r = ${F}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: (r.left + r.width * ${at}) * k, y: (r.top + r.height / 2) * k };
    })()`);
    return { x: f.x + r.x, y: f.y + r.y };
  };
  /** A click just after the end of an element's text, on the page as it is drawn (scaled, and moved sideways). */
  const clickEndZoomed = async (selector: string) => {
    const f = await ed.frameAt();
    const r = await ed.frame<{ x: number; y: number }>(`(() => {
      const k = window.ergaFrame?.zoom ?? 1, range = ${F}.createRange();
      range.selectNodeContents(${F}.querySelector(${JSON.stringify(selector)}));
      const r = [...range.getClientRects()].at(-1);
      return { x: r.right * k + 2, y: (r.top + r.height / 2) * k };
    })()`);
    await ed.click(f.x + r.x, f.y + r.y);
  };
  /** The zoom action's text in the bar, or null where it is not in sight. */
  const zoomAction = () =>
    page.evaluate(() => {
      const b = document.getElementById("btn-zoom");
      return b?.checkVisibility() ? b.textContent!.trim() : null;
    });
  /** The two bars as they show on a phone: the quick actions' width, the buttons in sight, the breadcrumbs' bar against the buttons'. */
  const look = () =>
    ed.eval<{
      quick: number;
      shown: string[];
      open: boolean;
      menu: boolean;
      navRight: number;
      topLeft: number;
      titleIn: boolean;
      brandOut: boolean;
    }>(`(() => {
      const top = document.querySelector(".chrome-top").getBoundingClientRect(), nav = document.getElementById("nav-docs").getBoundingClientRect();
      const title = document.getElementById("doc-title").getBoundingClientRect(), brand = document.getElementById("nav-brand").getBoundingClientRect();
      const shown = [...document.querySelectorAll(".chrome-top :is(.icon-btn, .avatar)")].filter((b) => {
        const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        return r.width > 0 && b.contains(document.elementFromPoint(x, y));
      }).map((b) => b.id || (b.classList.contains("me") ? "me" : b.className));
      return {
        quick: Math.round(document.getElementById("quick").getBoundingClientRect().width), shown,
        open: document.body.classList.contains("quick-open"), menu: !document.getElementById("account").hidden,
        navRight: nav.right, topLeft: top.left,
        titleIn: title.right <= nav.right + 0.5 && title.right >= nav.right - 12, brandOut: brand.left < nav.left,
      };
    })()`);
  const resting = async () => {
    const l = await look();
    return { quick: l.quick, shown: l.shown, open: l.open };
  };

  test("Share with an agent opens its menu; Install Erga's MCP copies one line, Erga's MCP server and then this document, and opens no card", async ({
    tab,
  }) => {
    ed = await openEditor(tab, s, "page");
    page = tab.page;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(ed.address).origin });
    expect(await library(), "Erga adds erga/text by its one address").toEqual([`${s.root}/erga/text/editor.js`]);
    await ed.clickEnd("h1");
    await ed.idle();
    await clickOn("#btn-agent-share");
    await clickOn("#btn-agent-share-menu .am-mcp");
    await soon(agentTip).toBe("Copied ✓");
    expect(await clipboard()).toBe(`Add Erga's MCP server, ${new URL(ed.address).origin}/mcp, then open ${ed.address}.`);
    // Its icon stays; the menu closed, and the Share card stays closed.
    expect(
      await ed.eval<boolean>(
        `!!document.querySelector("#btn-agent-share svg") && document.getElementById("sharing").hidden && document.getElementById("btn-agent-share-menu").hidden`
      )
    ).toBe(true);
  });

  test("the Share card offers Can comment: the owner adds a commenter with it, and their line shows it; the link offers it too", async () => {
    await clickOn("#btn-share");
    await soon(() => ed.eval<number>(`document.querySelectorAll("#sharing-list li").length`)).toBe(1);
    const labels = (sel: string) =>
      ed.eval<string[]>(`[...document.querySelector(${JSON.stringify(sel)}).options].map((o) => o.textContent)`);
    expect(await labels("#sharing-add select[name=role]")).toEqual(["Can edit", "Can comment", "Can view"]);
    expect(await labels("#sharing-anyone")).toEqual(["No access", "Can view", "Can comment", "Can edit"]);
    await clickOn("#sharing-add input[name=who]");
    await page.keyboard.type("Ada");
    await page.locator("#sharing-add select[name=role]").selectOption({ label: "Can comment" });
    await page.locator("#sharing-add input[name=who]").press("Enter");
    await soon(() =>
      ed.eval<string | null>(
        `document.querySelector("#sharing-list select[aria-label='Role for ada']")?.selectedOptions[0].textContent ?? null`
      )
    ).toBe("Can comment");
  });

  test('Copy link says "Copied ✓" on its button, puts the link on the clipboard, then the card closes and the caret is back on the page', async () => {
    await clickOn("#sharing-copy");
    await soon(() => ed.eval<string>(`document.querySelector("#sharing-copy").textContent`)).toBe("Copied ✓");
    expect(await clipboard()).toBe(ed.address);
    await soon(cardOpen).toBe(false);
    await ed.idle();
    await ed.type("x");
    await soon(() => ed.textOf("h1")).toBe("Launch notesx");
    expect(await ed.caretIn("h1")).toBe(true);
    // Open again: the button has its own name back.
    await clickOn("#btn-share");
    await soon(cardOpen).toBe(true);
    expect(await ed.eval<string>(`document.querySelector("#sharing-copy").textContent`)).toBe("Copy link");
    await ed.press("Escape");
    await soon(cardOpen).toBe(false);
  });

  test("zoomed, the bar shows the level; ⌘0 or a click on it goes back to 100%; a zoom never reloads the page", async () => {
    before = await zoomed();
    expect(before.scale).toBe(1);
    // A mark in the page's window: a reload of the frame loses it.
    await ed.frame("(window.__kept = true)");
    await soon(zoomAction).toBe(null);
    // Two steps out, with the caret in the page: the bar shows 80%.
    await ed.clickEnd("h1");
    await ed.press("ControlOrMeta+Minus");
    await ed.press("ControlOrMeta+Minus");
    await soon(scale).toBeCloseTo(0.8, 2);
    await soon(zoomAction).toBe("80%");
    // ⌘0 (Ctrl+0 on Windows and Linux), in the page: back to 100%, and the action goes away.
    await ed.press("ControlOrMeta+Digit0");
    await soon(scale).toBe(1);
    await soon(zoomAction).toBe(null);
    // A step in, and a click on the action.
    await ed.press("ControlOrMeta+Equal");
    await soon(zoomAction).toBe("110%");
    await page.click("#btn-zoom");
    await soon(scale).toBe(1);
    await soon(zoomAction).toBe(null);
    expect(await ed.frame("window.__kept === true"), "the page did not load again").toBe(true);
  });

  test("⌘+, ⌘− and ctrl with the wheel zoom the page only; a click on the zoomed page types there; ⌘0 resets", async () => {
    await ed.openAgent();
    // (The pane has opened: the page has moved aside, and rests.)
    let left = -1;
    await soon(async () => {
      const was = left;
      left = (await ed.frameAt()).x;
      await ed.settle();
      return was == left;
    }).toBe(true);
    shell = await chrome();
    expect(shell.agent).toBeGreaterThan(100);
    const start = await zoomed();

    // The keys, from the agent's box (the shell) and from the page (the frame forwards them).
    await ed.press("ControlOrMeta+Equal");
    await soon(scale).toBeCloseTo(1.1, 2);
    await clickEndZoomed("h1");
    await ed.press("ControlOrMeta+Equal");
    await soon(scale).toBeCloseTo(1.25, 2);
    expect((await ed.toast()).text).toBe("Zoom 125%");
    expect((await zoomed()).height).toBeGreaterThan(start.height * 1.2);
    expect(await chrome()).toEqual(shell);

    // A click on the zoomed page lands where it's aimed: at the end of the h1, typing goes there.
    await clickEndZoomed("h1");
    await ed.type("!");
    await soon(() => ed.textOf("h1")).toBe("Launch notesx!");

    // Ctrl with the wheel, over the page and over the controls: a step out each time.
    const p = await pointOn("p.lede");
    await pointerOnPage(page, p.x, p.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 100);
    await soon(scale).toBeCloseTo(1.1, 2);
    const head = await ed.eval<{ x: number; y: number }>(
      `(() => { const r = document.querySelector(".chrome-top").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
    );
    await page.mouse.move(head.x, head.y);
    await page.mouse.wheel(0, 100);
    await page.keyboard.up("Control");
    await soon(scale).toBeCloseTo(1, 2);
    await ed.press("ControlOrMeta+Minus");
    await soon(scale).toBeCloseTo(0.9, 2);
    expect(await chrome()).toEqual(shell);

    // ⌘0: back to 100%, and the page as large as it was.
    await ed.press("ControlOrMeta+Digit0");
    await soon(scale).toBe(1);
    expect((await zoomed()).height).toBeCloseTo(start.height, 0);
  });

  test("a pinch zooms around the pointer, with the page under it in each frame; zoomed, the page scrolls to its right edge and its bottom; the keys reach both limits and 100%, under the bars", async () => {
    /** The frame's sides against its place's (the window beside the agent's pane): 0 where the page ends at the place's edge. */
    const edges = () =>
      ed.eval<{ left: number; right: number }>(`(() => {
        const f = document.getElementById("frame"), r = f.getBoundingClientRect();
        return { left: Math.round(r.left - f.offsetLeft), right: Math.round(r.right - f.offsetLeft - f.offsetWidth) };
      })()`);
    /** The bars are in sight, at their own size, and the window itself is not zoomed. */
    const bars = async () => ({
      ...(await chrome()),
      top: await ed.eval<boolean>(`(() => {
      const h = document.querySelector(".chrome-top"), r = h.getBoundingClientRect();
      return visualViewport.scale == 1 && r.top >= 0 && r.right <= innerWidth && h.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    })()`),
    });
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    // At 150%, where this short page has room to scroll. From here on, each time the page's window gets another height
    // (a level of the zoom), as the browser paints it: where the lede is on the screen, down from the frame's top.
    for (let i = 0; i < 3; i++) await ed.press("ControlOrMeta+Equal");
    await soon(scale).toBe(1.5);
    await ed.frame(`(() => {
      const tall = innerHeight * 1.5, at = () => document.querySelector("p.lede").getBoundingClientRect().top * tall / innerHeight;
      const seen = (window.__ledeAt = [at()]);
      new ResizeObserver(() => seen.push(at())).observe(document.querySelector("erga-view") ?? document.documentElement);
      return true;
    })()`);
    // A trackpad's pinch on the lede's top edge: ctrl with the wheel, in many small moves. That point stays under the pointer.
    const lede = async () => ({
      x: (await pointOn("p.lede", 0.25)).x,
      y:
        (await ed.frameAt()).y +
        (await ed.frame<number>(`document.querySelector("p.lede").getBoundingClientRect().top * (window.ergaFrame?.zoom ?? 1)`)),
    });
    const p = await lede();
    await pointerOnPage(page, p.x, p.y);
    await page.keyboard.down("Control");
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -5.5);
    await soon(scale).toBeCloseTo(1.5 * Math.exp(0.55), 2);
    await soon(async () => dist(await lede(), p)).toBeLessThan(3);
    // Back out to 150%: the same point, still, and at every level between.
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 5.5);
    await soon(scale).toBeCloseTo(1.5, 2);
    await soon(async () => dist(await lede(), p)).toBeLessThan(3);
    const seen = await ed.frame<number[]>(`window.__ledeAt`);
    expect(seen.length, "the page's levels during the pinch").toBeGreaterThan(5);
    expect(
      Math.max(...seen.map((y) => Math.abs(y - seen[0]))),
      "the lede, up or down from its place, at any level of the pinch"
    ).toBeLessThan(3);
    // And on, to the least: the pinch stops at 50%.
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 49.5);
    await page.keyboard.up("Control");
    await soon(zoomAction).toBe("50%");
    expect(await bars()).toEqual({ ...shell, top: true });

    // Zoomed in, the page is wider than its place: the wheel takes it to its right edge and back to its left one, and down to its bottom.
    await ed.press("ControlOrMeta+Digit0");
    for (let i = 0; i < 5; i++) await ed.press("ControlOrMeta+Equal");
    await soon(scale).toBe(2);
    expect(await edges(), "around the middle").toEqual({ left: -(await edges()).right, right: (await edges()).right });
    await pointerOnPage(page, p.x, p.y);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(600, 0);
    await soon(async () => (await edges()).right).toBe(0);
    for (let i = 0; i < 8; i++) await page.mouse.wheel(-600, 0);
    await soon(async () => (await edges()).left).toBe(0);
    await page.mouse.wheel(0, 20000);
    await soon(() => ed.frame<boolean>(`scrollY > 0 && scrollY + innerHeight >= document.documentElement.scrollHeight - 1`)).toBe(true);

    // The keys, to both limits and back to 100%: the bars stay where they are, at their size.
    for (let i = 0; i < 3; i++) await ed.press("ControlOrMeta+Equal");
    await soon(zoomAction).toBe("300%");
    for (let i = 0; i < 13; i++) await ed.press("ControlOrMeta+Minus");
    await soon(zoomAction).toBe("50%");
    expect(await bars()).toEqual({ ...shell, top: true });
    await ed.press("ControlOrMeta+Digit0");
    await soon(scale).toBe(1);
    await soon(zoomAction).toBe(null);
    expect(await edges()).toEqual({ left: 0, right: 0 });
  });

  test("a window the browser zoomed itself keeps its pinch in the editor: a pinch out brings the bars back, and the next one zooms the page", async () => {
    // The browser's own pinch (a reader's, or one before the editor was up): the window is 2 times larger, and the bars out of sight.
    const cdp = await page.context().newCDPSession(page);
    const windowZoom = () => page.evaluate(() => Math.round(visualViewport!.scale * 100) / 100);
    const pinch = (by: number) =>
      cdp.send("Input.synthesizePinchGesture", { x: 300, y: 250, scaleFactor: by, relativeSpeed: 2000, gestureSourceType: "mouse" });
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await soon(windowZoom).toBe(2);
    // A pinch out, on the page: the window's, all the way, and not the page's too.
    await pinch(0.25);
    await soon(windowZoom).toBe(1);
    expect(await scale()).toBe(1);
    // The next one is the page's.
    await pinch(0.8);
    await soon(scale).toBeCloseTo(0.8, 1);
    expect(await windowZoom()).toBe(1);
    await ed.press("ControlOrMeta+Digit0");
    await soon(scale).toBe(1);
    await cdp.detach();
  });

  test("Share with an agent's tooltip has its name back after its moment", async () => {
    // (1.6 s after the copy, which the steps since took.)
    await soon(agentTip).toBe("Share with an agent");
  });

  test("the agent pane is glass of the page's colour, with dark text on a white page and light text on a dark one", async () => {
    /** The agent pane's look: its glass's colour, and its text's. */
    const card = () =>
      ed.eval<{ glass: string; text: string }>(
        `({ glass: getComputedStyle(document.querySelector(".agent-glass")).backgroundColor, text: getComputedStyle(document.querySelector(".agent-card")).color })`
      );
    const dark = () => ed.eval<boolean>(`document.documentElement.classList.contains("page-dark")`);
    const white = await card();
    expect(await dark()).toBe(false);
    // The page turns dark (its stylesheet, on disk): the header's text is light on it, and so is the pane's, on glass of that colour.
    const css = join(ed.dir, "style.css");
    writeFileSync(css, `${readFileSync(css, "utf8")}body { background: rgb(20, 33, 61); color: #e8e8f0; }\n`);
    await soon(() => ed.frame<string>(`getComputedStyle(${F}.body).backgroundColor`), DISK_MS).toBe("rgb(20, 33, 61)");
    await soon(dark).toBe(true);
    await soon(async () => {
      const now = await card();
      return { glass: now.glass != white.glass, text: now.text != white.text };
    }).toEqual({ glass: true, text: true });
    // (A new stylesheet loads the page again, in a new window: the next step's keys wait for its editor.)
    await ed.loaded();
  });

  test("a reload at a phone's width keeps the zoom; the agent starts closed; a page that imports erga/text itself gets it once", async () => {
    await ed.press("ControlOrMeta+Equal");
    await soon(scale).toBeCloseTo(1.1, 2);
    // The page imports the library itself: Erga adds nothing, and the page's own import runs the editor.
    ed.write(ed.disk().replace("</head>", `<script type="module" src="${s.root}/erga/text/editor.js"></script>\n</head>`));
    await soon(() => ed.source(), DISK_MS).toContain("/erga/text/editor.js");
    expect(await ed.eval<boolean>(`document.body.classList.contains("agent-open")`), "on a desktop the agent is open").toBe(true);
    // (A page of text stays beside the agent's pane, where nothing covers it: only a canvas goes under it, below.)
    // (Its place: zoomed, the frame is drawn wider than its place, and shows only there.)
    expect(
      await ed.eval<number[]>(`(() => { const f = document.getElementById("frame"); return [f.offsetLeft, f.offsetTop]; })()`),
      "a text page's frame starts at the pane's side"
    ).toEqual([await ed.eval<number>(PANE), 0]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await ed.loaded();
    expect(await ed.eval<boolean>(`document.body.classList.contains("agent-open")`), "on a phone the agent starts closed").toBe(false);
    // The zoom is kept for the document across a reload.
    await soon(scale).toBeCloseTo(1.1, 2);
    await ed.press("ControlOrMeta+Digit0");
    await soon(scale).toBe(1);
    expect(await library()).toEqual([`${s.root}/erga/text/editor.js`]);
    await ed.clickEnd("h2");
    await ed.type(" today");
    await soon(() => ed.disk(), DISK_MS).toContain("<h2>What changed today</h2>");
  });

  test("phone: at rest only the avatar; a tap opens the quick actions and the menu, the breadcrumbs make way; a card keeps them open; a tap on the page closes all", async () => {
    await soon(resting).toEqual({ quick: 0, shown: ["me"], open: false });
    await pressOn(page, ".me-slot .avatar");
    await soon(async () => (await look()).shown).toEqual(
      expect.arrayContaining(["btn-new", "btn-full", "btn-settings", "btn-edit", "btn-agent-share", "btn-docs", "me"])
    );
    // (The bars slide: the look, once they rest.)
    await soon(async () => {
      const l = await look();
      return {
        open: l.open,
        menu: l.menu,
        navEndsBeforeTheButtons: l.navRight <= l.topLeft - 7.5,
        titleEndShows: l.titleIn,
        brandSlidOut: l.brandOut,
      };
    }).toEqual({ open: true, menu: true, navEndsBeforeTheButtons: true, titleEndShows: true, brandSlidOut: true });
    // Document settings, from the quick actions: its card opens, the menu closes, the quick actions stay.
    await pressOn(page, "#btn-settings");
    await soon(() => ed.eval<boolean>(`!!document.querySelector("#doc-settings:not([hidden])")`)).toBe(true);
    await soon(async () => {
      const l = await look();
      return { open: l.open, menu: l.menu };
    }).toEqual({ open: true, menu: false });
    // A tap on the page, above the settings' sheet, closes them all.
    const sheet = await atRest(page, "#doc-settings");
    await page.mouse.click(390 / 2, sheet.y / 2 + 40);
    await soon(resting).toEqual({ quick: 0, shown: ["me"], open: false });
    await soon(() => ed.eval<boolean>(`!!document.querySelector("#doc-settings:not([hidden])")`)).toBe(false);
  });

  // Was Pete's complaint: around a canvas, the band behind the bars and the room beside the agent's pane were the
  // shell's, not the canvas. The canvas template takes what they cover itself (window.ergaInset).
  test("a canvas has the whole window, under the bars and the agent's pane; its frame stays in the part they leave clear", async ({
    tab,
  }) => {
    const canvas = await openNew(tab, s, "canvas", { width: 1100, height: 800 });
    await soon(() => canvas.eval<number[]>(FRAME)).toEqual([0, 0]);
    expect(
      await canvas.eval<number[]>(`[document.getElementById("frame").offsetWidth, document.getElementById("frame").offsetHeight]`)
    ).toEqual([1100, 800]);
    /** The canvas's current frame on the screen (the page has the whole window: its own coordinates), once it rests there. */
    const current = `(() => { const r = ${F}.querySelector(".frame.current").getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map(Math.round); })()`;
    /** Whether the current frame is in the clear part: below the bars, right of the pane (`left`), and in its middle. */
    const clear = async (left: number) => {
      const [l, t, r, b] = await canvas.frame<number[]>(current);
      return {
        belowTheBars: t >= 56,
        inTheWindow: r <= 1100 && b <= 800,
        besideThePane: l >= left,
        inTheMiddle: Math.abs((l + r) / 2 - (left + 1100) / 2) <= 1,
      };
    };
    const all = { belowTheBars: true, inTheWindow: true, besideThePane: true, inTheMiddle: true };
    const open = () => canvas.eval<boolean>(`document.body.classList.contains("agent-open")`);
    if (await open()) await canvas.eval(`window.ergaAgent.show(false)`);
    await soon(() => clear(0)).toEqual(all);
    // The agent's pane opens over the canvas: the frame's box stays, and the camera moves the frame out from under it.
    await canvas.eval(`window.ergaAgent.show(true)`);
    await soon(open).toBe(true);
    const pane = await canvas.eval<number>(PANE);
    expect(pane).toBeGreaterThan(300);
    await soon(() => clear(pane)).toEqual(all);
    expect(await canvas.eval<number[]>(FRAME)).toEqual([0, 0]);
  });
});
