// A reader sees changes live: an agent's change shows in the open page, where the reader was, before any version is
// cut; only people who can edit read the versions. And a document's page loads one time: its scripts run one time
// and its media load one time, in the viewer, in the editor, after a reload and through the pencil; in the editor
// the document is where it stays from the first frame.
import { editor, type Editor } from "../helpers/editor";
import { expect, journey, servers, test, until, type Page } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";
import { framed, pagesFetch } from "../helpers/pages-fetch";
import { idOf, runTool, textOf } from "../helpers/tools";
import { moved, painted, still, watch, type Spot } from "./frames";
import { docFrame, inDoc, openViewer, signIn, viewing } from "./viewer";

const s = await servers.main();

const FIRST = `<!doctype html><title>First</title><link rel="stylesheet" href="style.css"><h1>First page</h1><p><a href="second.html">Second</a></p>`;
const DRAFT = "A draft line.";
const WRITTEN = "Written by an agent.";
/** A long page: a heading, then numbered paragraphs; the first has a line of the owner's draft. */
const LONG = `<!doctype html><title>Long read</title><h1>Long read</h1>${Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i + 1}.${i ? "" : ` ${DRAFT}`}</p>`).join("")}`;

journey("a reader's open page shows an agent's change", () => {
  let page: Page, id: string, path: string, cookie: string;
  /** The tools as someone's agent has them, on the document (a token: the owner's, or with a cookie that person's). */
  const agentOf = async (as: string | null) => {
    const { token } = await newToken(s.root, { label: "Live viewer agent" }, as);
    return async (name: string, args: object) => {
      const r = await runTool(s.root, name, { document: id, ...args }, { token });
      return { ok: r.ok, text: r.ok ? textOf(r.result) : (r.error ?? "") };
    };
  };
  let agent: Awaited<ReturnType<typeof agentOf>>;
  const reader = `ada${crypto.randomUUID().slice(0, 8)}`;
  /** The text that the document's page shows. */
  const shown = async () => (await inDoc<string>(page, `document.body?.innerText ?? ""`)) ?? "";
  /** The pill at the top of the reader's page that says who writes; null: no pill. */
  const pill = () =>
    page.evaluate(() => {
      const e = document.getElementById("erga-writer");
      return e && !e.hidden ? e.textContent : null;
    });

  /** The page's address in its frame: it names the version of the document that the reader sees. */
  const frameAt = () => inDoc<string>(page, "location.pathname");
  /** The first page with its stylesheet as the browser got it: bytes over the network (0: from its own copy), the heading's colour, its address. */
  const seen = () =>
    until(
      () =>
        inDoc<{ network: number; colour: string; at: string }>(
          page,
          `(() => { const css = performance.getEntriesByType("resource").find((r) => r.name.endsWith("/style.css")), h1 = document.querySelector("h1");
            return css && h1 ? { network: css.transferSize, colour: getComputedStyle(h1).color, at: location.pathname } : null; })()`
        ),
      10_000,
      "the page with its stylesheet"
    );

  test("a reader's browser shows the document as it is; a second visit takes the document's files from the browser's copy", async ({
    tab,
  }) => {
    page = tab.page;
    tab.strict = true;
    const made = await runTool(s.root, "create_document", {
      title: "Live read",
      kind: "project",
      files: { "index.html": FIRST, "second.html": LONG, "style.css": "h1 { color: rgb(200, 0, 0) }" },
    });
    expect(made.ok, made.error).toBe(true);
    ({ id, address: path } = JSON.parse(textOf(made.result)) as { id: string; address: string });
    expect((await runTool(s.root, "share_document", { document: id, login: reader, role: "viewer" })).ok).toBe(true);
    cookie = await signIn(s, reader);
    agent = await agentOf(null);
    await openViewer(page, `${s.root}${path}?user=${reader}`);
    await expect.poll(shown).toContain("First page");
    // The files are at an address with the document's version in it: the browser keeps them until the document changes.
    const first = (await seen())!;
    expect(first.colour).toBe("rgb(200, 0, 0)");
    expect(first.network).toBeGreaterThan(0);
    expect(first.at).toMatch(/^\/t\/[^/]+\/@[^/]+\/index\.html$/);
    // Away, and back: nothing of the stylesheet comes over the network.
    await page.goto("about:blank");
    await page.goto(`${s.root}${path}?user=${reader}`);
    const second = (await seen())!;
    expect([second.network, second.colour, second.at]).toEqual([0, "rgb(200, 0, 0)", first.at]);
  });

  // The reader saw the first page again after a change to the page that a link had opened.
  test("a reader who followed a link and scrolled down sees an agent's change to that page, where they were, before any version is cut; a pill says who writes", async () => {
    await page.evaluate(() => {
      (window as any).sameViewer = true;
      addEventListener("message", (e) => {
        if (e.data?.type == "erga-scroll") (window as any).heardY = e.data.y;
      });
    });
    await page.frameLocator("#frame").getByRole("link", { name: "Second" }).click();
    await expect.poll(shown).toContain("Paragraph 80.");
    await expect.poll(() => new URL(page.url()).pathname).toBe(`${path}/second`);
    await docFrame(page)!.evaluate(`scrollTo(0, 1200)`);
    // The viewer has heard where the reader is (the page tells it as it scrolls).
    await expect.poll(() => page.evaluate(() => (window as any).heardY)).toBe(1200);
    const before = await frameAt();
    // (No pill while nobody writes: not for the version that the page hears as it opens.)
    expect(await pill()).toBeNull();

    // The agent's line takes the place of the draft's: an edit through the tools.
    const changed = await agent("edit", { path: "second.html", edits: [{ oldText: DRAFT, newText: WRITTEN }] });
    expect(changed.ok, changed.text).toBe(true);
    // No version is cut yet: a viewer has the edit in the page, in its file, and in a copy of the document.
    expect(((await runTool(s.root, "versions", { document: id })).result as { pending: boolean }).pending).toBe(true);
    const as = { Cookie: cookie };
    const viewer = await (await fetch(`${s.root}${path}/second`, { headers: as })).text();
    const meta = (name: string) => new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(viewer)?.[1].replace(/&amp;/g, "&") ?? "";
    const src = meta("erga-pages") + meta("erga-page");
    expect(await (await framed(src)).text()).toContain(WRITTEN);
    expect(await (await pagesFetch(src)).text()).toContain(WRITTEN);
    const copy = (await fetch(`${s.root}/new?from=${id}`, { headers: as, redirect: "manual" })).headers
      .get("location")!
      .replace(/[?&]edit$/, "");
    expect(await (await fetch(`${s.root}${copy}/doc/second.html`, { headers: as })).text()).toContain(WRITTEN);

    await expect.poll(shown).toContain(WRITTEN);
    await expect.poll(async () => Math.abs(Number(await inDoc(page, `scrollY`)) - 1200)).toBeLessThan(4);
    expect(await shown()).toContain("Long read");
    expect(new URL(page.url()).pathname).toBe(`${path}/second`);
    expect(await page.evaluate(() => (window as any).sameViewer)).toBe(true);
    // The change is a new version: the page comes from another address.
    expect(await frameAt()).toMatch(/^\/t\/[^/]+\/@[^/]+\/second\.html$/);
    expect(await frameAt()).not.toBe(before);
    await expect.poll(pill).toBe("Live viewer agent is writing…");
    // The change adds no entry to the tab's history: Back goes to the page before, not to the old version of this one.
    await page.evaluate(() => history.back());
    await expect.poll(shown).toContain("First page");
    await expect.poll(() => new URL(page.url()).pathname).toBe(path);
  });

  test("only people who can edit read the versions: a viewer lists none, reads no old file, sees no diff and restores none; a bad token gets nothing", async () => {
    // The draft's line is only in the first version now: the agent's change took its place.
    const old = "v1";
    // Each as their agent does (a token).
    const [asOwner, asViewer] = [agent, await agentOf(cookie)];
    const ONLY = "Only people who can edit a document read its versions.";
    // The owner reads all of it.
    expect((await asOwner("read", { path: "second.html", version: old })).text).toContain(DRAFT);
    expect((await asOwner("versions", { from: old })).text).toContain(DRAFT);
    // The viewer reads the document as it is, and nothing of before: in the page (a session) and as their agent.
    const now = (await asViewer("read", { path: "second.html" })).text;
    expect(now).toContain("<h1>");
    expect(now).not.toContain(DRAFT);
    const inPage = await runTool(s.root, "versions", { document: id }, { cookie, origin: s.root });
    expect([inPage.status, inPage.error]).toEqual([403, ONLY]);
    for (const [tool, args] of [
      ["versions", {}],
      ["versions", { from: old }],
      ["versions", { from: old, to: "current" }],
      ["read", { path: "second.html", version: old }],
    ] as const) {
      const r = await asViewer(tool, args);
      expect([tool, r.ok, r.text]).toEqual([tool, false, ONLY]);
    }
    expect((await runTool(s.root, "restore_version", { document: id, version: old }, { cookie, origin: s.root })).status).toBe(403);
    // There is no publishing: viewers see the document as it is.
    const publish = await fetch(`${s.root}/api/docs/${id}/publish`, {
      method: "POST",
      headers: { Origin: s.root, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "manual", versionId: old }),
    });
    expect(publish.status).toBe(404);
    expect((await fetch(`${s.root}/d/${id}/pub/index.html`)).status).toBe(404);
    expect((await runTool(s.root, "versions", { document: id }, { token: "erga_forged" })).status).toBe(401);
  });

  // The owner's open page stayed as it was until a reload by hand: the files' address of someone who can edit has no
  // version, and with a place in the address (#), the same address again only moved the page to its place.
  test("someone who can edit, at a place in the page (#), sees an agent's change to a linked stylesheet alone", async () => {
    // (A document of its own: the first one's viewers hear of a change at most every 2 s.)
    const made = await runTool(s.root, "create_document", {
      title: "Live edit",
      kind: "project",
      files: { "index.html": FIRST, "style.css": "h1 { color: rgb(200, 0, 0) }" },
    });
    expect(made.ok, made.error).toBe(true);
    const own = JSON.parse(textOf(made.result)) as { id: string; address: string };
    await page.goto(`${s.root}${own.address}#place`);
    expect((await seen())!.at).toMatch(/^\/t\/[^/]+\/index\.html$/);
    const changed = await agent("edit", { document: own.id, path: "style.css", edits: [{ oldText: "200, 0, 0", newText: "0, 0, 200" }] });
    expect(changed.ok, changed.text).toBe(true);
    await expect.poll(() => inDoc<string>(page, `getComputedStyle(document.querySelector("h1")).color`)).toBe("rgb(0, 0, 200)");
    expect(await inDoc<string>(page, "location.hash")).toBe("#place");
  });
});

/** What the music page fetches one time for each run of it: its scripts, its media, and what its inline script fetches. */
const FILES = ["page.js", "balls.js", "audio.m4a", "intro.m4a", "ran.txt"];
const times = (n: number) => Object.fromEntries(FILES.map((f) => [f, n]));
const WIDTH = 1300;

// The fixture (e2e/fixtures/music) has the shape of a page of music widgets: an inline script, a module that imports
// another, a recording that it fetches and plays from a Blob, and an <audio> that loads its own.
journey("a document's page loads one time, for a reader and in the editor", () => {
  let page: Page, url: string, ed: Editor;
  /** How many times any frame of the tab asked for each of FILES, since the last `asked.clear()`. */
  const asked = new Map<string, number>();
  const count = () => Object.fromEntries(FILES.map((f) => [f, asked.get(f) ?? 0]));
  /** A mark that the page's run carries (its own global): the same page, not loaded again. */
  const mark = () => docFrame(page)!.evaluate(() => ((window as any).__run ??= Math.random()));
  /** The editor is up, on the page and in the tab. */
  const up = async () => {
    await ed.loaded();
    await ed.settle();
  };
  let bangs = "";
  /** A typed character reaches the room: the editor is up, and all that loads with the page has loaded. */
  const typed = async () => {
    await up();
    await ed.clickEnd("h1");
    await ed.type("!");
    bangs += "!";
    await expect.poll(() => ed.source()).toContain(`<h1>Visualizing music${bangs}</h1>`);
  };
  /** Opens the document in the editor from another page, or loads it again there, until `ready`: what the tab painted. */
  const open = async (how: "load" | "reload", at: Spot, ready: () => Promise<void>, address = url) => {
    if (how == "load") await page.goto("about:blank");
    asked.clear();
    return painted(page, at, async () => {
      if (how == "load") await page.goto(`${address}?edit`);
      else await page.reload();
      await ready();
    });
  };
  const keep = (kept: Record<string, unknown>) => () =>
    page.evaluate((kept) => {
      for (const [k, v] of Object.entries(kept)) localStorage.setItem(k, JSON.stringify(v));
    }, kept);

  // Three copies ran the page: the viewer's own, the frame's host page's, and the editor's.
  test("a reader's page loads one time, and the pencil loads nothing of the page again", async ({ tab }) => {
    page = tab.page;
    // (Strict: a copy that tried to run the scripts and was refused would say so in the console.)
    tab.strict = true;
    const doc = await s.fixture("music");
    url = doc.address;
    ed = editor(page, { address: url, dir: doc.dir, file: `${doc.dir}/index.html` });
    // (Routed: nothing comes from the cache, so each run of the page asks again. Not Erga's service worker's requests.)
    await page.context().route("**/*", (r) => r.continue());
    page.context().on("request", (r) => {
      if (r.serviceWorker()) return;
      const f = FILES.find((n) => new URL(r.url()).pathname.endsWith(`/${n}`));
      if (f) asked.set(f, (asked.get(f) ?? 0) + 1);
    });
    await watch(page);
    await openViewer(page, url, { width: WIDTH, height: 800 });
    await expect.poll(() => viewing(page)).toBe(true);
    await expect.poll(count).toEqual(times(1));
    const run = await mark();
    await page.locator(".erga-edit-button").click();
    await typed();
    expect(await mark(), "the same page").toBe(run);
    expect(count(), "the viewer, then the editor").toEqual(times(1));
    expect(await moved(page, { l: 0, r: WIDTH }), "the document's frame moved on the way into the editor").toEqual([]);
  });

  const CASES: { what: string; set: () => Promise<unknown>; want: Spot; agent: boolean }[] = [
    // The agent open at the left, 380px wide, 16px from the window's edge and from the document.
    { what: "the agent open", set: keep({ "erga:settings:v1": { agent: true } }), want: { l: 16 + 380 + 16, r: WIDTH }, agent: true },
    {
      what: "the agent open at the right",
      set: keep({ "erga:settings:v1": { agent: true }, "erga:layout:v1": { order: ["doc", "agent"], agentWidth: 520 } }),
      want: { l: 0, r: WIDTH - 16 - 520 - 16 },
      agent: true,
    },
    {
      what: "the agent closed by its close button",
      set: async () => {
        await page.locator("#agent-close").click();
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("erga:settings:v1") || "{}").agent)).toBe(false);
      },
      want: { l: 0, r: WIDTH },
      agent: false,
    },
  ];
  for (const { what, set, want, agent } of CASES) {
    // The document showed across the window, then slid beside the panel; and the page ran three times.
    test(`${what}: opened in the editor, the document is where it stays from the first frame, and the page's scripts run one time`, async () => {
      await set();
      still(await open("load", want, typed), want, `${what}, load`);
      expect(await page.evaluate(() => document.body.classList.contains("agent-open")), "the panel as kept").toBe(agent);
      expect(count(), `${what}: opened in the editor`).toEqual(times(1));
      // The page that ran is the one that the editor is on: its widget drew.
      expect(
        await docFrame(page)!.evaluate(() => {
          const c = document.getElementById("balls") as HTMLCanvasElement;
          return c
            .getContext("2d")!
            .getImageData(0, 0, c.width, c.height)
            .data.some((v, i) => i % 4 == 3 && v > 0);
        }),
        "the widget drew"
      ).toBe(true);
    });

    test(`${what}: loaded again in the editor, the same; out of the editor and back in by the pencil, it is the same page where it was`, async () => {
      still(await open("reload", want, up), want, `${what}, reload`);
      const run = await mark();
      await page.locator("#btn-edit").click();
      await expect.poll(() => viewing(page)).toBe(true);
      expect(new URL(page.url()).search, "the viewer's address").toBe("");
      await page.locator(".erga-edit-button").click();
      await typed();
      expect(new URL(page.url()).search, "the editor's address").toBe("?edit");
      expect(await mark(), "the same page").toBe(run);
      expect(count(), `${what}: loaded again, then out of the editor and back`).toEqual(times(1));
      expect(await moved(page, want), "the document's frame moved on the way out or in").toEqual([]);
    });
  }

  test("a document zoomed in the editor shows at its zoom from the first frame", async () => {
    // (A page of text alone: the music page draws its widget after its first frame.)
    const light = (await s.fixture("top/light")).address;
    await page.evaluate((doc) => localStorage.setItem(`erga:zoom:v1:${doc}`, "1.5"), await idOf(light));
    const want = { l: 0, r: WIDTH };
    const r = await open("load", want, up, light);
    still(r, want, "zoomed, load");
    expect(r.scales.length, "the frame showed").toBeGreaterThan(0);
    expect([...new Set(r.scales)], "the frame's scale").toEqual([1.5]);
  });
});
