// A document's versions on storage in memory: cutting, sharing
// unchanged files between versions, listing, reading back, what changed, and
// the descriptions written when no model does.

import { afterEach, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { cleanDescription, describeChange, fallbackDescription, unifiedDiff, versionNumber, Versions, type KV } from "../document/versions";

/** Versions on `kv`, each call run to its answer. */
function versionsOn(kv: KV, now?: () => number) {
  const v = new Versions(kv, now);
  const run = Effect.runPromise;
  return {
    cut: (...a: Parameters<Versions["cut"]>) => run(v.cut(...a)),
    head: () => run(v.head),
    get: (n: number) => run(v.get(n)),
    list: (...a: Parameters<Versions["list"]>) => run(v.list(...a)),
    file: (...a: Parameters<Versions["file"]>) => run(v.file(...a)),
    files: (...a: Parameters<Versions["files"]>) => run(v.files(...a)),
    changes: (...a: Parameters<Versions["changes"]>) => run(v.changes(...a)),
    describe: (...a: Parameters<Versions["describe"]>) => run(v.describe(...a)),
  };
}

/** Durable Object storage's shape, in a Map, counting what's written. */
function memory() {
  const map = new Map<string, unknown>();
  const puts: string[] = [];
  const kv: KV = {
    get: (async (k: string | string[]) => Array.isArray(k) ? new Map(k.filter((x) => map.has(x)).map((x) => [x, map.get(x)])) : map.get(k)) as KV["get"],
    put: async (entries) => { for (const [k, v] of Object.entries(entries)) { map.set(k, v); puts.push(k); } },
  };
  return { kv, map, puts, blobs: () => [...map.keys()].filter((k) => k.startsWith("blobs/")).length };
}
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string | Uint8Array>) => new Map(Object.entries(o).map(([p, d]) => [p, typeof d == "string" ? enc(d) : d]));

test("a version holds every file; one that changes nothing isn't cut", async () => {
  const m = memory();
  const v = versionsOn(m.kv, () => Date.UTC(2026, 9, 4));
  const first = await v.cut(files({ "index.html": "<h1>Hi</h1>", "style.css": "h1{}" }), "index.html", ["ada"], "First version");
  expect(first?.version).toMatchObject({ id: "v1", n: 1, authors: ["ada"], description: "First version", at: "2026-10-04T00:00:00.000Z" });
  expect(first?.previous).toBeNull();
  expect(await v.cut(files({ "index.html": "<h1>Hi</h1>", "style.css": "h1{}" }), "index.html", ["bo"])).toBeNull();
  expect(await v.head()).toBe(1);
  // An empty folder made is a change too, and kept with the version.
  const withFolder = await v.cut(files({ "index.html": "<h1>Hi</h1>", "style.css": "h1{}" }), "index.html", ["ada"], null, ["drafts"]);
  expect(withFolder?.version).toMatchObject({ n: 2, folders: ["drafts"] });
  expect(await v.cut(files({ "index.html": "<h1>Hi</h1>", "style.css": "h1{}" }), "index.html", [], null, ["drafts"])).toBeNull();
});

test("unchanged files are stored once, shared by every version", async () => {
  const m = memory();
  const v = versionsOn(m.kv);
  const logo = new Uint8Array(5000).map((_, i) => i % 251);
  await v.cut(files({ "index.html": "one", "style.css": "css", "logo.png": logo }), "index.html", []);
  expect(m.blobs()).toBe(3);
  m.puts.length = 0;
  const two = await v.cut(files({ "index.html": "two", "style.css": "css", "logo.png": logo }), "index.html", ["ada", "ada’s agent", "ada"]);
  // Only the changed file is written, with the version and the head.
  expect(m.puts.filter((k) => k.startsWith("blobs/"))).toHaveLength(1);
  expect(m.blobs()).toBe(4);
  expect(two?.version.authors).toEqual(["ada", "ada’s agent"]);
  // Going back to an earlier text writes nothing new either.
  m.puts.length = 0;
  await v.cut(files({ "index.html": "one", "style.css": "css", "logo.png": logo }), "index.html", []);
  expect(m.puts.filter((k) => k.startsWith("blobs/"))).toHaveLength(0);
  // Every version reads back whole.
  const v2 = (await v.get(2))!;
  expect(new TextDecoder().decode((await v.files(v2)).get("index.html"))).toBe("two");
  expect((await v.file(v2, "logo.png"))?.length).toBe(5000);
  expect(await v.file(v2, "nope.css")).toBeNull();
});

test("versions list newest first, in pages", async () => {
  const v = versionsOn(memory().kv);
  for (let i = 1; i <= 25; i++) await v.cut(files({ "index.html": `v${i}` }), "index.html", []);
  const first = await v.list();
  expect(first.total).toBe(25);
  expect(first.versions.map((x) => x.n)).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
  const next = await v.list({ before: 16, limit: 10 });
  expect(next.versions[0].n).toBe(15);
  expect((await v.list({ before: 3 })).versions.map((x) => x.n)).toEqual([2, 1]);
  // A fresh reader (another instance of the object) sees the same.
  expect((await versionsOn(memory().kv).list()).total).toBe(0);
});

test("what changed: a compact diff, and the fallback description", async () => {
  const v = versionsOn(memory().kv);
  const a = (await v.cut(files({ "index.html": "<h1>Pricing</h1>\n<p>Old intro</p>\n", "old.css": "x" }), "index.html", []))!.version;
  const b = (await v.cut(files({ "index.html": "<h1>Pricing</h1>\n<p>New intro</p>\n", "logo.png": new Uint8Array([137, 80, 78, 71, 255]) }), "index.html", []))!.version;
  const c = await v.changes(a, b);
  expect(c).toMatchObject({ changed: ["index.html"], added: ["logo.png"], removed: ["old.css"] });
  expect(c.diff).toContain("-<p>Old intro</p>");
  expect(c.diff).toContain("+<p>New intro</p>");
  expect(c.diff).toContain("logo.png: binary file added");
  expect(c.diff).toContain("old.css: deleted");
  expect(fallbackDescription(c)).toBe("Edited index.html, added logo.png");
  expect(fallbackDescription({ changed: ["index.html", "style.css"], added: [], removed: [] })).toBe("Edited index.html and style.css");
  expect(fallbackDescription({ changed: ["a.html", "b.css", "c.js"], added: [], removed: [] })).toBe("Edited a.html and 2 more files");
  expect(fallbackDescription({ changed: [], added: [], removed: ["x.png"] })).toBe("Removed x.png");
  await v.describe(b.n, "Rewrote the pricing intro text");
  expect((await v.get(b.n))?.description).toBe("Rewrote the pricing intro text");
});

test("the model's answer, cleaned", () => {
  expect(cleanDescription("\"Rewrote the pricing intro text.\"\n")).toBe("Rewrote the pricing intro text");
  expect(cleanDescription("  \n")).toBeNull();
  expect(versionNumber("v12")).toBe(12);
  expect(versionNumber(3)).toBe(3);
  expect(versionNumber("12")).toBe(12);
  expect(versionNumber("x")).toBeNull();
  expect(versionNumber("v0")).toBeNull();
});

test("unified diffs between two file sets: changed, added, deleted, binary, one path, cut", () => {
  const before = files({ "index.html": "one\ntwo\nthree\n", "old.css": "h1{}\n", "img.png": new Uint8Array([0xff, 0xfe]), "blog/a.md": "a\n", "same.txt": "x\n" });
  const after = files({ "index.html": "one\n2\nthree\n", "new.md": "# Hi\n", "img.png": new Uint8Array([0xff, 0xfd, 1]), "blog/a.md": "b\n", "same.txt": "x\n" });
  const d = unifiedDiff(before, after);
  expect(d.files).toEqual(["blog/a.md", "img.png", "index.html", "new.md", "old.css"]);
  expect(d.diff).toContain("--- a/index.html\n+++ b/index.html\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three");
  expect(d.diff).toContain("new file new.md\n--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,1 @@\n+# Hi");
  expect(d.diff).toContain("deleted file old.css\n--- a/old.css\n+++ /dev/null");
  expect(d.diff).toContain("Binary file img.png changed (2 -> 3 bytes)");
  expect(d.diff).not.toContain("same.txt");
  // Changed files first, then added, then deleted.
  expect(d.diff.indexOf("index.html")).toBeLessThan(d.diff.indexOf("new.md"));
  expect(d.diff.indexOf("new.md")).toBeLessThan(d.diff.indexOf("old.css"));
  // One file, or a folder; context lines.
  expect(unifiedDiff(before, after, { path: "./index.html", context: 0 }).diff).toBe("--- a/index.html\n+++ b/index.html\n@@ -2,1 +2,1 @@\n-two\n+2");
  expect(unifiedDiff(before, after, { path: "blog/" }).files).toEqual(["blog/a.md"]);
  expect(unifiedDiff(before, before)).toEqual({ files: [], diff: "" });
  // Past maxChars it stops, and names the files it left out.
  const big = unifiedDiff(files({ "a.txt": "a\n", "b.txt": "b\n" }), files({ "a.txt": "x".repeat(300) + "\n", "b.txt": "y\n" }), { maxChars: 200 });
  expect(big.diff).toContain("a.txt's diff is cut here");
  expect(big.diff).toContain("Not shown: b.txt");
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a description from the model: one request to Sonnet with the diff, its answer cleaned; null when the request fails", async () => {
  const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  let down = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    sent.push({ url: req.url, headers: req.headers, body: await req.json() });
    if (down) return Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 });
    return Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: '"Rewrote the pricing intro."' }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  }) as typeof fetch;
  const changes = { added: [], removed: [], changed: ["index.html"], diff: "-<p>Old</p>\n+<p>New</p>" };
  expect(await Effect.runPromise(describeChange("sk-test", changes))).toBe("Rewrote the pricing intro");
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toStartWith("https://api.anthropic.com/v1/messages");
  expect(sent[0].headers.get("x-api-key")).toBe("sk-test");
  expect(sent[0].body).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 2000, output_config: { effort: "low" } });
  expect(JSON.stringify(sent[0].body.messages)).toContain("Changed: index.html");
  expect(JSON.stringify(sent[0].body.system)).toContain("five words");

  // A failure (here, twice: one retry) is no description: the caller uses the fallback.
  sent.length = 0;
  down = true;
  expect(await Effect.runPromise(describeChange("sk-test", changes))).toBeNull();
  expect(sent).toHaveLength(2);
});
