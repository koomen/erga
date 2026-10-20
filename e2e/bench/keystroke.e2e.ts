// What one keystroke costs in the page editor, by document size: not a test of
// behaviour, and in no suite (run it by name: `bun run test:e2e e2e/bench/keystroke.e2e.ts`).
//
// For each size, a generated HTML document opens in the editor, the caret goes
// to the end of a paragraph in its middle, and the frame types (and deletes)
// one character at a time through the page editor's own entry points
// (insertText, deleteChar: what beforeinput calls). The times for each key:
//
//   frame      the page editor's work for the key, from the call to its return:
//              the transaction, the page patched, the change offered to the shell
//   accept     from the call until the shell has taken the change (its ack is
//              back): the frame's work, the message, the shell's state and the
//              room's Yjs transaction
//   nextFrame  the work the key leaves for the next animation frame, in the
//              frame (the shell's snapshot, the marks) and in the shell (the
//              caret sent to the room, the others' carets, the format bar)
//   message    the shell's handler for the change the frame offers
//   remote     the frame's work for a key someone else types (a second tab,
//              in the same paragraph): the change patched into the page
//
// The medians and 95th percentiles go to the output and to
// .e2e/keystroke-bench.json (BENCH_OUT names another file).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { servers, test, until } from "../fixtures";
import { editor, F } from "../editor";

await servers.main();

/** A document of about `bytes`: sections of headings, paragraphs with inline markup and entities, lists, tables. */
function documentOf(bytes: number): string {
  const head = `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Bench</title>\n  <style>body { font: 16px/1.5 system-ui; max-width: 40em; margin: 2em auto; }</style>\n</head>\n<body>\n  <main>\n    <h1>Benchmark document</h1>\n`;
  const tail = `  </main>\n  <script>document.title = document.title;</script>\n</body>\n</html>\n`;
  let body = "", i = 0;
  while (head.length + body.length + tail.length < bytes) {
    i++;
    body += `    <section id="s${i}">\n      <h2>Section ${i}: what changed</h2>\n` +
      `      <p>Paragraph ${i} has <em>emphasis</em>, <strong>strong text</strong>, <a href="https://example.com/${i}">a link</a> and <code>code()</code> in it, &amp; an entity.</p>\n` +
      `      <p>The second paragraph of section ${i} is plain text that goes on for a while, as prose does, so the page has some length to it.</p>\n` +
      `      <ul>\n        <li>First item of ${i}</li>\n        <li>A <b>bold</b> item</li>\n        <li>Last item</li>\n      </ul>\n` +
      (i % 4 == 0 ? `      <table>\n        <tr><th>Name</th><th>Value</th></tr>\n        <tr><td>alpha</td><td>${i}</td></tr>\n      </table>\n` : "") +
      `    </section>\n`;
  }
  return head + body + tail;
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { median: +at(0.5).toFixed(3), p95: +at(0.95).toFixed(3), n: s.length };
};

const results: Record<string, unknown> = {};
const out = process.env.BENCH_OUT ?? join(import.meta.dirname, "../../.e2e/keystroke-bench.json");

for (const [name, bytes] of [["5 KB", 5_000], ["200 KB", 200_000], ["1 MB", 1_000_000]] as const) {
  test(`one keystroke in a ${name} document`, { timeout: 180_000 }, async ({ tab }) => {
    const server = await servers.main();
    const { dir, address } = await server.fixture("page");
    writeFileSync(join(dir, "index.html"), documentOf(bytes));
    await tab.page.goto(`${address}?edit`);
    const ed = editor(tab.page, { address, dir, file: join(dir, "index.html") });
    await ed.loaded();
    // The caret at the end of the middle section's first paragraph.
    const n = await ed.frame<number>(`${F}.querySelectorAll("section").length`);
    const mid = Math.max(1, Math.floor(n / 2));
    await ed.clickEnd(`#s${mid} p:nth-of-type(2)`);
    await ed.settle();
    const KEYS = 150;
    // The shell's work for each change the frame offers: its message handler, timed from a listener before it to one after it.
    await ed.eval(`(() => {
      window.__shell = [];
      let t0 = 0;
      window.addEventListener("message", (e) => { if (e.data?.type == "push") t0 = performance.now(); }, true);
      window.addEventListener("message", (e) => { if (e.data?.type == "push") window.__shell.push(performance.now() - t0); });
      // And what it leaves for its next frame (your caret for the room, the others' carets, the format bar), by frame.
      window.__shellRaf = new Map();
      const plain = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (f) => plain((t) => { const t0 = performance.now(); try { f(t); } finally { window.__shellRaf.set(t, (window.__shellRaf.get(t) ?? 0) + performance.now() - t0); } });
    })()`);
    const r = await ed.frame<{ frame: number[]; accept: number[]; delFrame: number[]; delAccept: number[]; later: number[] }>(`(async () => {
      const ef = window.ergaFrame, page = ef.page;
      // The work the key leaves for the next frame (the shell's controls, the marks): every animation-frame callback, timed.
      let raf = 0;
      const plain = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (f) => plain((t) => { const t0 = performance.now(); try { f(t); } finally { raf += performance.now() - t0; } });
      const later = [];
      const acked = () => new Promise((done) => {
        const check = () => { if (ef.relay.idle) { window.removeEventListener("message", check); done(); } };
        window.addEventListener("message", check);
        check();
      });
      const frame = [], accept = [], delFrame = [], delAccept = [];
      const next = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      for (let i = 0; i < ${KEYS}; i++) {
        await next();
        if (i) later.push(raf);
        raf = 0;
        const t0 = performance.now();
        page.insertText("abcdefghij"[i % 10], null);
        const t1 = performance.now();
        await acked();
        frame.push(t1 - t0); accept.push(performance.now() - t0);
      }
      for (let i = 0; i < ${KEYS}; i++) {
        await next();
        const t0 = performance.now();
        page.deleteChar(false);
        const t1 = performance.now();
        await acked();
        delFrame.push(t1 - t0); delAccept.push(performance.now() - t0);
      }
      window.requestAnimationFrame = plain;
      return { frame, accept, delFrame, delAccept, later };
    })()`);
    const shell = await ed.eval<number[]>("window.__shell");
    const shellNext = await ed.eval<number[]>("[...window.__shellRaf.values()]");

    // Someone else types in the same paragraph (a second tab): what each of their keys costs this tab's frame.
    await ed.frame(`(() => {
      const page = window.ergaFrame.page, plain = page.applyExternal.bind(page);
      window.__remote = [];
      page.applyExternal = (c, a) => { const t0 = performance.now(); plain(c, a); window.__remote.push(performance.now() - t0); };
    })()`);
    const other = editor(await tab.page.context().newPage(), { address, dir, file: join(dir, "index.html") });
    await other.page.goto(`${address}?edit`);
    await other.loaded();
    await other.clickEnd(`#s${mid} p:nth-of-type(2)`);
    await other.frame(`(async () => {
      const page = window.ergaFrame.page;
      for (let i = 0; i < ${KEYS}; i++) { await new Promise((r) => setTimeout(r, 15)); page.insertText("xyz"[i % 3], null); }
    })()`);
    const remote = (await until(async () => { const r = await ed.frame<number[]>("window.__remote"); return r.length >= KEYS ? r : null; }, 30_000, "the other tab's keys"))!;
    await other.page.close();

    results[name] = {
      bytes,
      type: { frame: stats(r.frame), accept: stats(r.accept), nextFrame: stats(r.later) },
      delete: { frame: stats(r.delFrame), accept: stats(r.delAccept) },
      shell: { message: stats(shell), nextFrame: stats(shellNext) },
      remote: stats(remote),
    };
    console.log(`keystroke ${name}: ${JSON.stringify(results[name])}`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(results, null, 2));
  });
}
