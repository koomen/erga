// Who else is here (Pete: "Other editors should appear stacked up to the left of the quick actions bar, not in it.
// Hovering over that stack should spread them out so that I can see their faces and names"): the others' avatars overlap
// in a stack just left of the buttons' bar, in the same band; a hover spreads them so each face shows whole, and a hover
// on one shows its name in that person's colour. Past four faces the stack ends in "+N", and the spread shows all.
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { editor, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

type Box = { l: number; r: number; t: number; b: number };
type Stack = { bar: Box; stack: Box | null; faces: { name: string; box: Box; shown: boolean }[]; more: string | null; inBar: boolean };

/** The buttons' bar, the stack, each face in it (its box, and whether it shows), its "+N", and whether any is in the bar. */
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
    // Inside the bar's glass: the box of a face is within the bar's.
    const b = box(bar);
    const inBar = faces.some((f) => f.shown && f.box.l >= b.l && f.box.r <= b.r);
    return { bar: b, stack: faces.length ? box(stack) : null, faces, more: more && shown(more) ? more.textContent : null, inBar } as Stack;
  });

/** Opens the document in another tab as `name`, in the editor. */
async function join(page: Page, a: Editor, name: string): Promise<Editor> {
  const other = await page.context().newPage();
  await other.setViewportSize(page.viewportSize()!);
  await other.goto(`${a.address}?user=${encodeURIComponent(name)}&edit`);
  const ed = editor(other, a);
  await ed.loaded();
  return ed;
}

/** Shares the document as its owner (the tester) with each, to edit. */
async function share(a: Editor, names: string[]) {
  const id = ((await (await fetch(`${a.address}/api/doc`)).json()) as { docName: { id: string } }).docName.id;
  for (const name of names) {
    const status = await a.page.evaluate(
      ([id, login]) =>
        fetch("/api/tools/share_document", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document: id, login, role: "editor" }),
        }).then((r) => r.status),
      [id, name.toLowerCase()] as const
    );
    expect(status).toBe(200);
  }
}

/** The stack once it has `n` faces, the bar and the faces where they end (they slide). */
async function settled(a: Editor, n: number): Promise<Stack> {
  let last = "";
  return until(
    async () => {
      const s = await stackOf(a);
      const key = JSON.stringify(s);
      const done = s.faces.length == n && key == last;
      last = key;
      return done ? s : null;
    },
    15_000,
    `the stack has ${n} faces, at rest`,
    () => stackOf(a)
  ) as Promise<Stack>;
}

test("desktop: the others stack left of the buttons' bar, not in it; a hover spreads them, and a hover on one shows its name", async ({
  tab,
}) => {
  await tab.page.setViewportSize({ width: 1200, height: 760 });
  const a = await openEditor(tab, await servers.main(), "empty");
  await share(a, ["Ada", "Bo"]);
  await join(tab.page, a, "Ada");
  await join(tab.page, a, "Bo");
  const rest = await settled(a, 2);
  expect(rest.inBar, "no face is in the buttons' bar").toBe(false);
  // Just left of the bar, in its band: the stack's right edge 4-14px from the bar, centred on it.
  expect(rest.stack!.r).toBeLessThanOrEqual(rest.bar.l - 4);
  expect(rest.stack!.r).toBeGreaterThanOrEqual(rest.bar.l - 14);
  expect(Math.abs((rest.stack!.t + rest.stack!.b) / 2 - (rest.bar.t + rest.bar.b) / 2)).toBeLessThanOrEqual(1);
  // They overlap.
  const [f1, f2] = rest.faces;
  expect(f1.box.r).toBeGreaterThan(f2.box.l);

  // A hover on the stack: they part, each face whole, still left of the bar.
  await a.page.mouse.move((f2.box.l + f2.box.r) / 2, (f2.box.t + f2.box.b) / 2);
  const spread = await until(
    async () => {
      const s = await stackOf(a);
      return s.faces[0].box.r <= s.faces[1].box.l && s.faces[1].box.r <= s.bar.l ? s : null;
    },
    3000,
    "the faces part",
    () => stackOf(a)
  );
  expect(spread!.inBar).toBe(false);

  // A hover on one face: its name, in a label of its colour, under it.
  const one = spread!.faces[0];
  await a.page.mouse.move((one.box.l + one.box.r) / 2, (one.box.t + one.box.b) / 2);
  const tip = await until(
    () =>
      a.page.evaluate((name) => {
        const av = [...document.querySelectorAll<HTMLElement>("#people .avatar")].find((x) => x.dataset.name == name)!;
        const s = getComputedStyle(av, "::before");
        return Number(s.opacity) == 1
          ? { text: s.content, color: s.backgroundColor, c: getComputedStyle(av).getPropertyValue("--c").trim() }
          : null;
      }, one.name),
    3000,
    "the name shows"
  );
  expect(tip!.text).toBe(`"${one.name}"`);
  expect(["Ada", "Bo"]).toContain(one.name);
  const rgb = (c: string) =>
    a.page.evaluate((c) => {
      const d = document.createElement("div");
      d.style.color = c;
      document.body.append(d);
      const v = getComputedStyle(d).color;
      d.remove();
      return v;
    }, c);
  expect(tip!.color).toBe(await rgb(tip!.c));

  // The pointer away: they stack again.
  await a.page.mouse.move(600, 400);
  await until(
    async () => {
      const s = await stackOf(a);
      return s.faces[0].box.r > s.faces[1].box.l;
    },
    3000,
    "they stack again"
  );
});

test("desktop: past four faces the stack ends in +N; the spread shows them all", async ({ tab }) => {
  await tab.page.setViewportSize({ width: 1200, height: 760 });
  const a = await openEditor(tab, await servers.main(), "empty");
  const names = ["Ada", "Bo", "Cy", "Di", "Ed", "Flo"];
  await share(a, names);
  for (const n of names) await join(tab.page, a, n);
  const rest = await settled(a, 6);
  expect(rest.faces.filter((f) => f.shown).length).toBe(4);
  expect(rest.more).toBe("+2");
  expect(rest.inBar).toBe(false);
  expect(rest.stack!.r).toBeLessThanOrEqual(rest.bar.l - 4);
  const f = rest.faces.find((f) => f.shown)!;
  await a.page.mouse.move((f.box.l + f.box.r) / 2, (f.box.t + f.box.b) / 2);
  await until(
    async () => {
      const s = await stackOf(a);
      return s.faces.every((f) => f.shown) && !s.more && s.faces.every((f, i) => i == 0 || s.faces[i - 1].box.r <= f.box.l) ? s : null;
    },
    3000,
    "the spread shows all six, apart",
    () => stackOf(a)
  );
});

/** On a phone, five others: the breadcrumbs and the stack, at rest. */
async function phoneBand(a: Editor) {
  const rest = await settled(a, 5);
  const crumbs = await a.page.evaluate(() => {
    const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    return { nav: r("nav-docs"), brand: r("nav-brand"), title: r("doc-title") };
  });
  return { rest, crumbs };
}

for (const width of [375, 320])
  test(`phone at ${width}px: two faces and "+3", 10px from the bar; the breadcrumbs end 10px before them, the logo whole`, async ({
    tab,
  }) => {
    await tab.page.setViewportSize({ width, height: 760 });
    const a = await openEditor(tab, await servers.main(), "empty");
    const names = ["Ada", "Bo", "Cy", "Di", "Ed"];
    await share(a, names);
    for (const n of names) await join(tab.page, a, n);
    await a.page.mouse.move(200, 600);
    const { rest, crumbs } = await phoneBand(a);
    expect(rest.faces.filter((f) => f.shown).length).toBe(2);
    expect(rest.more).toBe("+3");
    expect(rest.inBar).toBe(false);
    // (Boxes rounded to whole pixels: 10px is 9 to 11.)
    expect(Math.abs(rest.bar.l - rest.stack!.r - 10)).toBeLessThanOrEqual(1);
    expect(rest.stack!.l - Math.round(crumbs.nav.right)).toBeGreaterThanOrEqual(9);
    // Erga's logo whole, in the breadcrumbs' bar, and the title in sight.
    expect(crumbs.brand.left).toBeGreaterThanOrEqual(crumbs.nav.left);
    expect(crumbs.title.right).toBeLessThanOrEqual(crumbs.nav.right);
    expect(crumbs.title.width).toBeGreaterThan(30);
  });

test("phone: the stack sits left of your avatar, clear of the breadcrumbs; a tap spreads it", async ({ tab }) => {
  await tab.page.setViewportSize({ width: 375, height: 760 });
  const a = await openEditor(tab, await servers.main(), "empty");
  await share(a, ["Ada", "Bo"]);
  await join(tab.page, a, "Ada");
  await join(tab.page, a, "Bo");
  const rest = await settled(a, 2);
  expect(rest.faces.every((f) => f.shown)).toBe(true);
  expect(rest.inBar).toBe(false);
  expect(rest.stack!.r).toBeLessThanOrEqual(rest.bar.l - 4);
  // The breadcrumbs end before the stack.
  const nav = await a.page.evaluate(() => document.getElementById("nav-docs")!.getBoundingClientRect().right);
  expect(nav).toBeLessThanOrEqual(rest.stack!.l);
  // A tap on the stack spreads it, and opens no quick actions.
  const f = rest.faces[1];
  // (A finger: no hover. The mouse is away, and the tap is the browser's own touch.)
  await a.page.mouse.move(200, 600);
  const cdp = await a.page.context().newCDPSession(a.page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const tap = async (x: number, y: number) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await tap((f.box.l + f.box.r) / 2, (f.box.t + f.box.b) / 2);
  await until(
    async () => {
      const s = await stackOf(a);
      return s.faces[0].box.r <= s.faces[1].box.l ? s : null;
    },
    3000,
    "the tap spreads the stack",
    () => stackOf(a)
  );
  expect(
    await a.page.evaluate(() => [
      document.getElementById("people")!.classList.contains("spread"),
      document.body.classList.contains("quick-open"),
    ])
  ).toEqual([true, false]);
  // A tap on the page stacks them again.
  await tap(200, 500);
  await until(
    async () => {
      const s = await stackOf(a);
      return s.faces[0].box.r > s.faces[1].box.l;
    },
    3000,
    "a tap elsewhere stacks them again",
    () =>
      a.page.evaluate(() => {
        const p = document.getElementById("people")!;
        return [p.className, p.matches(":hover"), p.matches(":focus-within"), document.activeElement?.outerHTML.slice(0, 80)];
      })
  );
});
