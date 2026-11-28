import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Y from "yjs";
import {
  diffDigests,
  extractDocPath,
  isPageDoc,
  isStaticResourceInitiator,
  normalizePagePath,
  parseSrcset,
  scopeViewPaths,
  usedChangedPaths,
} from "../client/common/live-scope";
import { DocumentView } from "../document/api/view";
import { files as texts } from "../document/model/content";
import { MemoryStorage } from "../document/store/storage";

test("isPageDoc, isStaticResourceInitiator, and normalizePagePath classify files and initiators", () => {
  expect(isPageDoc("index.html")).toBe(true);
  expect(isPageDoc("projects/a/index.HTML")).toBe(true);
  expect(isPageDoc("notes.htm")).toBe(true);
  expect(isPageDoc("README.md")).toBe(true);
  expect(isPageDoc("style.css")).toBe(false);
  expect(isPageDoc("demo.js")).toBe(false);
  expect(isStaticResourceInitiator("script")).toBe(true);
  expect(isStaticResourceInitiator("link")).toBe(true);
  expect(isStaticResourceInitiator("img")).toBe(true);
  expect(isStaticResourceInitiator("fetch")).toBe(false);
  expect(isStaticResourceInitiator("xmlhttprequest")).toBe(false);
  expect(isStaticResourceInitiator("beacon")).toBe(false);
  expect(normalizePagePath("")).toBe("index.html");
  expect(normalizePagePath(null)).toBe("index.html");
  expect(normalizePagePath("/projects/a/index.html")).toBe("projects/a/index.html");
});

test("scopeViewPaths skips unrelated HTML/MD files, patches current page, and checks non-HTML assets", () => {
  // Unrelated HTML/MD files never reload this tab.
  expect(scopeViewPaths("index.html", ["projects/a/index.html"])).toEqual({ action: "skip" });
  expect(scopeViewPaths("index.html", ["about.html", "notes.md"])).toEqual({ action: "skip" });
  expect(scopeViewPaths("projects/a/index.html", ["index.html", "projects/b/index.html"])).toEqual({ action: "skip" });
  expect(scopeViewPaths("", ["projects/a/index.html"])).toEqual({ action: "skip" });

  // Editing this tab's own page patches it in place, carrying any accompanying non-HTML assets.
  expect(scopeViewPaths("index.html", ["index.html"])).toEqual({ action: "patch", assets: [] });
  expect(scopeViewPaths("", ["index.html"])).toEqual({ action: "patch", assets: [] });
  expect(scopeViewPaths("projects/a/index.html", ["index.html", "projects/a/index.html"])).toEqual({
    action: "patch",
    assets: [],
  });
  expect(scopeViewPaths("index.html", ["index.html", "style.css", "projects/a/index.html"])).toEqual({
    action: "patch",
    assets: ["style.css"],
  });

  // Mixed batch: strips unrelated HTML files and checks only the remaining assets.
  expect(scopeViewPaths("index.html", ["projects/a/index.html", "style.css"])).toEqual({ action: "check", paths: ["style.css"] });
  expect(scopeViewPaths("index.html", ["projects/a/demo.js", "projects/a/style.css"])).toEqual({
    action: "check",
    paths: ["projects/a/demo.js", "projects/a/style.css"],
  });

  // Unknown diff (reconnect greet without digests or >100 files) conservatively reloads; empty array skips.
  expect(scopeViewPaths("index.html", null)).toEqual({ action: "reload" });
  expect(scopeViewPaths("index.html", [])).toEqual({ action: "skip" });
});

test("diffDigests computes exact changed, added, and deleted paths across reconnects", () => {
  expect(diffDigests(null, { "index.html": "a" })).toBeNull();
  expect(diffDigests({ "index.html": "a" }, null)).toBeNull();
  expect(diffDigests({ "index.html": "a", "b.html": "1" }, { "index.html": "a", "b.html": "1" })).toEqual([]);
  expect(
    diffDigests({ "index.html": "a", "b.html": "1", "old.json": "x" }, { "index.html": "a", "b.html": "2", "new.json": "y" })?.sort()
  ).toEqual(["b.html", "new.json", "old.json"]);
});

test("extractDocPath resolves relative, versioned, and encoded URLs inside the document token", () => {
  const origin = "https://doc12345-ada.erga-pages.dev";
  const baseEdit = `${origin}/t/tok123/projects/a/index.html`;
  const baseRead = `${origin}/t/tok123/@l1/projects/a/index.html`;

  expect(extractDocPath("demo.js?v=1", origin, "/t/tok123/", baseEdit)).toBe("projects/a/demo.js");
  expect(extractDocPath("../../style.css#top", origin, "/t/tok123/", baseEdit)).toBe("style.css");
  expect(extractDocPath("style.css", origin, "/t/tok123/@l1/", baseRead)).toBe("projects/a/style.css");
  expect(extractDocPath(`${origin}/t/tok123/@l2/style.css`, origin, "/t/tok123/@l1/", baseRead)).toBe("style.css");
  expect(extractDocPath("images/my%20pic.png", origin, "/t/tok123/", `${origin}/t/tok123/index.html`)).toBe("images/my pic.png");
  // External origin or different token prefix is ignored.
  expect(extractDocPath("https://other.example/style.css", origin, "/t/tok123/", baseEdit)).toBeNull();
  expect(extractDocPath("/erga/text/editor.js", origin, "/t/tok123/", baseEdit)).toBeNull();
});

test("parseSrcset extracts candidate URLs cleanly", () => {
  expect(parseSrcset("img/a.png 1x, img/b.png 2x")).toEqual(["img/a.png", "img/b.png"]);
  expect(parseSrcset("  hero-400.webp 400w , hero-800.webp 800w  ")).toEqual(["hero-400.webp", "hero-800.webp"]);
});

test("usedChangedPaths skips unused & fetched data assets, restyles used CSS, reloads used JS, and falls back on overflow", () => {
  const used = new Set(["style.css", "app.js"]);
  const fetched = new Set(["plans.json", "projects/a/status.json"]);
  expect(usedChangedPaths(["projects/b/style.css", "projects/b/demo.js"], used, false, fetched)).toEqual({ action: "skip" });
  expect(usedChangedPaths(["plans.json", "projects/a/status.json"], used, false, fetched)).toEqual({
    action: "skip",
    dataPaths: ["plans.json", "projects/a/status.json"],
  });
  expect(usedChangedPaths(["style.css", "plans.json"], used, false, fetched)).toEqual({
    action: "restyle",
    paths: ["style.css"],
    dataPaths: ["plans.json"],
  });
  expect(usedChangedPaths(["style.css", "projects/b/style.css"], used, false)).toEqual({ action: "restyle", paths: ["style.css"] });
  expect(usedChangedPaths(["style.css", "app.js"], used, false)).toEqual({ action: "reload" });
  expect(usedChangedPaths(["projects/b/demo.js"], used, true)).toEqual({ action: "reload" });
  expect(usedChangedPaths(["projects/b/style.css"], used, true)).toEqual({ action: "restyle", paths: ["projects/b/style.css"] });
});

test("DocumentView keeps paths & incremental digests while current() is awaiting and serves currentGreet digests", async () => {
  const storage = new MemoryStorage();
  const doc = new Y.Doc();
  const a = new Y.Text();
  a.insert(0, "<h1>A</h1>");
  const b = new Y.Text();
  b.insert(0, "<h1>B</h1>");
  texts(doc).set("index.html", a);
  texts(doc).set("b.html", b);

  let releaseInfo: (() => void) | null = null;
  let blockOnce = true;
  let gotTell!: () => void;
  const toldOnce = new Promise<void>((r) => (gotTell = r));
  const told: { ver: string; paths?: string[]; digests?: Record<string, string | null> }[] = [];
  const view = new DocumentView({
    storage,
    isOpen: () => true,
    closing: () => Promise.resolve(),
    doc: () => Effect.succeed(doc),
    info: () =>
      blockOnce
        ? new Promise((resolve) => {
            blockOnce = false;
            releaseInfo = () => resolve({ index: "index.html" });
          })
        : Promise.resolve({ index: "index.html" }),
    tell: (ver, paths, digests) => {
      told.push({ ver, paths, digests });
      gotTell();
    },
    log: () => {},
  });

  // First edit starts news() and suspends on info().
  a.insert(a.length, "<p>1</p>");
  view.changed(["index.html"]);
  // Second edit lands while current() is still awaiting: must not be cleared away.
  b.insert(b.length, "<p>2</p>");
  view.changed(["b.html"]);
  releaseInfo!();
  await toldOnce;

  expect(told.length).toBe(1);
  expect(told[0].paths?.sort()).toEqual(["b.html", "index.html"]);
  expect(Object.keys(told[0].digests ?? {}).sort()).toEqual(["b.html", "index.html"]);

  const greet = await view.currentGreet();
  expect(greet?.ver).toBe(told[0].ver);
  expect(greet?.digests?.["index.html"]).toBe(told[0].digests?.["index.html"] ?? undefined);
  expect(greet?.digests?.["b.html"]).toBe(told[0].digests?.["b.html"] ?? undefined);

  // Over 100 distinct paths collapses to undefined (conservative reload).
  const many = Array.from({ length: 105 }, (_, i) => `p${i}.html`);
  view.changed(many);
  expect((view as unknown as { touched: Set<string> | null }).touched).toBeNull();
});
