// Two people on one document at the same time: each sees all that the other types, with the other's caret, the text
// is stored one time, and ⌘Z takes back only one's own text. One journey on two pages (Ada's and Bo's, on a long page),
// with a third person who has no browser: typing at once, a list that arrives above the line you type in, a
// paragraph that the other person joins or indents under your caret, and who is here on a phone. Then two tests with
// no page: random edits from four people, and people who join in the middle of a burst.
import { expect, journey, servers, test, until } from "../helpers/fixtures";
import { DISK_MS, F, W, openEditor, type Editor } from "../helpers/editor";
import { converged, crowd, peerCaretIn, peerNames, random, roomOf, secondPage, SEED, type Person, type Room } from "./room";

const s = await servers.main();

/** Waits until both pages show `text` in the element. */
const bothShow = (a: Editor, b: Editor, selector: string, text: string) =>
  until(
    async () => (await a.textOf(selector)) == text && (await b.textOf(selector)) == text,
    5000,
    `both pages show "${text.slice(-30)}" in ${selector}`,
    async () => [await a.textOf(selector), await b.textOf(selector)]
  );

/** Puts the caret at the end of a paragraph of several lines: a click in its last line, then End. */
async function caretAtEnd(ed: Editor, selector: string) {
  await ed.rectOf(selector);
  const last = await ed.charAt(selector, (await ed.frame<number>(`${F}.querySelector(${JSON.stringify(selector)}).firstChild.length`)) - 1);
  await ed.click(last.x, last.y);
  await ed.press("End");
}

/** Waits until the two pages hold the same source, and `ok` holds for it; returns it. */
const agree = (a: Editor, b: Editor, ok: (source: string) => boolean, what: string, show?: RegExp) =>
  until(
    async () => {
      const t = await a.source();
      return ok(t) && t == (await b.source()) ? t : null;
    },
    5000,
    what,
    async () => (show ? [(await a.source()).match(show)?.[0], (await b.source()).match(show)?.[0]] : null)
  ) as Promise<string>;

const LONG = " This sentence makes the paragraph much longer, so that it wraps onto more lines than it did.".repeat(4);

/** The top of the first text block whose text starts with `text`, as an expression for the page (null: no such block). */
const blockTop = (text: string) =>
  `([...${F}.querySelectorAll("[data-erga-text]")].find((e) => e.textContent.startsWith(${JSON.stringify(text)}))?.getBoundingClientRect().top ?? null)`;
/** The top of a word in the text of the element with this id, as an expression for the page (null: not there). */
const wordTop = (id: string, word: string) =>
  `(() => { const t = [...(${F}.getElementById(${JSON.stringify(id)})?.childNodes ?? [])].find((n) => n.nodeType == 3 && n.nodeValue.includes(${JSON.stringify(word)})); if (!t) return null; const r = ${F}.createRange(), i = t.nodeValue.indexOf(${JSON.stringify(word)}); r.setStart(t, i); r.setEnd(t, i + ${word.length}); return r.getBoundingClientRect().top; })()`;

/**
 * From now on notes, at each frame, where a thing on the page is (`at`: its top, as an expression for the page).
 * Answers a reading: how far it moved at most, in pixels, in how many frames it was not there, and whether the page
 * loaded again (then: how far it is from where it was).
 */
async function watchView(ed: Editor, at: string) {
  await ed.settle();
  const top = (await ed.frame<number>(at))!;
  await ed.frame(
    `(() => { ${W}.__marker = 1; const out = window.__tops = []; const tick = () => { out.push(${at}); if (window.__tops == out) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`
  );
  return async () => {
    await ed.settle();
    const reloaded = !(await ed.frame<boolean>(`${W}.__marker == 1`));
    const tops = reloaded ? [await ed.frame<number | null>(at)] : await ed.frame<(number | null)[]>(`window.__tops`);
    const seen = tops.filter((t): t is number => t != null);
    return { worst: Math.round(Math.max(0, ...seen.map((t) => Math.abs(t - top)))), missing: tops.length - seen.length, reloaded };
  };
}

/** The reading of a view that stayed: what it watched moved a pixel at most and was there in every frame; `reloaded`: the page loaded again or not. */
function still(r: { worst: number; missing: number; reloaded: boolean }, reloaded: boolean) {
  expect(r.worst, JSON.stringify(r)).toBeLessThanOrEqual(1);
  expect([r.missing, r.reloaded], JSON.stringify(r)).toEqual([0, reloaded]);
}

/** Sends a scripted turn to the agent, from the agent pane: it plays `steps`. Answers `done`, a promise of the turn's end. */
async function agentTurn(ed: Editor, steps: unknown[]) {
  const replies = () => ed.eval<number>(`document.querySelectorAll(".msg-assistant").length`);
  const before = await replies();
  await ed.eval(
    `(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify(`Edit @script ${JSON.stringify(steps)}`)}; i.dispatchEvent(new Event("input")); i.focus(); })()`
  );
  await ed.page.keyboard.press("Enter");
  return {
    done: until(
      async () =>
        (await replies()) > before && !(await ed.eval<boolean>(`document.getElementById("agent-send").classList.contains("stop")`)),
      10_000,
      "the agent's turn ends"
    ),
  };
}

type Box = { l: number; r: number; t: number; b: number };
type Stack = { bar: Box; stack: Box | null; faces: { name: string; box: Box; shown: boolean }[]; more: string | null; inBar: boolean };

/** Who else is here, at the top of the tab: the buttons' bar, the stack of faces, each face, its "+N", and whether a face is in the bar. */
const stackOf = (ed: Editor) =>
  ed.page.evaluate(() => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) };
    };
    const bar = document.querySelector(".chrome-top")!,
      stack = document.getElementById("people")!;
    const shown = (el: Element) => {
      const s = getComputedStyle(el);
      return s.visibility != "hidden" && Number(s.opacity) > 0.5 && el.getBoundingClientRect().width > 0;
    };
    const faces = [...stack.querySelectorAll<HTMLElement>(".avatar")].map((a) => ({
      name: a.dataset.name ?? "",
      box: box(a),
      shown: shown(a),
    }));
    const more = stack.querySelector(".more");
    const b = box(bar);
    const inBar = faces.some((f) => f.shown && f.box.l >= b.l && f.box.r <= b.r);
    return { bar: b, stack: faces.length ? box(stack) : null, faces, more: more && shown(more) ? more.textContent : null, inBar } as Stack;
  });

/** The stack once it has `n` faces and they are at rest (they slide). */
async function atRest(ed: Editor, n: number): Promise<Stack> {
  let last = "";
  return until(
    async () => {
      const st = await stackOf(ed);
      const key = JSON.stringify(st);
      const done = st.faces.length == n && key == last;
      last = key;
      return done ? st : null;
    },
    5000,
    `the stack has ${n} faces, at rest`,
    () => stackOf(ed)
  ) as Promise<Stack>;
}

/** The start of the paragraph that the reader's window starts with (#p20). */
const HEAT = blockTop("Heat came up and the light went flat");

journey("two people on one page", () => {
  let a: Editor, b: Editor, room: Room, cy: Person;
  const THREE = ["Di", "Ed", "Flo"],
    three: Person[] = [];
  const people = crowd();
  test.afterAll(() => people.leave());

  test("each sees the other at the top, and the other's typing and caret, with no reload and no mark on the typed text", async ({
    tab,
  }) => {
    await tab.page.setViewportSize({ width: 1280, height: 800 });
    a = await openEditor(tab, s, "long", { query: "?user=Ada" });
    b = await secondPage(tab, a, "Bo");
    room = roomOf(a.address);
    const tips = (t: Editor) => t.eval<string[]>(`[...document.querySelectorAll(":is(#me, #people) .avatar")].map((e) => e.dataset.tip)`);
    await until(
      async () => (await tips(a)).some((t) => t.startsWith("Bo")) && (await tips(b)).some((t) => t.startsWith("Ada")),
      5000,
      "each sees the other at the top",
      async () => [await tips(a), await tips(b)]
    );
    await b.frame(`${W}.__marker = 1`);
    await b.watchMarks();
    await a.clickEnd("h1");
    await a.type(" (draft)");
    await bothShow(a, b, "h1", "Long notes (draft)");
    expect(await b.frame<boolean>(`${W}.__marker == 1`), "Bo's page did not load again").toBe(true);
    await until(
      async () => (await peerNames(b)) == "Ada" && (await peerCaretIn(b, "h1")),
      5000,
      "Ada's caret shows on Bo's page, in the heading",
      () => peerNames(b)
    );
    // Pete: "I just want to see the cursor adding the letters." No highlight and no element marks her text.
    expect(await b.seenMarks()).toEqual([]);
  });

  test("the source view follows the other person's typing and shows their caret; back on the page, the caret is drawn again", async () => {
    const sourceOpen = () => b.eval<boolean>(`document.body.classList.contains("source")`);
    await b.press("ControlOrMeta+Shift+p");
    await until(sourceOpen, 5000, "Bo's source view opens");
    await a.type("!");
    await until(
      async () => (await b.eval<string>(`document.querySelector("#source .cm-content").textContent`)).includes("Long notes (draft)!"),
      5000,
      "Bo's source view has Ada's typing"
    );
    await until(
      async () =>
        (await b.eval<string>(`[...document.querySelectorAll("#source .cm-peer-name")].map((e) => e.textContent).join("|")`)) == "Ada",
      5000,
      "and her caret"
    );
    await b.press("ControlOrMeta+Shift+p");
    await until(
      async () => !(await sourceOpen()) && (await peerNames(b)) == "Ada" && (await peerCaretIn(b, "h1")),
      5000,
      "back on the page, her caret is drawn again"
    );
    await b.settle();
  });

  test("both type at once in nearby paragraphs, with Enter: both pages show all the text", async () => {
    await caretAtEnd(a, "#p0");
    await caretAtEnd(b, "#p1");
    await Promise.all([a.type("123\n456"), b.type("abc\ndef")]);
    await agree(
      a,
      b,
      (t) => /<p id="p0">[^<]*\.123<\/p>\s*<p>456<\/p>\s*<p id="p1">[^<]*\.abc<\/p>\s*<p>def<\/p>/.test(t),
      "the pages agree, with all the text in its order",
      /<p id="p0">[\s\S]*?<p id="p2">/
    );
    for (const p of [a, b])
      expect(
        await p.frame<string[]>(`["#p0", "#p0 + p", "#p1", "#p1 + p"].map((q) => ${F}.querySelector(q).textContent.slice(-3))`)
      ).toEqual(["123", "456", "abc", "def"]);
  });

  test("typing in turns ends the same for both and is stored one time; ⌘Z takes back only your own text", async () => {
    await caretAtEnd(a, "#p3");
    await caretAtEnd(b, "#p4");
    for (const [x, y] of [
      ["1", "4"],
      ["2", "5"],
      ["3", "6"],
    ]) {
      await a.type(x);
      await b.type(y);
    }
    const hers = (t: string) => /<p id="p3">[^<]*\.123<\/p>/.test(t),
      his = (t: string) => /<p id="p4">[^<]*\.456<\/p>/.test(t);
    const text = await agree(a, b, (t) => hers(t) && his(t), "the pages agree, with both people's typing");
    await until(
      async () => (await room.stored())?.text == text && a.disk() == text,
      5000,
      "storage and the file on disk have it, one time"
    );
    await b.press("ControlOrMeta+z");
    await agree(a, b, (t) => hers(t) && !his(t), "Bo's ⌘Z takes his typing back for Ada too, and hers stays");
  });

  test("while you type in a paragraph, a list from a third person arrives above it: the view and the caret stay, and your typing goes on", async () => {
    cy = await people.join(room, "Cy");
    await caretAtEnd(a, "#p21");
    await a.type(" Mine");
    await until(() => cy.str().includes(" Mine</p>"), 3000, "Ada's typing reaches the third person");
    // The paragraph before it at the top of the window, the page scrolled.
    await a.frame(`(() => { ${F}.getElementById("p20").scrollIntoView({ block: "start" }); ${W}.scrollBy(0, -40); })()`);
    expect(await a.frame<number>(`${W}.scrollY`), "the page is scrolled").toBeGreaterThan(500);
    const reading = await watchView(a, HEAT);
    cy.insertBefore(`<h2 id="s1">`, `<ul id="added"><li>One</li><li>Two</li></ul>\n    `);
    await until(async () => (await a.count("#added li")) == 2 && (await b.count("#added li")) == 2, 5000, "the list shows on both pages");
    await a.type(" and more");
    await a.idle();
    expect(await a.textOf("#p21")).toMatch(/ Mine and more$/);
    expect(await a.source()).toContain(" Mine and more</p>");
    still(await reading(), false);
  });

  test("edits on disk above and below the view, to the text, the structure and the styles: the view does not move, and the page does not load again", async () => {
    const reading = await watchView(a, HEAT);
    const edit = async (f: (text: string) => string, shows: string) => {
      // The file has the room's text first: a file written from older text takes the newer text back.
      await until(async () => a.disk() == (await a.source()), 5000, "the file on disk has the room's text");
      const next = f(a.disk());
      expect(next).not.toBe(a.disk());
      a.write(next);
      await until(() => a.frame<boolean>(shows), DISK_MS, shows);
    };
    await edit(
      (t) => t.replace(/(<p id="p5">[^<]*)\./, `$1.${LONG}`),
      `${F}.getElementById("p5").textContent.includes("wraps onto more lines")`
    );
    await edit(
      (t) => t.replace(`<h2 id="s2">`, `<ol id="steps"><li>First</li><li>Second</li></ol>\n    <h2 id="s2">`),
      `${F}.querySelectorAll("#steps li").length == 2`
    );
    await edit(
      (t) =>
        t.replace(
          `<h2 id="s0">`,
          `<svg id="chart" width="80" height="120"><rect width="80" height="120" fill="#c00"/></svg>\n    <h2 id="s0">`
        ),
      `${F}.getElementById("chart")?.getBoundingClientRect().height == 120`
    );
    await edit(
      (t) => t.replace("padding: 8px 12px;", "padding: 40px 12px;"),
      `getComputedStyle(${F}.querySelector(".note")).paddingTop == "40px"`
    );
    await edit(
      (t) => t.replace(/(<p id="p40">[^<]*)\./, `$1.${LONG}`),
      `${F}.getElementById("p40").textContent.includes("wraps onto more lines")`
    );
    still(await reading(), false);
    // The new blocks are the editor's like any other, on the other person's page too.
    expect(await a.frame<boolean[]>(`[...${F}.querySelectorAll("#added li, #steps li")].map((e) => e.isContentEditable)`)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(await a.count(".erga-locked")).toBe(0);
    await until(async () => (await b.count("#steps li")) == 2 && (await b.count("#chart")) == 1, 5000, "the other page has the edits");
  });

  // Was a bug: after the other tab's indent, the page rendered the list again and the keys typed next were lost.
  test("the other person indents the list item you type in: your keys stay in it", async () => {
    await a.clickEnd("#added li:nth-child(2)");
    await b.clickEnd("#added li:nth-child(2)");
    await b.type("ab");
    await a.press("Tab");
    await until(
      async () => (await a.count("#added li li")) == 1 && (await b.count("#added li li")) == 1,
      5000,
      "both pages show the item nested"
    );
    await b.type("cd");
    await bothShow(a, b, "#added li li", "Twoabcd");
  });

  // Was a bug: after the other tab joined the paragraph to the one above, the keys typed next were lost.
  test("the other person joins your paragraph to the one above: your next keys are kept", async () => {
    const [one, two] = [await a.textOf("#p29"), await a.textOf("#p30")];
    await a.rectOf("#p30");
    const start = await a.charAt("#p30", 0);
    await a.click(start.x, start.y);
    await caretAtEnd(b, "#p30");
    await a.press("Backspace");
    await bothShow(a, b, "#p29", one + two);
    await b.type("xyz");
    await bothShow(a, b, "#p29", `${one}${two}xyz`);
  });

  test("the others stack left of the buttons' bar, not in it; a hover spreads them, and a hover on one shows its name", async () => {
    const rest = await atRest(a, 2);
    expect(rest.inBar, "no face is in the buttons' bar").toBe(false);
    // Just left of the bar, in its band: the stack's right edge 4 to 14px from the bar, centred on it.
    expect(rest.stack!.r).toBeLessThanOrEqual(rest.bar.l - 4);
    expect(rest.stack!.r).toBeGreaterThanOrEqual(rest.bar.l - 14);
    expect(Math.abs((rest.stack!.t + rest.stack!.b) / 2 - (rest.bar.t + rest.bar.b) / 2)).toBeLessThanOrEqual(1);
    // They overlap.
    const [f1, f2] = rest.faces;
    expect(f1.box.r).toBeGreaterThan(f2.box.l);
    // A hover on the stack: they part, each face whole, still left of the bar.
    await a.page.mouse.move((f2.box.l + f2.box.r) / 2, (f2.box.t + f2.box.b) / 2);
    const spread = (await until(
      async () => {
        const st = await stackOf(a);
        return st.faces[0].box.r <= st.faces[1].box.l && st.faces[1].box.r <= st.bar.l ? st : null;
      },
      3000,
      "the faces part",
      () => stackOf(a)
    ))!;
    expect(spread.inBar).toBe(false);
    // A hover on one face: its name, in a label of its colour, under it.
    const one = spread.faces[0];
    await a.page.mouse.move((one.box.l + one.box.r) / 2, (one.box.t + one.box.b) / 2);
    const tip = (await until(
      () =>
        a.page.evaluate((name) => {
          const av = [...document.querySelectorAll<HTMLElement>("#people .avatar")].find((x) => x.dataset.name == name)!;
          const label = getComputedStyle(av, "::before");
          const d = document.createElement("div");
          d.style.color = getComputedStyle(av).getPropertyValue("--c").trim();
          document.body.append(d);
          const own = getComputedStyle(d).color;
          d.remove();
          return Number(label.opacity) == 1 ? { text: label.content, color: label.backgroundColor, own } : null;
        }, one.name),
      3000,
      "the name shows"
    ))!;
    expect(["Bo", "Cy"]).toContain(one.name);
    expect(tip.text).toBe(`"${one.name}"`);
    expect(tip.color).toBe(tip.own);
    // The pointer away: they stack again.
    await a.page.mouse.move(600, 400);
    await until(
      async () => {
        const st = await stackOf(a);
        return st.faces[0].box.r > st.faces[1].box.l;
      },
      3000,
      "they stack again"
    );
  });

  // Was a bug: on a phone at 320px, the faces of the others lay over the breadcrumbs.
  test('phone at 320px, five others: two faces and "+3", 10px from the bar; the breadcrumbs end before them, the logo whole', async () => {
    for (const name of THREE) three.push(await people.join(room, name));
    await until(
      () => THREE.every((n) => cy.others().includes(n)),
      3000,
      "the third person sees the three",
      () => cy.others()
    );
    await a.page.setViewportSize({ width: 320, height: 760 });
    await a.page.mouse.move(200, 600);
    const rest = await atRest(a, 5);
    const crumbs = await a.page.evaluate(() => {
      const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      return { nav: r("nav-docs"), brand: r("nav-brand"), title: r("doc-title") };
    });
    expect(rest.faces.filter((f) => f.shown).length).toBe(2);
    expect(rest.more).toBe("+3");
    expect(rest.inBar).toBe(false);
    // (Boxes are in whole pixels: 10px is 9 to 11.)
    expect(Math.abs(rest.bar.l - rest.stack!.r - 10)).toBeLessThanOrEqual(1);
    expect(rest.stack!.l - Math.round(crumbs.nav.right)).toBeGreaterThanOrEqual(9);
    // Erga's logo whole, in the breadcrumbs' bar, and the title in sight.
    expect(crumbs.brand.left).toBeGreaterThanOrEqual(crumbs.nav.left);
    expect(crumbs.title.right).toBeLessThanOrEqual(crumbs.nav.right);
    expect(crumbs.title.width).toBeGreaterThan(30);
  });

  test("three people leave: they are gone at once, for the people and on the page; on a phone a tap spreads the two faces left", async () => {
    for (const p of three) p.leave();
    await until(
      () => !cy.others().some((n) => THREE.includes(n)),
      3000,
      "the three are gone for the third person",
      () => cy.others()
    );
    expect(cy.others()).toEqual(expect.arrayContaining(["Ada", "Bo"]));
    await a.page.setViewportSize({ width: 375, height: 760 });
    const rest = await atRest(a, 2);
    expect(rest.faces.map((f) => [f.name, f.shown]).sort()).toEqual([
      ["Bo", true],
      ["Cy", true],
    ]);
    expect(rest.inBar).toBe(false);
    expect(rest.stack!.r).toBeLessThanOrEqual(rest.bar.l - 4);
    // The breadcrumbs end before the stack.
    expect(await a.page.evaluate(() => document.getElementById("nav-docs")!.getBoundingClientRect().right)).toBeLessThanOrEqual(
      rest.stack!.l
    );
    // A tap on the stack spreads it, and opens no quick actions. (A finger: no hover; the tap is the browser's own touch.)
    const cdp = await a.page.context().newCDPSession(a.page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const tap = async (x: number, y: number) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const apart = async () => {
      const st = await stackOf(a);
      return st.faces[0].box.r <= st.faces[1].box.l;
    };
    const f = rest.faces[1];
    await tap((f.box.l + f.box.r) / 2, (f.box.t + f.box.b) / 2);
    await until(apart, 3000, "the tap spreads the stack", () => stackOf(a));
    expect(
      await a.page.evaluate(() => [
        document.getElementById("people")!.classList.contains("spread"),
        document.body.classList.contains("quick-open"),
      ])
    ).toEqual([true, false]);
    // A tap on the page stacks them again.
    await tap(200, 500);
    await until(
      async () => !(await apart()),
      3000,
      "a tap elsewhere stacks them again",
      () => stackOf(a)
    );
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.detach();
  });

  test("the agent edits the first sentence of a long paragraph that starts above the window: the line you read stays", async () => {
    await a.page.setViewportSize({ width: 1280, height: 800 });
    const sentences = Array.from({ length: 80 }, (_, i) =>
      i == 50 ? "Here is the word zebra, in the middle." : `Sentence ${i + 1} of the long paragraph.`
    );
    cy.insertBefore(`<h2 id="s3">`, `<p id="long">${sentences.join(" ")}</p>\n    `);
    await until(async () => (await a.count("#long")) == 1, 5000, "the long paragraph shows");
    await a.openAgent();
    // The word "zebra" 300 px down the window, the start of its paragraph far above it.
    const word = wordTop("long", "zebra");
    await a.frame(`${W}.scrollBy(0, ${word} - 300)`);
    const reading = await watchView(a, word);
    expect(
      await a.frame<number>(`${F}.getElementById("long").getBoundingClientRect().top`),
      "the paragraph starts above the window"
    ).toBeLessThan(-300);
    // Its first sentence, far above the window, becomes several lines longer.
    const turn = await agentTurn(a, [
      {
        tool: "edit",
        args: {
          path: "index.html",
          edits: [{ oldText: "Sentence 1 of the long paragraph.", newText: `The agent rewrote this first sentence.${LONG}` }],
        },
      },
      { text: "Done." },
    ]);
    await turn.done;
    await until(() => a.frame<boolean>(`${F}.getElementById("long").textContent.startsWith("The agent rewrote")`), 5000, "the edit shows");
    still(await reading(), false);
  });

  test("the agent edits above the view as it works: each edit shows at once and the view stays; its change to a script waits for the end of its turn, then the page loads again at the same line", async () => {
    const edit = (oldText: string, newText: string, delay = 0) => ({
      tool: "edit",
      args: { path: "index.html", edits: [{ oldText, newText }] },
      delay,
    });
    const reading = await watchView(a, wordTop("long", "zebra"));
    const turn = await agentTurn(a, [
      edit(`<h2 id="s1">`, `<ul id="agent-list"><li>One</li><li>Two</li></ul>\n    <h2 id="s1">`),
      edit(`<h2 id="s2">Section 3</h2>`, `<h2 id="s2">Section 3, renamed</h2>\n    <p>A paragraph the agent added.</p>`, 100),
      edit("let n = 0;", `let n = 0; document.getElementById("count").textContent = "ran";`, 100),
      { text: "Done.", delay: 1500 },
    ]);
    // Text and structure show while it works, and the page does not load again.
    await until(
      () => a.frame<boolean>(`!!${F}.getElementById("agent-list") && ${F}.getElementById("s2").textContent.endsWith("renamed")`),
      5000,
      "the agent's edits show as it makes them"
    );
    expect(await a.frame<boolean>(`${W}.__marker == 1`), "the page did not load again").toBe(true);
    // The change to the script waits for the end of the turn.
    const pill = () => a.controls<boolean>(`!C.getElementById("refresh-pill").hidden`);
    await until(pill, 5000, "the pill says that a change waits for the agent");
    expect(await a.frame<string>(`${F}.getElementById("count").textContent`)).toBe("0");
    await until(
      () => a.frame<boolean>(`${F}.getElementById("count")?.textContent == "ran"`),
      10_000,
      "the page loads again when the agent finishes, and the new script runs"
    );
    still(await reading(), true);
    await turn.done;
    await until(async () => (await pill()) === false, 3000, "the pill is gone");
    expect(await a.eval<number>(`document.querySelectorAll("iframe").length`), "one page frame").toBe(1);
    expect(await a.frame<boolean>(`!!${F}.querySelector("style[data-erga-caret]")`), "the new page draws your caret too").toBe(true);
    people.leave();
    await b.page.close();
  });
});

// ---- With no page: many people at once.

const TOKEN = /⟦[a-z0-9.]+⟧/g;

/** The places where a token may go: not inside another token. */
function slots(text: string): number[] {
  const inside = new Set<number>();
  for (const m of text.matchAll(TOKEN)) for (let i = m.index! + 1; i < m.index! + m[0].length; i++) inside.add(i);
  const out: number[] = [];
  for (let i = 0; i <= text.length; i++) if (!inside.has(i)) out.push(i);
  return out;
}

/** Everyone back on the network: they hold one text, storage and the served page have it, and so does a newcomer. Returns it. */
async function settled(people: ReturnType<typeof crowd>, room: Room, ps: Person[]): Promise<string> {
  for (const p of ps) p.online();
  await until(() => ps.every((p) => p.synced), 10_000, "everyone is back");
  const text = await converged(ps, 10_000);
  await until(async () => (await room.stored())?.text == text, 10_000, "storage has the room's text");
  expect(await room.served()).toBe(text);
  expect((await people.join(room, "Late")).str()).toBe(text);
  return text;
}

test("random edits from four people, with spells off the network and publishes: nothing is lost, and nothing comes back", async () => {
  const people = crowd(),
    rng = random(SEED);
  try {
    const room = roomOf((await s.fixture("page")).address);
    const fixture = (await room.stored())!.text;
    const ps: Person[] = [];
    for (let i = 0; i < 4; i++) ps.push(await people.join(room, `P${i}`));
    const live = new Set<string>(); // the tokens that must be there at the end
    const owned = new Map<Person, string[]>(ps.map((p) => [p, []]));
    /** Publishes on their way: each reads the stored file now and pushes it, with one more token, some rounds later. */
    const publishes: { at: number; read: Promise<{ text: string; etag: string } | null>; token: string; pick: number }[] = [];
    const pushed: Promise<void>[] = [];
    let offline = 0,
      taken = 0,
      stale = 0;
    /**
     * The stored file as it was read, with one token more: taken, or refused as stale when the room stored since.
     * (Next to another token too: the room takes a publish as a difference of two texts, and the new token is whole
     * in it, with no bracket of its neighbour's. document/merge.ts, whole.)
     */
    const push = async (pub: (typeof publishes)[number]) => {
      const was = await pub.read;
      if (!was) return;
      const sl = slots(was.text),
        at = sl[Math.floor(pub.pick * sl.length)];
      const res = await room.push(was.text.slice(0, at) + pub.token + was.text.slice(at), was.etag);
      if (res.ok) {
        live.add(pub.token);
        taken++;
      } else {
        expect(res.status).toBe(412);
        stale++;
      }
    };
    for (let r = 0; r < 300; r++) {
      const p = rng.pick(ps),
        roll = rng();
      if (roll < 0.5) {
        const token = `⟦${p.name.toLowerCase()}.${r}⟧`;
        p.insert(rng.pick(slots(p.str())), token);
        live.add(token);
        owned.get(p)!.push(token);
        if (!p.connected) offline++;
        // Now and then, the edit gets to another person before the next one: edits cross on the network, and some do not.
        const q = rng.pick(ps);
        if (rng() < 0.3 && p.synced && q.synced) await q.has(token);
      } else if (roll < 0.7) {
        // One of this person's own tokens that they can see goes.
        const mine = owned.get(p)!.filter((t) => p.str().includes(t));
        if (mine.length) {
          const token = rng.pick(mine);
          p.delete(p.str().indexOf(token), token.length);
          live.delete(token);
          owned.get(p)!.splice(owned.get(p)!.indexOf(token), 1);
        }
      } else if (roll < 0.76 && p.connected) p.offline();
      else if (roll < 0.86 && !p.connected) {
        // Back on the network: one time in two the next edit waits for it, else the edits go on meanwhile.
        p.online();
        if (rng() < 0.5) await until(() => p.synced, 5000, `${p.name} is back`);
      } else if (roll < 0.9) {
        // A publish: one time in two at once (the room takes it, if it did not store meanwhile), else some rounds later (often stale).
        const pub = { at: r + rng.int(20), read: room.stored(), token: `⟦pub.${r}⟧`, pick: rng() };
        if (rng() < 0.5) await push(pub);
        else publishes.push(pub);
      }
      for (const pub of publishes.filter((x) => x.at <= r)) {
        publishes.splice(publishes.indexOf(pub), 1);
        pushed.push(push(pub));
      }
    }
    for (const pub of publishes) pushed.push(push(pub));
    await Promise.all(pushed);
    const text = await settled(people, room, ps);
    const found: string[] = text.match(TOKEN) ?? [];
    const why = `ERGA_SEED=${SEED} plays this run again (${live.size} tokens, ${offline} edits off the network, ${taken} publishes taken, ${stale} stale)`;
    expect(
      found.filter((t, i) => found.indexOf(t) != i),
      `no token is there two times. ${why}`
    ).toEqual([]);
    expect(
      [...live].filter((t) => !found.includes(t)),
      `no token is lost. ${why}`
    ).toEqual([]);
    expect(
      found.filter((t) => !live.has(t)),
      `no deleted token comes back. ${why}`
    ).toEqual([]);
    // Only tokens came and went: without them the text is the fixture, so nothing else is doubled or lost.
    expect(text.replace(TOKEN, ""), why).toBe(fixture);
  } finally {
    people.leave();
  }
});

test("people who join in the middle of a burst of edits catch up", async () => {
  const people = crowd(),
    rng = random(SEED);
  try {
    const room = roomOf((await s.fixture("page")).address);
    const ps: Person[] = [];
    for (let i = 0; i < 3; i++) ps.push(await people.join(room, `P${i}`));
    // 200 edits, in pairs from two people; a pair goes out when the pair before has reached the third person. At the
    // 40th, 80th, 120th and 160th edit, a person starts to join, and the edits go on.
    const late: Promise<Person>[] = [];
    for (let i = 0; i < 200; i++) {
      if (i && i % 40 == 0) late.push(people.join(room, `New${i}`));
      const p = ps[i % 3],
        token = `⟦b.${i}⟧`;
      p.insert(rng.pick(slots(p.str())), token);
      if (i % 2) await ps[(i + 1) % 3].has(token);
    }
    const text = await settled(people, room, [...ps, ...(await Promise.all(late))]);
    expect((text.match(TOKEN) ?? []).length, `ERGA_SEED=${SEED} plays this run again`).toBe(200);
  } finally {
    people.leave();
  }
});
