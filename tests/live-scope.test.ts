import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Y from "yjs";
import { extractDocPath, isPageDoc, normalizePagePath, parseSrcset, scopeViewPaths, usedChangedPaths } from "../client/common/live-scope";
import { DocumentView } from "../document/api/view";
import { files as texts } from "../document/model/content";
import { MemoryStorage } from "../document/store/storage";

test("isPageDoc and normalizePagePath classify HTML/Markdown files and root empty path", () => {
  expect(isPageDoc("index.html")).toBe(true);
  expect(isPageDoc("projects/a/index.HTML")).toBe(true);
  expect(isPageDoc("notes.htm")).toBe(true);
  expect(isPageDoc("README.md")).toBe(true);
  expect(isPageDoc("style.css")).toBe(false);
  expect(isPageDoc("demo.js")).toBe(false);
  expect(normalizePagePath("")).toBe("index.html");
  expect(normalizePagePath(null)).toBe("index.html");
  expect(normalizePagePath("/projects/a/index.html")).toBe("projects/a/index.html");
});

test("scopeViewPaths skips unrelated HTML/MD files, reloads current page, and checks non-HTML assets", () => {
  // Unrelated HTML/MD files never reload this tab.
  expect(scopeViewPaths("index.html", ["projects/a/index.html"])).toEqual({ action: "skip" });
  expect(scopeViewPaths("index.html", ["about.html", "notes.md"])).toEqual({ action: "skip" });
  expect(scopeViewPaths("projects/a/index.html", ["index.html", "projects/b/index.html"])).toEqual({ action: "skip" });
  expect(scopeViewPaths("", ["projects/a/index.html"])).toEqual({ action: "skip" });

  // Editing this tab's own page reloads it.
  expect(scopeViewPaths("index.html", ["index.html"])).toEqual({ action: "reload" });
  expect(scopeViewPaths("", ["index.html"])).toEqual({ action: "reload" });
  expect(scopeViewPaths("projects/a/index.html", ["index.html", "projects/a/index.html"])).toEqual({ action: "reload" });

  // Mixed batch: strips unrelated HTML files and checks only the remaining assets.
  expect(scopeViewPaths("index.html", ["projects/a/index.html", "style.css"])).toEqual({ action: "check", paths: ["style.css"] });
  expect(scopeViewPaths("index.html", ["projects/a/demo.js", "projects/a/style.css"])).toEqual({
    action: "check",
    paths: ["projects/a/demo.js", "projects/a/style.css"],
  });

  // Unknown diff (reconnect greet or >100 files) conservatively reloads; empty array skips.
  expect(scopeViewPaths("index.html", null)).toEqual({ action: "reload" });
  expect(scopeViewPaths("index.html", [])).toEqual({ action: "skip" });
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

test("usedChangedPaths skips unused assets, restyles used CSS, reloads used JS, and falls back on overflow", () => {
  const used = new Set(["style.css", "app.js"]);
  expect(usedChangedPaths(["projects/b/style.css", "projects/b/demo.js"], used, false)).toEqual({ action: "skip" });
  expect(usedChangedPaths(["style.css", "projects/b/style.css"], used, false)).toEqual({ action: "restyle", paths: ["style.css"] });
  expect(usedChangedPaths(["style.css", "app.js"], used, false)).toEqual({ action: "reload" });
  expect(usedChangedPaths(["projects/b/demo.js"], used, true)).toEqual({ action: "reload" });
  expect(usedChangedPaths(["projects/b/style.css"], used, true)).toEqual({ action: "restyle", paths: ["projects/b/style.css"] });
});

test("DocumentView keeps paths edited while current() is awaiting and drops overflow lists to undefined", async () => {
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
  const told: { ver: string; paths?: string[] }[] = [];
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
    tell: (ver, paths) => {
      told.push({ ver, paths });
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

  // Over 100 distinct paths collapses to undefined (conservative reload).
  const many = Array.from({ length: 105 }, (_, i) => `p${i}.html`);
  view.changed(many);
  expect((view as unknown as { touched: Set<string> | null }).touched).toBeNull();
});
