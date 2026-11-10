// A release keeps the hashed files of the release before it (deploy/pipeline/keep-last.ts).
import { expect, test } from "bun:test";
import { filesToKeep, keepLast, withKept } from "../deploy/pipeline/keep-last";
import type { Release } from "../deploy/pipeline/release-format";
import type { AssetManifest } from "../shared/assets";

const bytes = (s: string) => new TextEncoder().encode(s);
const release = (assets: Record<string, string>) =>
  ({ version: "new", assets: Object.fromEntries(Object.entries(assets).map(([p, t]) => [p, bytes(t)])) }) as unknown as Release;
const LAST: AssetManifest = {
  files: { "style.css": "/_erga/style-old.css", "page.js": "/_erga/main-old.js", "inter.css": "/_erga/inter-same.css" },
  deps: { "page.js": ["/_erga/chunk-old.js", "/_erga/chunk-same.js"] },
  frame: ["/_erga/frame-old.js"],
  integrity: { "/_erga/main-old.js": "sha384-x", "/_erga/late-old.js": "sha384-y" },
  fonts: {
    css: "@font-face { src: url(/_erga/fonts/inter-old.woff2) }",
    preload: "",
    page: "@font-face { src: url(/_erga/fonts/literata-old.woff2) }",
  },
};
const NEW = release({
  "/_erga/style-new.css": "new",
  "/_erga/chunk-same.js": "same",
  "/_erga/inter-same.css": "same",
  "/manifest.json": "{}",
});

test("the files to keep: every file the last manifest names that the new release lacks", () => {
  expect(filesToKeep(NEW, LAST)).toEqual([
    "/_erga/chunk-old.js",
    "/_erga/fonts/inter-old.woff2",
    "/_erga/fonts/literata-old.woff2",
    "/_erga/frame-old.js",
    "/_erga/late-old.js",
    "/_erga/main-old.js",
    "/_erga/style-old.css",
  ]);
  expect(filesToKeep(NEW, null)).toEqual([]);
});

test("only hashed files under /_erga/: never another path of the release, or one that leaves the folder", () => {
  const odd = {
    ...LAST,
    files: { a: "/manifest.json", b: "/_erga/../index.js", c: "https://elsewhere.example/_erga/x.js", d: "/_erga/ok-1.js" },
  };
  expect(filesToKeep(release({}), odd)).toContain("/_erga/ok-1.js");
  for (const p of ["/manifest.json", "/_erga/../index.js", "https://elsewhere.example/_erga/x.js"])
    expect(filesToKeep(release({}), odd)).not.toContain(p);
  // A manifest of another shape keeps nothing, and breaks nothing.
  expect(filesToKeep(release({}), { files: {} } as unknown as AssetManifest)).toEqual([]);
});

test("the release's own files win, and the kept ones are added", () => {
  const r = withKept(NEW, { "/_erga/style-old.css": bytes("old"), "/_erga/style-new.css": bytes("WRONG") });
  expect(new TextDecoder().decode(r.assets["/_erga/style-new.css"])).toBe("new");
  expect(new TextDecoder().decode(r.assets["/_erga/style-old.css"])).toBe("old");
  expect(r.version).toBe("new");
});

test("a deploy asks the instance for its files and keeps those it answers; an instance that does not answer keeps none", async () => {
  const asked: string[] = [];
  const site = async (url: string) => {
    const path = new URL(url).pathname;
    asked.push(path);
    if (path == "/api/release") return Response.json({ files: LAST.files, version: "old", assets: LAST });
    if (path == "/_erga/late-old.js") return new Response("gone", { status: 404 });
    return new Response(`old ${path}`);
  };
  const lines: string[] = [];
  const r = await keepLast(NEW, "https://erga.example", site, (l) => lines.push(l));
  expect(Object.keys(r.assets).sort()).toEqual(
    [
      ...Object.keys(NEW.assets),
      "/_erga/chunk-old.js",
      "/_erga/fonts/inter-old.woff2",
      "/_erga/fonts/literata-old.woff2",
      "/_erga/frame-old.js",
      "/_erga/main-old.js",
      "/_erga/style-old.css",
    ].sort()
  );
  expect(new TextDecoder().decode(r.assets["/_erga/style-old.css"])).toBe("old /_erga/style-old.css");
  expect(asked).not.toContain("/_erga/chunk-same.js");
  expect(lines.join("\n")).toContain("keeps 6 of the 7 files");

  const down = async () => new Response("no", { status: 403 });
  const said: string[] = [];
  expect(await keepLast(NEW, "https://staging.example", down, (l) => said.push(l))).toBe(NEW);
  expect(said.join("\n")).toContain("keeps none");
  const broken = async (): Promise<Response> => {
    throw new Error("offline");
  };
  expect(await keepLast(NEW, "https://x.example", broken, () => {})).toBe(NEW);
});
