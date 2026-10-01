// The basics: joining, live edits both ways, new files, what's served and
// what's stored, and edits that arrive as files.

import { converged, Participant } from "../client";
import { expect, sleep, until, type Test } from "../harness";

const STORE_MS = 5000;

export const sync: Test[] = [
  {
    name: "a participant joining gets the document as stored",
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      expect(a.str() == d.fixture[d.path], "Ada's text is the fixture", { got: a.str().slice(0, 200) });
      for (const p of Object.keys(d.fixture).filter((p) => /\.(html|css|js|md)$/.test(p))) expect(a.str(p) == d.fixture[p], `the room holds ${p} as text`);
      expect(!!a.epoch, "the room names its epoch");
    },
  },
  {
    name: "edits reach everyone, both ways",
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await Participant.join(d, "Ada"), await Participant.join(d, "Bo")];
      ctx.defer(() => { a.destroy(); b.destroy(); });
      a.insertAfter("<h1>", "Ada was here: ");
      await until(() => b.str().includes("Ada was here: "), 3000, "Bo sees Ada's edit");
      b.insertAfter("</h1>", "<!-- Bo -->");
      await until(() => a.str().includes("<!-- Bo -->"), 3000, "Ada sees Bo's edit");
      await converged([a, b], 3000);
    },
  },
  {
    name: "the page is served the room's latest text, before it's stored",
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      a.insertAfter("<h1>", "Served ");
      await until(async () => (await d.served(d.path))?.includes("<h1>Served "), 2000, "/doc/ serves the edit");
    },
  },
  {
    name: "the room writes edits back to storage, and stops writing when idle",
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      for (let i = 0; i < 20; i++) { a.insertAfter("<h1>", String(i % 10)); await sleep(15); }
      await until(async () => (await d.stored(d.path))?.text == a.str(), STORE_MS, "storage has every edit", async () => ({ stored: (await d.stored(d.path))?.text.slice(0, 120), room: a.str().slice(0, 120) }));
      const tag = (await d.stored(d.path))!.etag;
      await sleep(d.writeDelay * 3);
      expect((await d.stored(d.path))!.etag == tag, "no further writes once nothing changes");
    },
  },
  {
    name: "a new file made by one participant reaches the others and storage",
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await Participant.join(d, "Ada"), await Participant.join(d, "Bo")];
      ctx.defer(() => { a.destroy(); b.destroy(); });
      const name = `notes/new-${ctx.seed}-${Date.now()}.md`;
      a.createFile(name, "# Hello\n");
      await until(() => b.str(name) == "# Hello\n", 3000, "Bo has the new file");
      await until(async () => (await d.stored(name))?.text == "# Hello\n", STORE_MS, "storage has the new file");
      expect((await d.served(name)) == "# Hello\n", "and it's served");
    },
  },
  {
    name: "a stylesheet is edited like the page",
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      expect(a.paths().includes("style.css"), "the room holds style.css");
      a.insert(a.str("style.css").length, "\nh1 { letter-spacing: 1px; }\n", "style.css");
      await until(async () => (await d.served("style.css"))?.includes("letter-spacing: 1px"), 2000, "served");
      await until(async () => (await d.stored("style.css"))?.text.includes("letter-spacing: 1px"), STORE_MS, "stored");
    },
  },
  {
    name: "an edit arriving as a file merges with live edits it didn't know about",
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await Participant.join(d, "Ada"), await Participant.join(d, "Bo")];
      ctx.defer(() => { a.destroy(); b.destroy(); });
      const base = (await d.stored(d.path))!;
      // Live, not yet stored:
      a.insertAfter("<h1>", "LIVE ");
      // A publish made from the stored version, changing something else:
      const pushed = base.text.replace("Where the leads go.", "Where the leads went.");
      expect(pushed != base.text, "the fixture has the sentence to change");
      const r = await d.push(d.path, pushed, base.etag);
      expect(r.ok, `the push is taken (${r.status})`, await r.text());
      await until(() => b.str().includes("leads went.") && b.str().includes("LIVE "), 3000, "Bo has both");
      await converged([a, b], 3000);
      await until(async () => { const s = (await d.stored(d.path))?.text ?? ""; return s.includes("leads went.") && s.includes("LIVE "); }, STORE_MS, "storage has both");
      const fromFile = b.seen.find((s) => s.inserted.includes("went"));
      expect(fromFile?.kind == "disk", "the file's edit is attributed to storage, not a person", b.seen);
    },
  },
  {
    name: "a push based on an old version is refused, not merged backwards",
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      const old = (await d.stored(d.path))!;
      a.insertAfter("<h1>", "NEWER ");
      await until(async () => (await d.stored(d.path))?.text.includes("NEWER "), STORE_MS, "the newer edit is stored");
      const r = await d.push(d.path, old.text.replace("<h1>", "<h1>STALE "), old.etag);
      expect(r.status == 412, `a stale If-Match gets 412 (got ${r.status})`);
      await sleep(300);
      expect(a.str().includes("NEWER ") && !a.str().includes("STALE "), "the room is untouched");
    },
  },
  {
    name: "publishes landing just as the room writes are never lost",
    timeoutMs: 90_000,
    slow: true,
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      const expected: string[] = [];
      let retries = 0;
      for (let i = 0; i < (ctx.long ? 60 : 16); i++) {
        const live = `⟦live${i}⟧`, pub = `⟦pub${i}⟧`;
        a.insertAfter("<h1>", live);
        expected.push(live);
        // Aim the publish at the room's write, writeDelay after the edit.
        await sleep(d.writeDelay * 0.9 + ctx.rng.int(Math.max(10, d.writeDelay * 0.2)));
        for (;;) {
          const s = (await d.stored(d.path))!;
          const r = await d.push(d.path, s.text.replace("</h1>", pub + "</h1>"), s.etag);
          if (r.ok) break;
          expect(r.status == 412, `taken or stale (got ${r.status})`);
          retries++;
        }
        expected.push(pub);
      }
      await until(async () => { const t = (await d.stored(d.path))?.text ?? ""; return t == a.str(); }, STORE_MS, "storage settles");
      const missing = expected.filter((t) => !a.str().includes(t));
      expect(!missing.length, "every live edit and every publish is there", missing);
      ctx.metric("stale retries", retries, "");
    },
  },
  {
    name: "an edit made directly on disk reaches participants",
    needs: ["disk"],
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      d.writeDisk!(d.path, d.fixture[d.path].replace("<h1>", "<h1>DISK "));
      await until(() => a.str().includes("<h1>DISK "), 3000, "Ada sees the disk edit");
      expect(a.seen.at(-1)?.kind == "disk", "attributed to the disk", a.seen);
    },
  },
  {
    name: "a changed image updates its versioned reference",
    needs: ["disk"],
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      const assets = a.ydoc.getMap<string>("assets");
      d.writeDisk!("pic.png", new Uint8Array([137, 80, 78, 71, 1]));
      await until(() => assets.has("pic.png"), 3000, "the new image appears in assets");
      const h = assets.get("pic.png");
      d.writeDisk!("pic.png", new Uint8Array([137, 80, 78, 71, 2]));
      await until(() => assets.get("pic.png") != h, 3000, "its hash changes when it does");
    },
  },
];
