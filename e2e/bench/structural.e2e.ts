// What a structural key costs in the page editor, by document size: Enter at the end of a paragraph and the
// Backspace that joins it back, Tab in a list item and the Shift+Tab that takes it back. Not a test of behaviour, and
// in no suite (run it by name: `bun run test:e2e e2e/bench/structural.e2e.ts`). For each key, 20 times: the frame's
// work for the key (median, ms), the DOM mutations it makes, and the time spent in the analysis and in reconcile (client/page-editor/mirror.ts).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { servers, test } from "../helpers/fixtures";
import { editor, F } from "../helpers/editor";

function documentOf(bytes: number): string {
  const head = `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Bench</title>\n  <style>body { font: 16px/1.5 system-ui; max-width: 40em; margin: 2em auto; }</style>\n</head>\n<body>\n  <main>\n    <h1>Benchmark document</h1>\n`;
  const tail = `  </main>\n  <script>document.title = document.title;</script>\n</body>\n</html>\n`;
  let body = "",
    i = 0;
  while (head.length + body.length + tail.length < bytes) {
    i++;
    body +=
      `    <section id="s${i}">\n      <h2>Section ${i}: what changed</h2>\n` +
      `      <p>Paragraph ${i} has <em>emphasis</em>, <strong>strong text</strong>, <a href="https://example.com/${i}">a link</a> and <code>code()</code> in it, &amp; an entity.</p>\n` +
      `      <p>The second paragraph of section ${i} is plain text that goes on for a while, as prose does, so the page has some length to it.</p>\n` +
      `      <ul>\n        <li>First item of ${i}</li>\n        <li>A <b>bold</b> item</li>\n        <li>Last item</li>\n      </ul>\n` +
      `    </section>\n`;
  }
  return head + body + tail;
}

for (const [name, bytes] of [
  ["5 KB", 5_000],
  ["200 KB", 200_000],
  ["1 MB", 1_000_000],
] as const) {
  test(`structural keys in a ${name} document`, { timeout: 300_000 }, async ({ tab }) => {
    const server = await servers.main();
    const { dir, address } = await server.fixture("page");
    writeFileSync(join(dir, "index.html"), documentOf(bytes));
    // The check that the page shows its HTML, after each key (client/page-editor/check.ts): its reports are printed.
    await tab.page.addInitScript(() => {
      if (window.top == window) (window as { __ergaCheck?: boolean }).__ergaCheck = true;
    });
    await tab.page.goto(`${address}?edit`);
    const ed = editor(tab.page, { address, dir, file: join(dir, "index.html") });
    await ed.loaded();
    const n = await ed.frame<number>(`${F}.querySelectorAll("section").length`);
    const mid = Math.max(1, Math.floor(n / 2));
    const run = async (sel: string, a: string, b: string) => {
      await ed.clickEnd(sel);
      await ed.settle();
      return ed.frame<unknown>(`(async () => {
        const ef = window.ergaFrame, page = ef.page;
        const t = { analyze: 0, reconcile: 0, renders: 0, analyzeN: 0 };
        const wrap = (k, f) => { const o = page[k].bind(page); page[k] = (...x) => { const t0 = performance.now(); try { return o(...x); } finally { f(performance.now() - t0); } }; return o; };
        const oa = wrap("analyze", (d) => { t.analyze += d; t.analyzeN++; });
        const orc = wrap("reconcile", (d) => { t.reconcile += d; });
        const keys = ["dispatch", "applyChanges", "keepView", "syncDOMSelection", "notify", "changed", "carrySrc", "paintMarks", "scrollCaretIntoView", "updateEmpty", "recordAuthorship", "mapMarks"];
        const each = {}; const olds = keys.map((k) => wrap(k, (d) => { each[k] = (each[k] ?? 0) + d; }));
        const orr = page.render.bind(page); page.render = () => { t.renders++; };
        let muts = 0; const mo = new MutationObserver((r) => { muts += r.length; });
        mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        const acked = () => new Promise((done) => { const check = () => { if (ef.relay.idle) { window.removeEventListener("message", check); done(); } }; window.addEventListener("message", check); check(); });
        const next = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        const A = [], B = [], MA = [], MB = [];
        for (let i = 0; i < 20; i++) {
          await next(); muts = 0; mo.takeRecords();
          let t0 = performance.now(); ${a}; A.push(performance.now() - t0); await acked(); MA.push(muts + mo.takeRecords().length);
          await next(); muts = 0;
          t0 = performance.now(); ${b}; B.push(performance.now() - t0); await acked(); MB.push(muts + mo.takeRecords().length);
        }
        keys.forEach((k, i) => (page[k] = olds[i])); page.reconcile = orc;
        page.analyze = oa; page.render = orr; mo.disconnect();
        const med = (x) => [...x].sort((p, q) => p - q)[x.length >> 1].toFixed(2);
        return { a: med(A), b: med(B), mutA: med(MA), mutB: med(MB), perOp: { analyze: (t.analyze / 40).toFixed(2), analyzeN: t.analyzeN, reconcile: (t.reconcile / 40).toFixed(2), renders: t.renders, each: Object.fromEntries(Object.entries(each).map(([k, v]) => [k, (v / 40).toFixed(2)])) } };
      })()`);
    };
    const enter = await run(`#s${mid} p:nth-of-type(2)`, "page.enter(false)", "page.deleteChar(false)");
    const tabk = await run(`#s${mid} li:nth-of-type(2)`, "page.indentItem(false)", "page.indentItem(true)");
    console.log(`structural ${name}:`, JSON.stringify({ enterThenBackspace: enter, tabThenShiftTab: tabk }));
    const drift = tab.errors.filter((e) => e.includes("does not show its HTML"));
    console.log(
      `structural ${name}: ${drift.length} differences between the page and its HTML${drift.length ? `:\n${drift.slice(0, 5).join("\n")}` : ""}`
    );
  });
}
