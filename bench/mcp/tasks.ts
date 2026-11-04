// The benchmark's tasks: what a person asks of a corpus document, and an objective check of the result. Each check
// fails on the untouched corpus and passes on the reference solution (selftest.ts).

import type { Page } from "playwright-core";
import { broken, links, loose, numbers, original, pageErrors, pages, squash, text, words } from "./lib.ts";
import type { Files, Probe, Task } from "./types.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) == JSON.stringify(b);
const near = (a: number, b: number, share: number) => Math.abs(a - b) <= b * share;
const show = (a: unknown) => JSON.stringify(a);

/** The text of the first match of an element (by a regex on the HTML), or "". */
const part = (html: string | undefined, re: RegExp) => text(html?.match(re)?.[0] ?? "");

// ---------------------------------------------------------------- essay

/** The essay's sections (h2 outside the table of contents, and the text up to the next one), and its contents list. */
const outline = (page: Page) =>
  page.evaluate(() => {
    const hs = [...document.querySelectorAll("h2")].filter((h) => !h.closest("nav"));
    const t = (e: Node | null | undefined) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
    return {
      sections: hs.map((h, i) => {
        const r = document.createRange();
        r.setStartAfter(h);
        if (hs[i + 1]) r.setEndBefore(hs[i + 1]);
        else r.setEndAfter(document.body.lastChild!);
        return { title: t(h), body: r.toString() };
      }),
      toc: [...document.querySelectorAll("nav.toc a")].map((a) => {
        const el = document.getElementById((a.getAttribute("href") ?? "").replace(/^#/, ""));
        const h = el && (el.matches("h2") ? el : el.querySelector("h2"));
        return { text: t(a), target: t(h) };
      }),
    };
  });

const itemsOf = (html: string, id: string) =>
  [...(html.match(new RegExp(`<section id="${id}">[\\s\\S]*?</section>`))?.[0] ?? "").matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) =>
    text(m[1])
  );

const essayTypo: Task = {
  id: "essay-typo",
  doc: "essay",
  prompt: 'The document has two spelling mistakes: "recieve" and "seperate". Correct both, and change nothing else.',
  async check(files, probe) {
    const f: string[] = [];
    const html = files["index.html"] ?? "";
    if (/recieve|seperate/i.test(html)) f.push("a misspelling is still there");
    const want = text(original("essay")["index.html"]).replace("recieve", "receive").replace("seperate", "separate");
    if (text(html) != want) f.push("the text differs from the original by more than the two corrections");
    return [...f, ...(await pageErrors(probe, ["index.html"]))];
  },
};

const MERGED = [
  "Summary",
  "Background",
  "Goals",
  "Non-goals",
  "The current system",
  "Proposed design",
  "Data model",
  "Sync protocol",
  "Conflict resolution",
  "Performance budget",
  "Rollout plan",
  "Risks and open questions",
  "Alternatives considered",
];

const essayMerge: Task = {
  id: "essay-merge",
  doc: "essay",
  prompt:
    'In the document, merge the "Risks" and "Open questions" sections into one section titled "Risks and open questions": first the risks, then the open questions, keeping all of their items. Put the merged section right after "Rollout plan". Update the table of contents at the top to match.',
  async check(files, probe) {
    const f: string[] = [];
    const page = await probe.open();
    const { sections, toc } = await outline(page);
    const titles = sections.map((s) => s.title);
    if (!same(titles.map(loose), MERGED.map(loose))) f.push(`the sections are ${show(titles)}`);
    const merged = sections.find((s) => loose(s.title) == loose("Risks and open questions"));
    const orig = original("essay")["index.html"];
    if (merged) {
      const body = loose(merged.body);
      const at = (items: string[]) => items.map((i) => body.indexOf(loose(i)));
      const risks = at(itemsOf(orig, "risks")),
        questions = at(itemsOf(orig, "open-questions"));
      if ([...risks, ...questions].some((i) => i < 0)) f.push("the merged section lacks some of the original items");
      else if (Math.max(...risks) > Math.min(...questions)) f.push("the open questions do not all come after the risks");
    }
    if (
      !same(
        toc.map((a) => loose(a.text)),
        MERGED.map(loose)
      )
    )
      f.push(`the table of contents lists ${show(toc.map((a) => a.text))}`);
    const bad = toc.filter((a) => loose(a.target) != loose(a.text));
    if (bad.length) f.push(`contents links that do not lead to their section: ${show(bad.map((a) => a.text))}`);
    if (!near(words(files["index.html"] ?? ""), words(orig), 0.02)) f.push("the word count changed by more than 2%");
    f.push(...probe.errors(page));
    return f;
  },
};

// ---------------------------------------------------------------- deck

const slidesOf = (page: Page) =>
  page.evaluate(() => ({
    count: (window as unknown as { ergaSteps?: { count(): number } }).ergaSteps?.count() ?? -1,
    slides: [...document.querySelectorAll("body > section.slide")].map((s) => {
      const h = s.querySelector("h1, h2"),
        li = s.querySelector("li");
      return {
        layout: s.getAttribute("data-layout"),
        title: (h?.textContent ?? "").trim(),
        text: s.textContent ?? "",
        items: [...s.querySelectorAll("li")].map((l) => l.textContent ?? ""),
        look: [h, li].map((e) => (e ? `${e.localName} ${getComputedStyle(e).fontSize} ${getComputedStyle(e).fontFamily}` : "")),
      };
    }),
  }));

/** The original deck's slides: title and loose text. */
const deckSlides = () =>
  (original("deck")["index.html"].match(/<section class="slide"[\s\S]*?<\/section>/g) ?? []).map((s) => ({
    title: part(s, /<h[12]>[\s\S]*?<\/h[12]>/),
    text: loose(text(s)),
  }));

/** Each slide's text is the original slide's with that title. */
function sameSlides(slides: { title: string; text: string }[], f: string[]) {
  const orig = new Map(deckSlides().map((s) => [s.title, s.text]));
  for (const s of slides) if (orig.has(s.title) && orig.get(s.title) != loose(s.text)) f.push(`the slide "${s.title}" changed`);
}

const POINTS = [
  "Divers: cheap per clean, but slow, risky, and banned in more ports every year.",
  "Dry docks: thorough, but a ship loses 3 to 5 days of trading.",
  "Other robots: built for inspection only, and none capture the debris.",
];

const deckAdd: Task = {
  id: "deck-add-slide",
  doc: "deck",
  prompt: `Add a new slide right after the "Business model" slide, titled "Competition", in the same style as the other content slides, with these three points:\n${POINTS.map((p) => `- ${p}`).join("\n")}`,
  async check(files, probe) {
    const f: string[] = [];
    const page = await probe.open();
    const { count, slides } = await slidesOf(page);
    const want = deckSlides().map((s) => s.title);
    want.splice(5, 0, "Competition");
    if (
      !same(
        slides.map((s) => s.title),
        want
      )
    )
      f.push(`the slides are ${show(slides.map((s) => s.title))}`);
    if (count != want.length) f.push(`the deck's steps count ${count} slides, not ${want.length}`);
    const s = slides.find((x) => x.title == "Competition");
    if (s) {
      if (s.layout != "content") f.push(`the new slide's layout is ${s.layout}, not content`);
      if (!same(s.items.map(loose), POINTS.map(loose))) f.push(`the new slide's points are ${show(s.items.map(squash))}`);
      const model = slides.find((x) => x.title == "The problem");
      if (model && !same(s.look, model.look))
        f.push(`the new slide's heading and points look different: ${show(s.look)} vs ${show(model.look)}`);
    }
    sameSlides(slides, f);
    f.push(...probe.errors(page));
    return f;
  },
};

const deckTrim: Task = {
  id: "deck-trim",
  doc: "deck",
  prompt: 'In the deck, delete the "Market" slide, and move "The ask" so that it comes right before the closing "Thank you" slide.',
  async check(files, probe) {
    const f: string[] = [];
    const page = await probe.open();
    const { count, slides } = await slidesOf(page);
    const want = deckSlides()
      .map((s) => s.title)
      .filter((t) => t != "Market" && t != "The ask");
    want.splice(want.length - 1, 0, "The ask");
    if (
      !same(
        slides.map((s) => s.title),
        want
      )
    )
      f.push(`the slides are ${show(slides.map((s) => s.title))}`);
    if (count != want.length) f.push(`the deck's steps count ${count} slides, not ${want.length}`);
    sameSlides(slides, f);
    f.push(...probe.errors(page));
    return f;
  },
};

// ---------------------------------------------------------------- canvas

type Box = { title: string; note: string; text: string; x: number; y: number; w: number; h: number };

const canvasOf = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector(".canvas") as HTMLElement;
    const steps = (window as unknown as { ergaSteps?: { count(): number; label(i: number): string } }).ergaSteps;
    return {
      w: c.offsetWidth,
      h: c.offsetHeight,
      steps: steps ? Array.from({ length: steps.count() }, (_, i) => steps.label(i)) : [],
      frames: [...c.querySelectorAll(".frame")].map((e) => {
        const el = e as HTMLElement;
        return {
          title: (el.querySelector("h2")?.textContent ?? "").trim(),
          note: (el.querySelector(".note")?.textContent ?? "").trim(),
          text: el.textContent ?? "",
          x: el.offsetLeft,
          y: el.offsetTop,
          w: el.offsetWidth,
          h: el.offsetHeight,
        };
      }),
    };
  });

/** The original frames' places and texts, by title. */
const canvasFrames = () =>
  [...original("canvas")["index.html"].matchAll(/<section class="frame" style="left: (\d+)px; top: (\d+)px;">([\s\S]*?)<\/section>/g)].map(
    (m) => ({
      title: part(m[3], /<h2>[\s\S]*?<\/h2>/),
      x: Number(m[1]),
      y: Number(m[2]),
      text: loose(text(m[3])),
    })
  );

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The frames other than `except` are where they were, with the same text. */
function framesKept(frames: Box[], except: string, f: string[]) {
  for (const o of canvasFrames()) {
    if (o.title == except) continue;
    const now = frames.find((b) => b.title == o.title);
    if (!now) f.push(`the frame "${o.title}" is gone`);
    else if (now.x != o.x || now.y != o.y) f.push(`the frame "${o.title}" moved`);
    else if (loose(now.text) != o.text) f.push(`the frame "${o.title}" changed its text`);
  }
}

/** The frame lies inside the canvas and overlaps none of the others. */
function placed(b: Box, all: Box[], canvas: { w: number; h: number }, f: string[]) {
  if (b.x < 0 || b.y < 0 || b.x + b.w > canvas.w || b.y + b.h > canvas.h) f.push(`"${b.title}" is not fully inside the canvas`);
  for (const o of all) if (o != b && overlap(b, o)) f.push(`"${b.title}" overlaps "${o.title}"`);
}

const canvasMove: Task = {
  id: "canvas-move",
  doc: "canvas",
  prompt:
    'On the canvas, the "Hiring" frame overlaps the "Budget" frame. Move "Hiring" to an empty spot so that no two frames overlap and every frame lies fully inside the canvas. Leave the other frames where they are, and keep the order of the steps.',
  async check(files, probe) {
    const f: string[] = [];
    const page = await probe.open();
    const c = await canvasOf(page);
    const want = canvasFrames().map((o) => o.title);
    if (!same(c.steps, want)) f.push(`the steps are ${show(c.steps)}`);
    framesKept(c.frames, "Hiring", f);
    const hiring = c.frames.find((b) => b.title == "Hiring");
    if (!hiring) f.push('the frame "Hiring" is gone');
    else if (loose(hiring.text) != canvasFrames().find((o) => o.title == "Hiring")?.text) f.push('"Hiring" changed its text');
    for (const b of c.frames) placed(b, c.frames, c, f);
    f.push(...probe.errors(page));
    return [...new Set(f)];
  },
};

const PILOT = "Three family-run delivery firms will test the new cargo trailer from January.";

const canvasAdd: Task = {
  id: "canvas-add",
  doc: "canvas",
  prompt: `Add a new frame to the canvas, titled "Pilot customers", with the small label "New" above the title like the other frames have, and the text "${PILOT}" Make it the step right after "Market" (the 4th step), and place it in an empty part of the canvas: fully inside the canvas, not overlapping any other frame, and the same size as the other frames.`,
  async check(files, probe) {
    const f: string[] = [];
    const page = await probe.open();
    const c = await canvasOf(page);
    const want = canvasFrames().map((o) => o.title);
    want.splice(3, 0, "Pilot customers");
    if (!same(c.steps, want)) f.push(`the steps are ${show(c.steps)}`);
    framesKept(c.frames, "", f);
    const pilot = c.frames.find((b) => b.title == "Pilot customers");
    if (pilot) {
      if (pilot.note != "New") f.push(`the new frame's label is ${show(pilot.note)}`);
      if (!loose(pilot.text).includes(loose(PILOT))) f.push("the new frame lacks its text");
      const other = c.frames[0];
      if (pilot.w != other.w || pilot.h != other.h) f.push(`the new frame is ${pilot.w}×${pilot.h}, not ${other.w}×${other.h}`);
      placed(pilot, c.frames, c, f);
    } else f.push('there is no frame "Pilot customers"');
    f.push(...probe.errors(page));
    return f;
  },
};

// ---------------------------------------------------------------- site

const SITE_PAGES = ["index.html", "about.html", "pricing.html", "docs/getting-started.html", "docs/api.html"];

/** Each page that was in the original site is still there. */
const kept = (files: Files, doc: string, except: string[] = []) =>
  pages(original(doc))
    .filter((p) => !except.includes(p) && !(p in files))
    .map((p) => `${p} is gone`);

const siteButtons: Task = {
  id: "site-buttons",
  doc: "site",
  prompt:
    "Change the primary buttons (the ones with the class btn-primary) on every page of the site to the green #0a7d55, with fully rounded, pill-shaped ends. Leave the secondary buttons as they are.",
  async check(files, probe) {
    const f: string[] = kept(files, "site");
    for (const path of SITE_PAGES) {
      if (!(path in files)) continue;
      const page = await probe.open(path);
      const look = await page.evaluate(() => {
        const of = (sel: string) =>
          [...document.querySelectorAll(sel)].map((b) => {
            const s = getComputedStyle(b);
            return {
              bg: s.backgroundColor,
              h: (b as HTMLElement).offsetHeight,
              radii: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius],
            };
          });
        return { primary: of(".btn-primary"), secondary: of(".btn-secondary") };
      });
      const count = (original("site")[path].match(/class="[^"]*\bbtn-primary\b/g) ?? []).length;
      if (look.primary.length != count) f.push(`${path} has ${look.primary.length} primary buttons, not ${count}`);
      const round = (r: string, h: number) => (r.endsWith("%") ? Number.parseFloat(r) >= 50 : Number.parseFloat(r) >= h / 2 - 0.5);
      for (const b of look.primary) {
        if (b.bg != "rgb(10, 125, 85)") f.push(`${path}: a primary button's background is ${b.bg}`);
        if (!b.radii.every((r) => round(r, b.h))) f.push(`${path}: a primary button's corners are ${b.radii.join(" ")}`);
      }
      for (const b of look.secondary)
        if (b.bg != "rgb(255, 255, 255)" || !b.radii.every((r) => r == "6px")) f.push(`${path}: a secondary button changed`);
      if (text(files[path]) != text(original("site")[path])) f.push(`${path}: the text changed`);
      f.push(...probe.errors(page).map((e) => `${path}: ${e}`));
    }
    return [...new Set(f)];
  },
};

const siteRename: Task = {
  id: "site-rename",
  doc: "site",
  prompt:
    "Rename the page docs/getting-started.html to docs/quickstart.html, and update every link in the site that pointed to the old address, so that no link is broken.",
  async check(files, probe) {
    const f = kept(files, "site", ["docs/getting-started.html"]);
    const orig = original("site");
    if ("docs/getting-started.html" in files) f.push("docs/getting-started.html is still there");
    if (!("docs/quickstart.html" in files)) f.push("docs/quickstart.html does not exist");
    else if (text(files["docs/quickstart.html"]) != text(orig["docs/getting-started.html"]))
      f.push("docs/quickstart.html's text differs from the old page's");
    f.push(...broken(files));
    const before = links(orig).filter((l) => l.target == "docs/getting-started.html").length;
    const after = links(files).filter((l) => l.target == "docs/quickstart.html" || l.target == "docs/quickstart").length;
    if (after != before) f.push(`${after} links lead to docs/quickstart.html; ${before} led to the old page`);
    for (const p of pages(orig)) if (p in files && text(files[p]) != text(orig[p])) f.push(`${p}: the text changed`);
    return [...f, ...(await pageErrors(probe, pages(files)))];
  },
};

const PRICE = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;
const prices = (s: string) => [...s.matchAll(PRICE)].map((m) => Number(m[1].replace(/,/g, "")));

const sitePrices: Task = {
  id: "site-prices",
  doc: "site",
  prompt:
    "Raise every price stated anywhere in the site by 10%, rounded to the cent (for example, $10 becomes $11 and $2.50 becomes $2.75). Do not change any other numbers.",
  async check(files, probe) {
    const f = kept(files, "site");
    for (const [path, html] of Object.entries(original("site"))) {
      if (!path.endsWith(".html") || !(path in files)) continue;
      const was = text(html),
        now = text(files[path]);
      const want = prices(was).map((p) => Math.round(p * 110) / 100),
        got = prices(now);
      if (want.length != got.length || want.some((p, i) => Math.abs(p - got[i]) > 0.005))
        f.push(`${path}: the prices are ${show(got)}, not ${show(want)}`);
      if (!same(numbers(now.replace(PRICE, " ")), numbers(was.replace(PRICE, " ")))) f.push(`${path}: other numbers changed`);
      if (!near(words(files[path]), words(html), 0.05)) f.push(`${path}: the word count changed by more than 5%`);
    }
    return [...f, ...(await pageErrors(probe, pages(files)))];
  },
};

const RELEASES = [
  ["October: Recurring invoices", "Send the same invoice every week, month or quarter, with the date filled in."],
  ["September: Card payments in 12 more countries", "Clients in Mexico, Brazil, Japan and nine more countries can pay by card."],
  ["August: Faster exports", "Quarterly exports for your accountant now take seconds, not minutes."],
];
const NAV = ["Home", "Pricing", "Changelog", "Docs", "About", "Start free"];

const siteNewPage: Task = {
  id: "site-new-page",
  doc: "site",
  prompt: `Add a new page, changelog.html, at the top level of the site, with the heading "Changelog" and the same header, navigation and footer as the other pages. List these three releases on it, newest first, each as a heading with its paragraph:\n${RELEASES.map(([h, p]) => `- "${h}": ${p}`).join("\n")}\nThen add a "Changelog" link to the navigation on every page, between "Pricing" and "Docs".`,
  async check(files, probe) {
    const f = kept(files, "site");
    if (!("changelog.html" in files)) return [...f, "changelog.html does not exist"];
    f.push(...broken(files));
    for (const path of pages(files)) {
      const page = await probe.open(path);
      const nav = await page.evaluate(() =>
        [...document.querySelectorAll(".site-header .site-nav a")].map((a) => ({
          text: (a.textContent ?? "").trim(),
          path: (a as HTMLAnchorElement).pathname,
        }))
      );
      if (
        !same(
          nav.map((a) => a.text),
          NAV
        )
      )
        f.push(`${path}: the navigation is ${show(nav.map((a) => a.text))}`);
      const link = nav.find((a) => a.text == "Changelog");
      if (link && !/^\/changelog(\.html)?$/.test(link.path)) f.push(`${path}: the Changelog link goes to ${link.path}`);
      if (path == "changelog.html") {
        const page2 = await page.evaluate(() => ({
          h1: (document.querySelector("main h1")?.textContent ?? "").trim(),
          heads: [...document.querySelectorAll("main h2, main h3")].map((h) => h.textContent ?? ""),
          main: document.querySelector("main")?.textContent ?? "",
          styled: getComputedStyle(document.querySelector(".site-header") ?? document.body).display == "flex",
          footer: !!document.querySelector("footer.site-footer"),
        }));
        if (page2.h1 != "Changelog") f.push(`changelog.html's heading is ${show(page2.h1)}`);
        const heads = page2.heads.map(loose).filter((h) => RELEASES.some(([r]) => loose(r) == h));
        if (
          !same(
            heads,
            RELEASES.map(([r]) => loose(r))
          )
        )
          f.push(`changelog.html's release headings are ${show(page2.heads.map(squash))}`);
        for (const [, p] of RELEASES) if (!loose(page2.main).includes(loose(p))) f.push(`changelog.html lacks "${p}"`);
        if (!page2.styled) f.push("changelog.html does not use the site's stylesheet");
        if (!page2.footer) f.push("changelog.html has no footer");
      } else if (part(files[path], /<main>[\s\S]*<\/main>/) != part(original("site")[path], /<main>[\s\S]*<\/main>/))
        f.push(`${path}: the content changed`);
      f.push(...probe.errors(page).map((e) => `${path}: ${e}`));
    }
    return f;
  },
};

// ---------------------------------------------------------------- table

const tableOf = (page: Page) =>
  page.evaluate(() => {
    const cells = (tr: Element) => [...(tr as HTMLTableRowElement).cells].map((c) => (c.textContent ?? "").trim());
    const table = document.querySelector("#sales") as HTMLTableElement;
    return {
      head: [...table.querySelectorAll("thead th")].map((th) => (th.textContent ?? "").trim()),
      rows: [...table.querySelectorAll("tbody tr")].map(cells),
      foot: [...table.querySelectorAll("tfoot tr")].map(cells),
      last: cells(table.rows[table.rows.length - 1]),
    };
  });

const amount = (s: string) => Number(s.replace(/[$,\s]/g, ""));
const tbody = (html: string | undefined) => part(html, /<tbody>[\s\S]*<\/tbody>/);

const tableTotals: Task = {
  id: "table-totals",
  doc: "table",
  prompt:
    "The totals row at the bottom of the sales table is wrong. Correct its units sold, revenue and in-stock totals so that they match the rows above it. Do not change the rows.",
  async check(files, probe) {
    const f: string[] = [];
    if (tbody(files["index.html"]) != tbody(original("table")["index.html"])) f.push("the table's rows changed");
    const page = await probe.open();
    const t = await tableOf(page);
    const sum = (i: number) => t.rows.reduce((s, r) => s + amount(r[i]), 0);
    const foot = t.foot[0] ?? [];
    if (t.foot.length != 1 || foot[0] != "Total") f.push("the table has no single totals row");
    for (const [i, name] of [
      [3, "units sold"],
      [5, "revenue"],
      [6, "in stock"],
    ] as const)
      if (Math.abs(amount(foot[i] ?? "") - sum(i)) > 0.005) f.push(`the ${name} total is ${foot[i]}, not ${sum(i).toFixed(2)}`);
    f.push(...probe.errors(page));
    return f;
  },
};

const tableSort: Task = {
  id: "table-sort",
  doc: "table",
  prompt:
    "Make the sales table sortable: clicking a column's header sorts the rows by that column, ascending on the first click and descending on the next click of the same header. The number columns (units sold, unit price, revenue, in stock) must sort by value, not as text. The totals row stays at the bottom.",
  async check(files, probe) {
    const f: string[] = [];
    if (tbody(files["index.html"]) != tbody(original("table")["index.html"])) f.push("the table's rows changed in the file");
    const page = await probe.open();
    const start = await tableOf(page);
    const key = (rows: string[][]) => rows.map((r) => r.join("|")).sort();
    const sorted = <T>(xs: T[], le: (a: T, b: T) => boolean) => xs.every((x, i) => i == 0 || le(xs[i - 1], x));
    // Text in either order a person calls sorted: letter by letter, or with the numbers in it by value ("2m" before "10m").
    const orders = [{ sensitivity: "base" }, { sensitivity: "base", numeric: true }] as const;
    const steps: [string, "asc" | "desc", boolean][] = [
      ["Revenue", "asc", true],
      ["Revenue", "desc", true],
      ["Units sold", "asc", true],
      ["Product", "asc", false],
      ["Product", "desc", false],
    ];
    for (const [name, dir, numeric] of steps) {
      // On the header's text, as a person clicks it (a wide header's middle can be beside it).
      await page.locator("#sales thead th", { hasText: name }).first().getByText(name).first().click();
      const t = await tableOf(page);
      const col = t.head.findIndex((h) => h.includes(name));
      const values = t.rows.map((r) => r[col] ?? "");
      const ok = numeric
        ? sorted(values.map(amount), dir == "asc" ? (a, b) => a <= b : (a, b) => a >= b)
        : orders.some((o) => {
            const le = (a: string, b: string) => a.localeCompare(b, "en", o) <= 0;
            return sorted(values, dir == "asc" ? le : (a, b) => le(b, a));
          });
      if (!ok) f.push(`after a click on "${name}", the rows are not in ${dir}ending order`);
      if (!same(key(t.rows), key(start.rows))) f.push(`after a click on "${name}", the rows are not the same rows`);
      if (t.last[0] != "Total") f.push(`after a click on "${name}", the totals row is not at the bottom`);
    }
    f.push(...probe.errors(page));
    return [...new Set(f)];
  },
};

// ---------------------------------------------------------------- app

const appSwap: Task = {
  id: "app-swap",
  doc: "app",
  prompt:
    'Add a "Swap" button between the From and To unit menus of the converter. Clicking it swaps the two units and updates the result at once. Everything else must keep working.',
  async check(files, probe) {
    const f: string[] = [];
    const page = await probe.open();
    const swap = page.getByRole("button", { name: /swap/i });
    if ((await swap.count()) != 1) return [`the page has ${await swap.count()} Swap buttons`, ...probe.errors(page)];
    const between = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /swap/i.test(x.textContent + (x.getAttribute("aria-label") ?? "")));
      const from = document.getElementById("from")!,
        to = document.getElementById("to")!;
      return (
        !!b &&
        !!(from.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        !!(b.compareDocumentPosition(to) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    });
    if (!between) f.push("the Swap button is not between the From and To menus");
    const result = async () => loose((await page.locator("#result").textContent()) ?? "");
    const expect = async (want: string) => {
      const got = await result();
      if (got != loose(want)) f.push(`the result shows ${show(got)}, not ${show(want)}`);
    };
    await page.selectOption("#category", "length");
    await page.fill("#value", "10");
    await page.selectOption("#from", "km");
    await page.selectOption("#to", "mi");
    await expect("10 kilometres = 6.2137 miles");
    await swap.click();
    const units = await page.evaluate(() => [
      (document.getElementById("from") as HTMLSelectElement).value,
      (document.getElementById("to") as HTMLSelectElement).value,
    ]);
    if (!same(units, ["mi", "km"])) f.push(`after Swap the units are ${show(units)}`);
    await expect("10 miles = 16.0934 kilometres");
    await page.selectOption("#category", "temperature");
    await page.fill("#value", "100");
    await expect("100 degrees Celsius = 212 degrees Fahrenheit");
    await swap.click();
    await expect("100 degrees Fahrenheit = 37.7778 degrees Celsius");
    f.push(...probe.errors(page));
    return f;
  },
};

// ---------------------------------------------------------------- handbook

/** The vacation figures: on each page, a phrase of the original text and the same phrase after the change. */
const VACATION: Record<string, [string, string][]> = {
  "index.html": [["20 days of paid vacation", "25 days of paid vacation"]],
  "onboarding.html": [["your 20 vacation days", "your 25 vacation days"]],
  "time-off.html": [
    ["get 20 days of paid vacation", "get 25 days of paid vacation"],
    ["gets 16 days", "gets 20 days"],
    ["gets 12 days", "gets 15 days"],
    ["Vacation 20 days a year", "Vacation 25 days a year"],
  ],
  "benefits.html": [["20 days' paid vacation", "25 days' paid vacation"]],
};

const handbookVacation: Task = {
  id: "handbook-vacation",
  doc: "handbook",
  prompt:
    "Our paid vacation allowance went up from 20 to 25 days a year for full-time staff. Update every place in the handbook that states it, including any figures worked out from it. Only change the figures that depend on it, and leave every other number as it is.",
  async check(files, probe) {
    const f = kept(files, "handbook");
    for (const [path, html] of Object.entries(original("handbook"))) {
      if (!path.endsWith(".html") || !(path in files)) continue;
      let want = text(html);
      for (const [a, b] of VACATION[path] ?? []) {
        if (!want.includes(a)) throw new Error(`handbook-vacation: "${a}" is not in ${path}`);
        want = want.replace(a, b);
      }
      const got = numbers(text(files[path])),
        exp = numbers(want);
      if (!same(got, exp)) f.push(`${path}: the numbers are ${show(got)}, not ${show(exp)}`);
      if (!near(words(files[path]), words(html), 0.1)) f.push(`${path}: the word count changed by more than 10%`);
    }
    return [...f, ...(await pageErrors(probe, pages(files)))];
  },
};

const handbookDelete: Task = {
  id: "handbook-delete",
  doc: "handbook",
  prompt:
    "Remove the Expenses page from the handbook: delete expenses.html and remove every link to it from the other pages, so that no link is broken. Keep the rest of each page's content.",
  async check(files, probe) {
    const f = kept(files, "handbook", ["expenses.html"]);
    if ("expenses.html" in files) f.push("expenses.html is still there");
    f.push(...broken(files));
    for (const [path, html] of Object.entries(original("handbook"))) {
      if (!path.endsWith(".html") || path == "expenses.html" || !(path in files)) continue;
      if (words(files[path]) < words(html) * 0.9) f.push(`${path}: more than 10% of its words are gone`);
      const page = await probe.open(path);
      const n = await page.evaluate(() => document.querySelectorAll(".sidebar a").length);
      if (n != 5) f.push(`${path}: the sidebar has ${n} links, not 5`);
      f.push(...probe.errors(page).map((e) => `${path}: ${e}`));
    }
    return f;
  },
};

export const TASKS: Task[] = [
  essayTypo,
  essayMerge,
  deckAdd,
  deckTrim,
  canvasMove,
  canvasAdd,
  siteButtons,
  siteRename,
  sitePrices,
  siteNewPage,
  tableTotals,
  tableSort,
  appSwap,
  handbookVacation,
  handbookDelete,
];
