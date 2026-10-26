// Paste in and copy out keep the basic formatting and drop the rest (client/page-editor/clipboard-html.ts): paragraphs, line breaks,
// bold, italic, links, lists (nested), headings, quotes and code; never fonts, sizes, colours, classes or styles.
import { expect, servers, test } from "../../fixtures";
import { F, openEditor, type Editor } from "../../editor";
import * as P from "./clipboard-payloads";

await servers.main();

/** Pastes a payload at the selection, as the browser hands a paste to the page. */
const paste = (ed: Editor, p: P.Payload) => ed.frame(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(p.text)}); ${p.html ? `dt.setData("text/html", ${JSON.stringify(p.html)});` : ""} ${F}.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
/** Selects from the start of one element's text to the end of another's, and copies it (or cuts it). */
const copy = (ed: Editor, from: string, to: string, how = "copy") => ed.frame<P.Payload>(`(() => {
  const d = ${F}, first = d.createTreeWalker(d.querySelector(${JSON.stringify(from)}), 4).nextNode(), w = d.createTreeWalker(d.querySelector(${JSON.stringify(to)}), 4);
  let last = null; for (let t; (t = w.nextNode()); ) if (t.nodeValue.trim()) last = t;
  d.getSelection().setBaseAndExtent(first, 0, last, last.nodeValue.length);
  const dt = new DataTransfer(); d.querySelector(${JSON.stringify(from)}).dispatchEvent(new ClipboardEvent(${JSON.stringify(how)}, { clipboardData: dt, bubbles: true, cancelable: true }));
  return { html: dt.getData("text/html"), text: dt.getData("text/plain") };
})()`);
/** The source with its line breaks and indents taken out, between two markers. */
const between = (src: string, a: string, b: string) => src.slice(src.indexOf(a) + a.length, src.indexOf(b)).replace(/\n\s*/g, "");

const pasted: Record<string, string> = {
  googleDocs: `<h2>Project plan</h2><p>We ship <strong>on Friday</strong><em>, not before</em>. See <a href="https://docs.example.com/spec?id=7&amp;v=2">the spec</a>.</p><p>First line<br>second line</p><ul><li><p>Milk</p><ul><li><strong>Oat</strong> milk</li></ul></li><li>Eggs</li></ul><ol><li>Wake up</li><li>Code</li></ol>`,
  word: `<h1>Quarterly review</h1><p>Revenue grew <strong>12%</strong> and churn fell <em>slightly</em>. Details in <a href="https://example.com/q3">the report</a>.</p><ul><li><p>Hire two engineers</p><ul><li>Backend</li></ul></li><li>Open the <strong>Berlin</strong> office</li></ul><ol><li>Plan</li><li>Build</li></ol><p id="empty">Kind regards,<br>Ann</p>`,
  pages: `<p id="empty">Notes from <strong>Monday</strong>, with <em>care</em> and colour.</p><p>Second paragraph<br>with a break</p><ul><li>Apples</li><li>Pears</li></ul>`,
  notion: `<h2>Meeting notes</h2><p>We agreed on <strong>three</strong> things and one <em>maybe</em>. <a href="https://www.notion.so/team/abc123">Link</a> and <code>npm test</code>.</p><ul><li><p>Ship it</p><ul><li>tonight</li></ul></li><li>Tell people</li></ul><ol><li>One</li><li>Two</li></ol><blockquote><p>Keep it simple.</p></blockquote>`,
  slack: `<p id="empty">Hey <strong>team</strong>, the deploy is <em>done</em>. Logs: <a href="https://logs.example.com/x">https://logs.example.com/x</a><br>Second line</p><ul><li><p>step one</p><ul><li>sub step</li></ul></li><li>step two</li></ul><ol><li>first</li></ol><pre>npm run buildnpm test</pre><blockquote><p>quoted text</p></blockquote>`,
  web: `<h2>Release notes</h2><p>Version 2 is <strong>much</strong> faster and <em>quieter</em>. Read <a href="https://example.com/blog?a=1&amp;b=2">the blog</a>.</p><ul><li>Builds in <strong>half</strong> the time</li><li><p>Nested:</p><ul><li>one</li><li>two</li></ul></li></ul><ol><li>First</li><li>Second</li></ol><p id="empty">Line one<br>Line two</p>`,
  plain: `<p id="empty">Dear team,<br>the launch moved to May.</p><p>What to do:</p><ul><li><p>tell sales</p><ul><li>today</li></ul></li><li>update the page</li></ul><ol><li>one</li><li>two</li></ol><p>Thanks,<br>Ann</p>`,
};

test("a paste from Google Docs, Word, Pages, Notion, Slack, a web page or plain text keeps the formatting, not the styles; one undo takes it back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "clipboard");
  const original = await ed.source();
  for (const [name, want] of Object.entries(pasted)) {
    await ed.clickEnd("#empty");
    await paste(ed, P[name as keyof typeof P] as P.Payload);
    await ed.idle();
    const src = await ed.source();
    expect(between(src, `<p id="target">Before after.</p>`, `<ul id="list">`), name).toBe(want);
    expect(await ed.textOf("main"), name).not.toMatch(/font|mso| /i);
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toBe(original);
  }
});

test("paragraphs pasted in the middle of a paragraph split it; into a list they are items; into a table cell, lines", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "clipboard");
  const original = await ed.source();
  // "Before |after." with two paragraphs: the first ends the first half, the second starts the second.
  await ed.selectChars("#target", 7);
  await ed.press("ArrowRight");
  await paste(ed, { text: "one\n\ntwo **x**", html: `<p>one <b>bold</b></p><p>two</p>` });
  await expect.poll(async () => between(await ed.source(), "<h1>Clipboard</h1>", `<p id="empty">`)).toBe(`<p id="target">Before one <strong>bold</strong></p><p>twoafter.</p>`);
  await ed.type("!");
  await expect.poll(() => ed.textOf("main > p:nth-of-type(2)")).toBe("two!after.");
  await ed.press("ControlOrMeta+z");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
  // At the end of "Alpha": plain text paragraphs and a list's items join the list.
  await ed.clickEnd("#list li");
  await paste(ed, { text: "Beta\n\nGamma\n- Delta\n  - Epsilon" });
  await expect.poll(async () => between(await ed.source(), `<ul id="list">`, `<p id="rich"`)).toBe(`<li>AlphaBeta</li><li>Gamma</li><li><p>Delta</p><ul><li>Epsilon</li></ul></li><li>Omega</li></ul>`);
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
  // A table cell can't split: the paragraphs are lines in it.
  await ed.clickEnd("#cell");
  await paste(ed, { text: "a\n\nb", html: `<p>a</p><ul><li><em>b</em></li></ul>` });
  await expect.poll(async () => between(await ed.source(), `<td id="cell">`, `</td>`)).toBe(`Cella<br><em>b</em>`);
});

test("bold, italic and a link pasted inside a paragraph stay inline; over a selection they replace it in one step", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "clipboard");
  const original = await ed.source();
  await ed.selectChars("#target", 6);
  await paste(ed, { text: "x", html: `<span style="font-family:Comic Sans MS;font-size:30px;color:red">Very <span style="font-weight:bold">loud</span> <a href="javascript:alert(1)">no</a> <a href="https://example.com/">yes</a></span>` });
  await expect.poll(async () => between(await ed.source(), "<h1>Clipboard</h1>", `<p id="empty">`)).toBe(`<p id="target">Very <strong>loud</strong> no <a href="https://example.com/">yes</a> after.</p>`);
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
});

test("a copy writes clean HTML and plain text with the line breaks and list markers; pasted back, it gives the same blocks", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "clipboard");
  const out = await copy(ed, "#rich", "#numbered");
  expect(out.html).toBe(`<p>Some <strong>bold</strong>, <em>italic</em> and <a href="https://example.com/x">a link</a>.<br>A second line.</p><ul><li>Top<ul><li>Inner</li></ul></li><li>Last</li></ul><ol><li>One</li><li>Two</li></ol>`);
  expect(out.text).toBe("Some bold, italic and a link.\nA second line.\n\n- Top\n  - Inner\n- Last\n\n1. One\n2. Two");
  // Back in, at the empty paragraph: the same blocks, and a copy of them gives the same clipboard.
  await ed.clickEnd("#empty");
  await paste(ed, out);
  await ed.idle();
  expect(between(await ed.source(), `<p id="target">Before after.</p>`, `<ul id="list">`)).toBe(`<p id="empty">Some <strong>bold</strong>, <em>italic</em> and <a href="https://example.com/x">a link</a>.<br>A second line.</p><ul><li><p>Top</p><ul><li>Inner</li></ul></li><li>Last</li></ul><ol><li>One</li><li>Two</li></ol>`);
  expect(await copy(ed, "#empty", "main > ol:first-of-type li:last-child")).toEqual(out);
  // The plain text alone gives the same blocks too, but the link (it has only the link's text).
  await ed.press("ControlOrMeta+z");
  await ed.clickEnd("#empty");
  await paste(ed, { text: out.text });
  await ed.idle();
  expect(between(await ed.source(), `<p id="target">Before after.</p>`, `<ul id="list">`)).toBe(`<p id="empty">Some bold, italic and a link.<br>A second line.</p><ul><li><p>Top</p><ul><li>Inner</li></ul></li><li>Last</li></ul><ol><li>One</li><li>Two</li></ol>`);
});

test("a cut writes the same clipboard as a copy, and takes the text out", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "clipboard");
  const out = await copy(ed, "#list li", "#list li:last-child", "cut");
  expect(out).toEqual({ html: `<ul><li>Alpha</li><li>Omega</li></ul>`, text: "- Alpha\n- Omega" });
  await expect.poll(() => ed.textOf("#list")).not.toContain("Alpha");
});

test("Cmd+C and Cmd+V in the browser: the copy pastes back as the same blocks", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "clipboard");
  await tab.page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await ed.frame(`(() => { const d = ${F}, a = d.querySelector("#nested li p").firstChild, b = d.querySelector("#nested > li:last-child").firstChild; d.getSelection().setBaseAndExtent(a, 0, b, b.nodeValue.length); })()`);
  await ed.press("ControlOrMeta+c");
  await ed.clickEnd("#empty");
  await ed.press("ControlOrMeta+v");
  await expect.poll(async () => between(await ed.source(), `<p id="target">Before after.</p>`, `<ul id="list">`)).toBe(`<ul><li><p>Top</p><ul><li>Inner</li></ul></li><li>Last</li></ul>`);
});
