// Into the editor and back. A document that is slow to open, a short network drop, the bars over a scrolling page, the
// page's own place in its address (a hash) in the viewer and the editor, the pencil with Back and an agent's
// open_page on a document of several pages, and a deck: a refused edit key, full screen, a reload.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { editor, F, openEditor, type Editor } from "../helpers/editor";
import { ROOT } from "../helpers/env";
import { expect, journey, servers, test, until } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";
import { idOf, runTool, textOf } from "../helpers/tools";
import {
  agentTurn,
  asTester,
  bars,
  docFrame,
  editing,
  editorUp,
  fixtureWith,
  h1Of,
  hold,
  openPage,
  soon,
  viewing,
  welcome,
  where,
} from "./shell";
import { views } from "../viewer/frames";

const s = await servers.main();

journey("a document that is slow to open", () => {
  let ed: Editor, page: Page;
  let held: Awaited<ReturnType<typeof hold>>;
  /** The page's own socket (it opens with the edit key) waits here. */
  const own: (() => void)[] = [];
  const said: string[] = [];
  /** The second heading's top edge, in the page. */
  const more = () => ed.frame<number>(`${F}.getElementById("more").getBoundingClientRect().top`);

  // Before, the editor gave the room's hello 8 s, then said "Nothing to edit here" for good.
  test("a room that stays silent: the editor says the document is still opening, offers a reload, and starts when the hello comes", async ({
    tab,
  }) => {
    tab.strict = true;
    page = tab.page;
    await page.setViewportSize({ width: 1100, height: 760 });
    page.on("console", (m) => said.push(m.text()));
    held = await hold(page);
    await page.routeWebSocket(/\/api\/room\?key=/, (ws) => void own.push(() => ws.connectToServer()));
    // The editor's timers run 100 times faster while it opens: its minute is 600 ms.
    await asTester(page, 0.01);
    const { dir, address } = await s.fixture("tall-block");
    await page.goto(`${address}?edit`);
    await until(async () => /still opening/i.test(await welcome(page)), 10_000, "the editor says the document is still opening");
    // Long after the editor used to give up (8 s, 80 ms here): a reload is offered, and it still waits.
    await until(() => page.evaluate(() => !!document.querySelector("#welcome button")), 10_000, "the editor offers a reload");
    expect(await welcome(page)).not.toMatch(/Nothing to edit/);
    held.release();
    ed = editor(page, { address, dir, file: join(dir, "index.html") });
    await ed.loaded();
    expect(await welcome(page)).toBe("");
    await page.evaluate(`window.__ergaTimescale = 0.1`);
  });

  test("the page's editor takes keys while its socket still connects; the text reaches the room when it opens", async () => {
    await ed.clickEnd("h1");
    await ed.type(" Milk");
    await soon(() => ed.textOf("h1")).toBe("A page like the homepage Milk");
    expect(await ed.caretIn("h1")).toBe(true);
    // The socket opens: the shell's replica, which only the room feeds, gets the text.
    await until(() => own.length > 0, 5000, "the page's editor asks for its socket");
    expect(own.length).toBe(1);
    own[0]();
    await until(async () => (await ed.source()).includes("homepage Milk</h1>"), 10_000, "the text reaches the room");
  });

  test("a scrolling page: its first line starts below the bars; scrolled, its text goes under them; the room is not in its HTML", async () => {
    const b = await bars(page);
    expect(b.frame, "the frame starts at the top of the window").toBe(0);
    const h1 = await ed.frame<number>(`${F}.querySelector("h1").getBoundingClientRect().top`);
    expect(h1, "the first line starts below the bars").toBeGreaterThan(b.bottom);
    expect(await ed.frame<string>(`getComputedStyle(${F}.documentElement).paddingTop`)).toBe("56px");
    expect(await ed.source(), "the room is not in the page's HTML").not.toMatch(/padding-top|data-erga/);
    // The wheel over the page: its text moves under the bars, where they show it through their glass.
    const under = () =>
      ed.frame<boolean>(
        `[...${F}.querySelectorAll("body > :is(h1, h2, p, div)")].some((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top < ${b.bottom} - 10 && r.bottom > 10; })`
      );
    expect(await under(), "at the top, nothing of the page is under the bars").toBe(false);
    await page.mouse.move(550, 400);
    await page.mouse.wheel(0, 120);
    await soon(under).toBe(true);
    expect((await bars(page)).frame).toBe(0);
  });

  // Pete's keys on the homepage: scroll to the heading below its tall demo, select it with a triple click, type a
  // letter. The page jumped 56px: the room's measure took its rule off for a moment, and the scroll went up with it.
  test("typing over a selected heading down the page does not move the page", async () => {
    while ((await more()) > 360) {
      await page.mouse.wheel(0, 120);
      await ed.frame(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    }
    // The wheel's scroll has come to rest: the same place in two frames that follow each other.
    let last = -1;
    await until(
      async () => {
        const was = last;
        last = await ed.frame<number>(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(scrollY))))`);
        return was == last;
      },
      5000,
      "the scroll rests"
    );
    // (Not ed.rectOf: it scrolls the heading to the middle.) The frame starts at the tab's top-left.
    const at = await ed.frame<{ x: number; y: number }>(
      `(() => { const r = ${F}.getElementById("more").getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`
    );
    const before = await more();
    await ed.click(at.x, at.y, { clickCount: 3 });
    expect(await more(), "the selection does not move the page").toBeCloseTo(before, 0);
    await page.keyboard.press("X");
    await soon(() => ed.textOf("#more")).toBe("X");
    // A few frames: the room is measured again on the next one, after the editor draws its caret.
    await ed.frame(`new Promise((r) => { let n = 10; const f = () => (--n ? requestAnimationFrame(f) : r(1)); f(); })`);
    expect(await more(), "the letter does not move the page").toBeCloseTo(before, 0);
  });

  // Before, the page asked for its build after the connection came back, the build was another after any edit, and
  // the page reloaded itself at the next quiet moment.
  test("an edit, then a short network drop: the editor does not reload itself", async () => {
    await page.evaluate(`window.__before = true`);
    const checked = page.waitForResponse((r) => r.request().headers()["x-erga-check"] == "build", { timeout: 12_000 });
    expect(held.opened()).toBeGreaterThan(0);
    // The network goes for a moment: the tab's socket closes, and comes back by itself.
    await held.drop();
    await checked;
    // (Its answer is in: live.js decides at once.)
    await page.evaluate(`new Promise((r) => setTimeout(r, 0))`);
    expect(said.filter((t) => t.includes("a new release"))).toEqual([]);
    expect(await page.evaluate<boolean>(`window.__before === true`)).toBe(true);
    expect(await ed.source()).toContain("homepage Milk</h1>");
    expect(await ed.textOf("#more")).toBe("X");
  });
});

test("a document deleted while it opens: the editor says there is nothing to edit here", async ({ tab }) => {
  tab.strict = true;
  const page = tab.page;
  // The room's socket does not reach the server while the start is held: the document goes before the room's hello.
  const held = await hold(page, "closed");
  await asTester(page);
  const { address } = await s.fixture("empty");
  const id = await idOf(address);
  await page.goto(`${address}?edit`);
  await until(() => held.opened() > 0, 10_000, "the shell asks for the room");
  expect((await runTool(s.root, "delete_document", { document: id })).status).toBe(200);
  held.release();
  await until(async () => /Nothing to edit here/.test(await welcome(page)), 10_000, "the editor says there is nothing to edit");
  // The browser logs the refused start (404) and the refused sockets: the server's answer, not the page's error. They
  // come at any time from here on, so the test looks at the errors itself: any other one fails it.
  tab.strict = false;
  expect(tab.errors.filter((e) => !/status of 404|WebSocket connection to .* failed/.test(e))).toEqual([]);
});

journey("a page that keeps its view in its address, in the viewer and in the editor", () => {
  let page: Page, address: string;
  /** What the page shows: the view its switch has on, and the line of that view. */
  const shown = () =>
    docFrame(page)
      ?.evaluate(() => ({
        pressed: document.querySelector('.switch button[aria-pressed="true"]')?.textContent,
        line: [...document.querySelectorAll("#arch-grid p")].find((p) => p.getClientRects().length)?.textContent,
      }))
      .catch(() => null);
  const AWS = { pressed: "AWS", line: "ECS tasks" };
  const CF = { pressed: "Cloudflare", line: "Durable Objects" };
  const hash = () => new URL(page.url()).hash;
  const entries = () => page.evaluate(() => history.length);
  /** Clicks the middle of an element of the page, with the mouse, in the tab. */
  const clickIn = async (selector: string) => {
    const r = await docFrame(page)!.evaluate((sel) => {
      const b = document.querySelector(sel)!.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, selector);
    const at = await page.evaluate(() => document.getElementById("frame")!.getBoundingClientRect());
    await page.mouse.click(at.left + r.x, at.top + r.y);
  };

  test("the viewer, opened at #aws, shows AWS", async ({ tab }) => {
    tab.strict = true;
    page = tab.page;
    await asTester(page);
    ({ address } = await s.fixture("hash-switch"));
    await openPage(page, `${address}#aws`);
    await soon(shown).toEqual(AWS);
    expect(hash()).toBe("#aws");
  });

  test("viewer: a click on the page's own button shows its view; the tab's address follows, with no new entry", async () => {
    const before = await entries();
    await clickIn('.switch button[data-host="cf"]');
    await soon(shown).toEqual(CF);
    await soon(hash).toBe("#cloudflare");
    await clickIn('.switch button[data-host="aws"]');
    await soon(shown).toEqual(AWS);
    await soon(hash).toBe("#aws");
    expect(await entries(), "replaceState: a replace, as at the top").toBe(before);
  });

  test("viewer: pushState of #cloudflare, then a link to #aws: each is a new place, and Back goes through them", async () => {
    const before = await entries();
    await clickIn("#push-cf");
    await soon(hash).toBe("#cloudflare");
    await soon(shown).toEqual(CF);
    await clickIn("#to-aws");
    await soon(hash).toBe("#aws");
    await soon(shown).toEqual(AWS);
    expect(await entries()).toBe(before + 2);
    await page.goBack();
    await soon(hash).toBe("#cloudflare");
    await soon(shown).toEqual(CF);
    await page.goBack();
    await soon(hash).toBe("#aws");
    await soon(shown).toEqual(AWS);
    await page.goForward();
    await soon(hash).toBe("#cloudflare");
    await soon(shown).toEqual(CF);
    // The frame's own history got nothing: no Back press does nothing.
    expect(await entries()).toBe(before + 2);
  });

  test("viewer: the tab's address changed to #aws, with no reload, shows AWS; Back shows Cloudflare again", async () => {
    await page.evaluate(() => ((window as any).__same = true));
    await page.goto(`${address}#aws`);
    await soon(shown).toEqual(AWS);
    await page.goto(`${address}#cloudflare`);
    await soon(shown).toEqual(CF);
    await page.goBack();
    await soon(hash).toBe("#aws");
    await soon(shown).toEqual(AWS);
    await page.goBack();
    await soon(hash).toBe("#cloudflare");
    await soon(shown).toEqual(CF);
    expect(await page.evaluate(() => (window as any).__same), "no reload").toBe(true);
  });

  test("editor: the pencil keeps the page's view; a click on the page's own button shows the other, with no new entry", async () => {
    await page.locator(".erga-edit-button").click();
    await soon(() => editorUp(page), 10_000).toBe(true);
    expect(await page.evaluate(() => (window as any).__same), "no reload").toBe(true);
    expect(`${await where(page)}${hash()}`).toBe(`${new URL(address).pathname}?edit#cloudflare`);
    await soon(shown).toEqual(CF);
    const before = await entries();
    await clickIn('.switch button[data-host="aws"]');
    await soon(shown).toEqual(AWS);
    await soon(hash).toBe("#aws");
    expect(await entries(), "replaceState: a replace, as at the top").toBe(before);
  });

  // Was a bug (Pete's): the page loads again for an agent's change to its script, and a canvas's camera went back to
  // a frame; then the page showed its start for a moment before the camera came back. And the editor's caret below
  // the window counted as the page's overflow: the frame moved up.
  test("editor: a canvas dragged away, its caret out of the window, stays as it is when an agent changes its script, and when the person loads the tab again: the camera, the frame, the history, on every frame the tab paints", async () => {
    const made = await fetch(`${s.root}/new?template=canvas`, { redirect: "manual" });
    const canvas = s.root + (made.headers.get("location") ?? "").replace(/[?&]edit=?$/, "");
    await page.goto(`${canvas}?edit`);
    const ed = editor(page, { address: canvas, dir: "", file: "" });
    await ed.loaded();
    await ed.clickEnd(".frame.current p");
    /** The camera, the page's frame in the tab, and the tab's address and entries. */
    const view = async () => ({
      camera: await ed.frame<string>(`${F}.querySelector(".canvas").style.transform`),
      frame: await ed.eval<number[]>(
        `(() => { const r = document.getElementById("frame").getBoundingClientRect(); return [r.top, r.height]; })()`
      ),
      hash: hash(),
      entries: await entries(),
    });
    const first = await view();
    // A drag from the empty canvas left of the frame, down, until the caret's line is below the window's bottom.
    const down = await ed.frame<number>(`Math.round(innerHeight - ${F}.querySelector("erga-caret").getBoundingClientRect().top + 10)`);
    const at = await ed.frameAt(),
      y = at.y + Math.round(first.frame[1] * 0.3);
    await ed.drag(at.x + 8, y, at.x + 48, y + down);
    // The address says where the camera rests, with no new entry.
    await soon(hash).toMatch(/^#1@-?[\d.]+,-?[\d.]+,[\d.]+$/);
    const before = await view();
    expect(before.camera).not.toBe(first.camera);
    expect({ ...before, camera: "", hash: "" }).toEqual({ ...first, camera: "", hash: "" });
    await ed.frame(`window.__before = true`);
    // The page loads again in a second frame: the first one shows until the new page has the same view.
    const edited = await views(page, async () => {
      const calls = await agentTurn(s, await idOf(canvas), "Glide further", [
        { tool: "edit", args: { path: "canvas.js", edits: [{ oldText: "const RHO = 1.1;", newText: "const RHO = 1.2;" }] } },
      ]);
      expect(calls.map((c) => c.status)).toEqual(["done"]);
      await soon(() => ed.frame<boolean>(`!window.__before`), 10_000).toBe(true);
      await ed.loaded();
      await soon(view).toEqual(before);
      await soon(() => page.evaluate(() => document.querySelectorAll("iframe.erga-view").length)).toBe(1);
    });
    expect(edited, "the agent's change: no frame with another view, none without the page").toMatchObject({ moved: [], empty: 0 });
    // The person loads the tab again (⌘R): the page is out of sight until its camera is where it was.
    const again = await views(page, async () => {
      await page.reload();
      await ed.loaded();
      await soon(view).toEqual(before);
    });
    expect(again.moved, "⌘R: no frame with another view").toEqual([]);
    // A canvas made before it had the whole window (no window.ergaInset) sits below the bars, as a page that fills
    // its window does. The editor's caret, below the window's bottom, is not the page's overflow: measured again (a
    // resize), the page still fills its window.
    await soon(() => ed.frame<boolean>(`${F}.querySelector("erga-caret.on")?.getBoundingClientRect().top > innerHeight`)).toBe(true);
    await ed.frame(`delete window.ergaInset`);
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width + 40, height: size.height });
    await soon(async () => (await view()).frame[0]).toBeGreaterThan(0);
    await page.setViewportSize(size);
  });
});

journey("a document of several pages: the pencil, Back, and an agent's open_page", () => {
  let page: Page, dir: string, address: string;
  /** The editor's script fails to load while this is on. */
  let fail = false;
  const path = () => new URL(address).pathname;

  test("the editor's script fails to load: the pencil stops, the viewer says so, and the pencil tries again", async ({ tab }) => {
    tab.strict = true;
    page = tab.page;
    await page.route(/\/_erga\/main-[^/]*\.js/, (route) => (fail ? route.abort() : route.continue()));
    await asTester(page);
    const home = readFileSync(join(ROOT, "e2e/fixtures/multi/index.html"), "utf8");
    ({ dir, address } = await fixtureWith(s, "multi", {
      "index.html": home.replace("<h1>", `<nav data-erga-noedit><a href="about.html">About</a></nav>\n    <h1>`),
    }));
    // (With the page's place in the address: the second try loaded nothing then, as the address changed in its hash only.)
    await openPage(page, `${address}#place`);
    await soon(() => h1Of(page)).toBe("Field guide");
    fail = true;
    await page.locator(".erga-edit-button").click();
    // The viewer again, the address without ?edit, and a note by the pencil.
    await soon(() => viewing(page)).toBe(true);
    await soon(() => where(page)).toBe(path());
    await soon(() =>
      page
        .locator(".erga-edit-failed")
        .textContent()
        .catch(() => "")
    ).toContain("The editor didn't load");
    expect(await page.locator(".erga-edit-failed").isVisible()).toBe(true);
    // (The script that the test stopped, as the browser reports it: on purpose.)
    await until(() => tab.errors.some((e) => /net::ERR_FAILED/.test(e)), 5000, "the browser reports the script");
    tab.errors.splice(0, tab.errors.length, ...tab.errors.filter((e) => !/net::ERR_FAILED/.test(e)));
    // The pencil again, the network back: the editor opens.
    fail = false;
    await page.locator(".erga-edit-button").click();
    await soon(async () => `${await where(page)} ${await editorUp(page)}`, 10_000).toBe(`${path()}?edit true`);
  });

  // Before, Back showed the first page with the pencil pressed and the editor's controls, but the page was the viewer's.
  test("editor, pencil off, a link to another page, then Back: the first page in the viewer, not editable, the pencil off", async () => {
    await page.locator("#btn-edit").click();
    await soon(() =>
      page.evaluate(
        () => !!document.querySelector(".erga-crumbs > .erga-here")?.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      )
    ).toBe(true);
    await page.frameLocator("#frame").getByRole("link", { name: "About" }).click();
    await soon(async () => `${await where(page)} ${await h1Of(page)}`).toBe(`${path()}/about About us`);
    await page.goBack();
    await soon(async () => `${await where(page)} ${await h1Of(page)}`).toBe(`${path()} Field guide`);
    // What the page shows: the viewer's pencil, not pressed, and the editor's controls hidden.
    await soon(() => viewing(page)).toBe(true);
    // Typing in the page changes nothing; the pencil then opens the editor, and typing goes to the file.
    const h1 = page.frameLocator("#frame").locator("h1");
    await h1.click();
    await page.keyboard.type("X");
    await page.locator(".erga-edit-button").click();
    await soon(() => editorUp(page)).toBe(true);
    await h1.click();
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    const ed = editor(page, { address, dir, file: join(dir, "index.html") });
    await soon(() => ed.disk()).toContain("<h1>Field guide!</h1>");
    expect(await h1Of(page)).toBe("Field guide!");
  });

  test("the eye, a link to another page, then two entries back at once: the first page in the editor, its address kept", async () => {
    await page.locator("#btn-edit").click();
    await soon(() => viewing(page)).toBe(true);
    await page.frameLocator("#frame").getByRole("link", { name: "About" }).click();
    await soon(async () => `${await where(page)} ${await h1Of(page)}`).toBe(`${path()}/about About us`);
    // Two entries back at once (the Back button's menu): the frame's history and the tab's go back together.
    await page.evaluate(() => history.go(-2));
    await soon(async () => `${await where(page)} ${await h1Of(page)} ${await editorUp(page)}`).toBe(`${path()}?edit Field guide! true`);
  });

  test("open_page, from the document's agent and from an agent outside, takes the open editor to another page", async () => {
    const id = await idOf(address);
    const calls = await agentTurn(s, id, "Take me to Contact", [
      { tool: "page", args: { op: "open_page", path: "contact.html" } },
      { text: "There." },
    ]);
    expect(calls.map((c) => `${c.name} ${c.status}`)).toEqual(["open_page done"]);
    await soon(async () => `${await where(page)} ${await editorUp(page)} ${await editing(page)}`).toBe(
      `${path()}/contact?edit true contact.html`
    );
    const { token } = await newToken(s.root, { label: "Shell journey" });
    const back = await runTool(s.root, "open_page", { document: id, path: "about" }, { token });
    expect(back.ok).toBe(true);
    expect(textOf(back.result).startsWith("Opened about.html")).toBe(true);
    await soon(async () => `${await where(page)} ${await editorUp(page)}`).toBe(`${path()}/about?edit true`);
  });
});

journey("a deck in the editor", () => {
  let ed: Editor;
  const THIRD = `
    # Third slide

    The last one.
  `;

  /** From now on, the page keeps the words the shell tells it. */
  const watch = () =>
    ed.frame(
      `(() => { window.__said = []; addEventListener("message", (e) => { const t = e.data?.type; if (t == "erga-mode") __said.push(e.data.mode); else if (t == "erga-test-mark") __said.push("mark"); }); return true; })()`
    );
  /** The words the page got since `watch`, up to a mark the shell sends after all it has to do now. */
  const said = async (): Promise<string[]> => {
    await ed.frame(`(() => { __said = __said.filter((w) => w != "mark"); return true; })()`);
    await ed.eval(
      `new Promise((done) => setTimeout(() => { document.getElementById("frame").contentWindow.postMessage({ type: "erga-test-mark" }, "*"); done(true); }))`
    );
    await soon(() => ed.frame<boolean>(`__said.includes("mark")`)).toBe(true);
    return ed.frame<string[]>(`__said.slice(0, __said.indexOf("mark"))`);
  };
  /** The page's editor runs. */
  const runs = () => ed.frame<boolean>(`${F}.documentElement.hasAttribute("data-erga-editing")`);
  const shell = (cls: string) => ed.eval<boolean>(`document.body.classList.contains(${JSON.stringify(cls)})`);
  const toast = () => ed.page.evaluate(() => document.getElementById("toast")?.textContent ?? "");

  test("the host refuses the edit key: an alert says so, the shell asks again, the editor starts and the alert goes", async ({ tab }) => {
    let refuse = true;
    await tab.page.route("**/api/key*", (r) => (refuse ? r.fulfill({ status: 500, body: "no" }) : r.continue()));
    const opening = openEditor(tab, s, "deck", { allowErrors: true });
    opening.catch(() => {});
    await soon(() => tab.page.evaluate(() => document.querySelector("#alerts .alert-title")?.textContent ?? ""), 8000).toBe(
      "The editor can't start"
    );
    refuse = false;
    ed = await opening;
    expect(await runs()).toBe(true);
    await soon(toast).toContain("The editor started");
    expect((await ed.alerts()).view).toBe("none");
    // (The refused key, as the browser reports it: on purpose.) From here on, an error on the page fails its step.
    tab.errors.splice(0, tab.errors.length, ...tab.errors.filter((e) => !/status of 500/.test(e)));
    tab.strict = true;
  });

  test("⌘⇧P, then full screen: the page's editor stays stopped, and the arrows step the deck; out of full screen it runs again", async () => {
    await ed.press("ControlOrMeta+Shift+p");
    await soon(() => shell("source")).toBe(true);
    await watch();
    await ed.page.locator("#btn-full").click();
    await soon(() => ed.eval<boolean>(`document.documentElement.classList.contains("erga-full")`)).toBe(true);
    await soon(() => shell("source")).toBe(false);
    expect(await said()).not.toContain("edit");
    await soon(runs).toBe(false);
    await ed.press("ArrowRight");
    await soon(() => ed.eval<string>(`location.hash`)).toBe("#2");
    await ed.page.evaluate(() => document.exitFullscreen());
    await soon(runs).toBe(true);
    expect(await said()).toEqual(["edit"]);
  });

  test("at slide 3, a reload of the tab opens the editor at slide 3; the tab's address says #3", async ({ tab }) => {
    // Escape: the keys go to the page, and its arrows move between slides.
    await ed.press("Escape");
    await ed.press("ArrowRight");
    await ed.shows(THIRD);
    await soon(() => ed.eval<string>(`location.hash`)).toBe("#3");
    await tab.page.reload();
    await ed.loaded();
    await ed.shows(THIRD);
    expect(await ed.eval<string>(`location.hash`)).toBe("#3");
    expect(await ed.eval<string>(`location.search`)).toBe("?edit");
  });

  test("the editor's own reload of the page keeps slide 3, and the caret where it was", async () => {
    await ed.clickEnd(".current h1");
    await ed.shows(`
      # Third slide|

      The last one.
    `);
    await ed.frame(`window.__before = true`);
    // The page made afresh, as for a change the editor can't patch in: it loads again, in a new window.
    await ed.frame(`ergaFrame.page.render()`);
    await soon(() => ed.frame<boolean>(`!window.__before`)).toBe(true);
    await ed.idle();
    await ed.shows(`
      # Third slide|

      The last one.
    `);
    expect(await ed.eval<string>(`location.hash`)).toBe("#3");
  });

  test("a slides page fills the window: its frame stays below the bars, with no room added", async ({ tab }) => {
    const slides = await openEditor(tab, s, "slides");
    await soon(() => slides.eval<boolean>(`document.documentElement.classList.contains("erga-fills")`)).toBe(true);
    // (The frame moves below the bars as the page says that it fills the window.)
    await soon(async () => {
      const b = await bars(tab.page);
      return { below: b.frame >= b.bottom, toTheEnd: b.height == (await slides.eval<number>(`innerHeight`)) - b.frame };
    }).toEqual({ below: true, toTheEnd: true });
    expect(await slides.frame<string>(`getComputedStyle(${F}.documentElement).paddingTop`)).toBe("0px");
  });
});
