// A release keeps the hashed files of the release before it, from this machine's own copy (deploy/pipeline/keep-last.ts).
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepLast, releasesDir, withKept } from "../deploy/pipeline/keep-last";
import type { Release } from "../deploy/deployer/release-format";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const release = (version: string, assets: Record<string, string>) =>
  ({ version, assets: Object.fromEntries(Object.entries(assets).map(([p, t]) => [p, bytes(t)])) }) as unknown as Release;

const dir = mkdtempSync(join(tmpdir(), "erga-keep-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const HOST = "erga.example.com";
const kept = () => readdirSync(releasesDir(dir, HOST)).sort();

const OLD = release("old000000000", {
  "/_erga/style-old.css": "old style",
  "/_erga/main-old.js": "old main",
  "/_erga/chunk-same.js": "same",
  "/_erga/fonts/inter-old.woff2": "old font",
  // Not a hashed file: the release's own, never kept.
  "/manifest.json": "{}",
  "/index.html": "<p>old</p>",
});
const NEW = release("new000000000", { "/_erga/style-new.css": "new style", "/_erga/chunk-same.js": "same", "/manifest.json": "{}" });

test("the release's own files win, and the kept ones are added", () => {
  const r = withKept(NEW, { "/_erga/style-old.css": bytes("old"), "/_erga/style-new.css": bytes("WRONG") });
  expect(text(r.assets["/_erga/style-new.css"])).toBe("new style");
  expect(text(r.assets["/_erga/style-old.css"])).toBe("old");
  expect(r.version).toBe("new000000000");
});

test("a deploy keeps its release's hashed files on this machine, and the next one takes those it lacks; no request to the instance", () => {
  const lines: string[] = [];
  const log = (l: string) => void lines.push(l);
  // The host's first deploy: nothing runs, nothing to keep. Its own hashed files stay on this machine.
  expect(keepLast(OLD, { dir, host: HOST, serving: null }, log).assets).toEqual(OLD.assets);
  expect(lines).toEqual(["erga.example.com runs no release yet: the release keeps no files of a release before."]);
  expect(kept()).toEqual(["old000000000"]);
  const own = join(releasesDir(dir, HOST), "old000000000");
  expect(existsSync(join(own, "_erga/fonts/inter-old.woff2"))).toBe(true);
  expect(existsSync(join(own, "manifest.json"))).toBe(false);
  expect(existsSync(join(own, "index.html"))).toBe(false);

  // The next deploy: the platform says that the old release serves. Its files that the new one lacks come in.
  const r = keepLast(NEW, { dir, host: HOST, serving: "old000000000" }, log);
  expect(Object.keys(r.assets).sort()).toEqual(
    [...Object.keys(NEW.assets), "/_erga/fonts/inter-old.woff2", "/_erga/main-old.js", "/_erga/style-old.css"].sort()
  );
  expect(text(r.assets["/_erga/style-old.css"])).toBe("old style");
  expect(text(r.assets["/_erga/chunk-same.js"])).toBe("same");
  expect(lines.at(-1)).toBe("The release keeps 3 files of the release before (old000000000), for pages still open.");
  // The machine holds two: the release that serves, and the new one. Only a release's own files: never the kept ones.
  expect(kept()).toEqual(["new000000000", "old000000000"]);
  expect(existsSync(join(releasesDir(dir, HOST), "new000000000", "_erga/style-old.css"))).toBe(false);

  // One release back only: the third release keeps the second's files, and the first's folder goes.
  const third = keepLast(release("third0000000", { "/_erga/style-3.css": "3" }), { dir, host: HOST, serving: "new000000000" }, log);
  expect(Object.keys(third.assets).sort()).toEqual(["/_erga/chunk-same.js", "/_erga/style-3.css", "/_erga/style-new.css"]);
  expect(kept()).toEqual(["new000000000", "third0000000"]);
  // The same release again (another setting): it keeps nothing new, and says nothing of it.
  const before = lines.length;
  expect(keepLast(NEW, { dir, host: HOST, serving: "new000000000" }, log).assets).toEqual(NEW.assets);
  expect(lines.length).toBe(before);
});

test("no copy on this machine (another machine deployed the release that serves): it keeps none, and says so; a name is never a path", () => {
  const lines: string[] = [];
  const r = keepLast(NEW, { dir, host: "other.example.com", serving: "abc123def456" }, (l) => lines.push(l));
  expect(r.assets).toEqual(NEW.assets);
  expect(lines).toEqual([
    "This machine has no copy of the files of release abc123def456, which other.example.com runs (another machine deployed it): the release keeps none of the release before.",
  ]);
  // A release named as a path reads no folder outside, and a host with a slash is one folder.
  expect(keepLast(NEW, { dir, host: "other.example.com", serving: "../erga.example.com/new000000000" }, () => {}).assets).toEqual(
    NEW.assets
  );
  expect(releasesDir(dir, "127.0.0.1:8787/x")).toBe(join(dir, "releases", "127.0.0.1_8787_x"));
});
