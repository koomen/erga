// The clipboard: a paste from another app keeps the basic formatting and drops the styles and scripts; a copy or a cut
// writes clean HTML, and Markdown as its plain text, with links and pictures that work outside Erga
// (libs/text/api/clipboard.ts). Two pages: the document in the editor, and the document as a reader has it.
import type { Frame } from "playwright-core";
import { expect, journey, type Page, servers, test, until } from "../helpers/fixtures";
import { F, openEditor, type Editor } from "../helpers/editor";
import * as P from "./clipboard-payloads";

const s = await servers.main();

/** Pastes a payload at the selection, as the browser hands a paste to the page. */
const paste = (ed: Editor, p: P.Payload) =>
  ed.frame(
    `(() => { const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(p.text)}); ${p.html ? `dt.setData("text/html", ${JSON.stringify(p.html)});` : ""} ${F}.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`
  );
/** In a page: selects from the start of one element's text to the end of another's; with `how`, copies it (or cuts it) too. */
const SELECT = `(from, to, how) => {
  const d = document, first = d.createTreeWalker(d.querySelector(from), 4).nextNode(), w = d.createTreeWalker(d.querySelector(to), 4);
  let last = null; for (let t; (t = w.nextNode()); ) if (t.nodeValue.trim()) last = t;
  d.getSelection().setBaseAndExtent(first, 0, last, last.nodeValue.length);
  if (!how) return null;
  const dt = new DataTransfer(); d.querySelector(from).dispatchEvent(new ClipboardEvent(how, { clipboardData: dt, bubbles: true, cancelable: true }));
  return { html: dt.getData("text/html"), text: dt.getData("text/plain") };
}`;
const call = (from: string, to: string, how?: "copy" | "cut") =>
  `(${SELECT})(${JSON.stringify(from)}, ${JSON.stringify(to)}, ${JSON.stringify(how ?? null)})`;
/** In the editor: what a copy (or a cut) of the text from one element to another writes to the clipboard. */
const copy = (ed: Editor, from: string, to: string, how: "copy" | "cut" = "copy") => ed.frame<Required<P.Payload>>(call(from, to, how));
/** The source with its line breaks and indents taken out, between two markers. */
const between = (src: string, a: string, b: string) => src.slice(src.indexOf(a) + a.length, src.indexOf(b)).replace(/\n\s*/g, "");
const TARGET = `<p id="target">Before after.</p>`;

/** A copy of the rich paragraph and the two lists after it: the same for a reader and in the editor. */
const RICH = {
  html: `<p>Some <strong>bold</strong>, <em>italic</em> and <a href="https://example.com/x">a link</a>.<br>A second line.</p><ul><li>Top<ul><li>Inner</li></ul></li><li>Last</li></ul><ol><li>One</li><li>Two</li></ol>`,
  text: "Some **bold**, *italic* and [a link](https://example.com/x).  \nA second line.\n\n- Top\n    - Inner\n- Last\n\n1. One\n2. Two",
};
/** A copy of the paragraph of links, the picture and the last heading, in a document at `doc`: its HTML. */
const linksHtml = (doc: string) =>
  new RegExp(
    `^<p>See <a href="${doc}/other">the other page</a>, <a href="${doc}#rich">the rich part</a> and the notes\\.</p><p><img src="data:image/png;base64,[A-Za-z0-9+/=]+" alt="A dot"></p><h2>The end</h2>$`
  );
/** The document's public address (the viewer's), as a copy's links have it. */
const publicAddress = (page: Page) =>
  page.evaluate<string>(`location.origin + document.querySelector('meta[name="erga-address"]').content`);

/**
 * Cmd+V into a page with nothing but an empty contenteditable, as a mail or a document that the copy is pasted
 * into: what the clipboard has, and what the page got.
 */
async function pasteInto(page: Page): Promise<{ html: string; text: string; pasted: string }> {
  const other = await page.context().newPage();
  // On the app's origin: the clipboard API is for a secure page (about:blank isn't one).
  await other.goto(new URL(page.url()).origin + "/llms.txt");
  await other.setContent(`<div id="box" contenteditable style="min-height:5em"></div>`);
  await other.bringToFront();
  await other.click("#box");
  await other.keyboard.press("ControlOrMeta+v");
  const clip = await other.evaluate(async () => {
    const item = (await navigator.clipboard.read())[0];
    return { html: await (await item.getType("text/html")).text(), text: await (await item.getType("text/plain")).text() };
  });
  const pasted = await other.evaluate(() => document.getElementById("box")!.innerHTML);
  await other.close();
  await page.bringToFront();
  return { ...clip, pasted };
}

/** What each app's payload (clipboard-payloads.ts) becomes at the empty paragraph: the source from there to the page's list. */
const pasted: Record<string, string> = {
  googleDocs: `<h2>Project plan</h2><p>We ship <strong>on Friday</strong><em>, not before</em>. See <a href="https://docs.example.com/spec?id=7&amp;v=2">the spec</a>.</p><p>First line<br>second line</p><ul><li>Milk<ul><li><strong>Oat</strong> milk</li></ul></li><li>Eggs</li></ul><ol><li>Wake up</li><li>Code</li></ol>`,
  word: `<h1>Quarterly review</h1><p>Revenue grew <strong>12%</strong> and churn fell <em>slightly</em>. Details in <a href="https://example.com/q3">the report</a>.</p><ul><li>Hire two engineers<ul><li>Backend</li></ul></li><li>Open the <strong>Berlin</strong> office</li></ul><ol><li>Plan</li><li>Build</li></ol><p id="empty">Kind regards,<br>Ann</p>`,
  // (A list pasted right before the page's list joins it: lists.ts, tidy.)
  pages: `<p id="empty">Notes from <strong>Monday</strong>, with <em>care</em> and colour.</p><p>Second paragraph<br>with a break</p><ul id="list"><li>Apples</li><li>Pears</li>`,
  notion: `<h2>Meeting notes</h2><p>We agreed on <strong>three</strong> things and one <em>maybe</em>. <a href="https://www.notion.so/team/abc123">Link</a> and <code>npm test</code>.</p><ul><li>Ship it<ul><li>tonight</li></ul></li><li>Tell people</li></ul><ol><li>One</li><li>Two</li></ol><blockquote><p>Keep it simple.</p></blockquote>`,
  slack: `<p id="empty">Hey <strong>team</strong>, the deploy is <em>done</em>. Logs: <a href="https://logs.example.com/x">https://logs.example.com/x</a><br>Second line</p><ul><li>step one<ul><li>sub step</li></ul></li><li>step two</li></ul><ol><li>first</li></ol><pre>npm run buildnpm test</pre><blockquote><p>quoted text</p></blockquote>`,
  web: `<h2>Release notes</h2><p>Version 2 is <strong>much</strong> faster and <em>quieter</em>. Read <a href="https://example.com/blog?a=1&amp;b=2">the blog</a>.</p><ul><li>Builds in <strong>half</strong> the time</li><li>Nested:<ul><li>one</li><li>two</li></ul></li></ul><ol><li>First</li><li>Second</li></ol><p id="empty">Line one<br>Line two</p>`,
  plain: `<p id="empty">Dear team,<br>the launch moved to May.</p><p>What to do:</p><ul><li>tell sales<ul><li>today</li></ul></li><li>update the page</li></ul><ol><li>one</li><li>two</li></ol><p>Thanks,<br>Ann</p>`,
};

journey("the clipboard in the editor", () => {
  let ed: Editor;
  let original = "";
  /** The source is the fixture's again (after an undo). */
  const restored = () => expect.poll(() => ed.source()).toBe(original);

  test("Cmd+C and Cmd+V in the browser: the copy pastes back as the same blocks", async ({ tab }) => {
    ed = await openEditor(tab, s, "clipboard");
    original = await ed.source();
    await tab.page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await ed.frame(call("#nested li p", "#nested > li:last-child"));
    await ed.press("ControlOrMeta+c");
    await ed.clickEnd("#empty");
    await ed.press("ControlOrMeta+v");
    // (The items join the page's list right after them: lists.ts, tidy.)
    await expect
      .poll(async () => between(await ed.source(), TARGET, `<li>Alpha</li>`))
      .toBe(`<ul id="list"><li>Top<ul><li>Inner</li></ul></li><li>Last</li>`);
    await ed.press("ControlOrMeta+z");
    await restored();
  });

  test("a paste from Google Docs, Word, Pages, Notion, Slack, a web page or plain text keeps the formatting, not the styles; one undo takes it back", async () => {
    for (const [name, want] of Object.entries(pasted)) {
      await ed.clickEnd("#empty");
      await paste(ed, P[name as keyof typeof P] as P.Payload);
      await ed.idle();
      expect(between(await ed.source(), TARGET, `<li>Alpha</li>`), name).toBe(
        want.includes(`<ul id="list">`) ? want : `${want}<ul id="list">`
      );
      expect(await ed.textOf("main"), name).not.toMatch(/font|mso| /i);
      await ed.press("ControlOrMeta+z");
      await restored();
    }
  });

  test("Cmd+C in the editor, Cmd+V into a plain page: the formatting comes, the page's fonts and colours don't", async () => {
    await ed.frame(call("#rich", "#numbered > li:last-child"));
    await ed.press("ControlOrMeta+c");
    const out = await pasteInto(ed.page);
    expect(out.html).not.toMatch(/style|class|font|color|Georgia|<meta|<span/i);
    expect(out.text).toContain("Some **bold**");
    expect(out.pasted).toContain(`<strong>bold</strong>`);
    expect(out.pasted).toContain(`<a href="https://example.com/x">a link</a>`);
    expect(out.pasted).toMatch(/<ul><li>Top<ul><li>Inner<\/li><\/ul><\/li>/);
    expect(out.pasted).not.toMatch(/Georgia|rgb|#a00|#234|22px|font-size/i);
  });

  test("a copy's links go to the document's public address, its pictures are in it, a link to another file goes; pasted back, #id is #id again", async () => {
    const doc = await publicAddress(ed.page);
    await until(() => ed.frame<boolean>("!!window.__ergaReader.config.address"), 5000, "the viewer says the address");
    const out = await copy(ed, "#links", "#end");
    expect(out.html).toMatch(linksHtml(doc));
    expect(out.text).toBe(`See [the other page](${doc}/other), [the rich part](${doc}#rich) and the notes.\n\n## The end`);
    await ed.clickEnd("#empty");
    await paste(ed, out);
    await ed.idle();
    expect(between(await ed.source(), TARGET, `<ul id="list">`)).toBe(
      `<p id="empty">See <a href="${doc}/other">the other page</a>, <a href="#rich">the rich part</a> and the notes.</p><h2>The end</h2>`
    );
    await ed.press("ControlOrMeta+z");
    await restored();
  });

  test("a copy writes clean HTML and Markdown; pasted back, either gives the same blocks", async () => {
    const out = await copy(ed, "#rich", "#numbered");
    expect(out).toEqual(RICH);
    const back = `<p id="empty">${RICH.html.slice("<p>".length)}`;
    // Back in, at the empty paragraph: the same blocks, and a copy of them gives the same clipboard.
    await ed.clickEnd("#empty");
    await paste(ed, out);
    await ed.idle();
    expect(between(await ed.source(), TARGET, `<ul id="list">`)).toBe(back);
    expect(await copy(ed, "#empty", "main > ol:first-of-type li:last-child")).toEqual(out);
    // The Markdown alone gives the same blocks too.
    await ed.press("ControlOrMeta+z");
    await restored();
    await ed.clickEnd("#empty");
    await paste(ed, { text: out.text });
    await ed.idle();
    expect(between(await ed.source(), TARGET, `<ul id="list">`)).toBe(back);
    await ed.press("ControlOrMeta+z");
    await restored();
  });

  test("bold, italic and a link pasted inside a paragraph stay inline; over a selection they replace it in one step", async () => {
    await ed.selectChars("#target", 6);
    await paste(ed, {
      text: "x",
      html: `<span style="font-family:Comic Sans MS;font-size:30px;color:red">Very <span style="font-weight:bold">loud</span> <a href="javascript:alert(1)">no</a> <a href="https://example.com/">yes</a></span>`,
    });
    await expect
      .poll(async () => between(await ed.source(), "<h1>Clipboard</h1>", `<p id="empty">`))
      .toBe(`<p id="target">Very <strong>loud</strong> no <a href="https://example.com/">yes</a> after.</p>`);
    await ed.press("ControlOrMeta+z");
    await restored();
  });

  test("a cut writes the same clipboard as a copy, and takes the text out", async () => {
    const out = await copy(ed, "#list li", "#list li:last-child", "cut");
    expect(out).toEqual({ html: `<ul><li>Alpha</li><li>Omega</li></ul>`, text: "- Alpha\n- Omega" });
    await expect.poll(() => ed.textOf("#list")).not.toContain("Alpha");
    expect(await ed.textOf("#list")).not.toContain("Omega");
  });
});

/** The document's page in the viewer's frame, out of the editor. */
const readerFrame = (page: Page) =>
  until<Frame | null>(
    async () => {
      const f = page.frames().find((f) => f.parentFrame() == page.mainFrame() && /\/t\//.test(f.url())) ?? null;
      return f && (await f.evaluate("!!window.__ergaReader?.config.address").catch(() => false)) ? f : null;
    },
    10_000,
    "the page in the viewer, with the document's address"
  );

test("a reader's copy (out of the editor) is the editor's: clean HTML, Markdown, links and pictures that work elsewhere", async ({
  tab,
}) => {
  const { address } = await s.fixture("clipboard");
  tab.strict = true;
  await tab.page.goto(address);
  const frame = (await readerFrame(tab.page))!;
  const doc = await publicAddress(tab.page);
  /** What the reader's copy of the text from one element to another writes to the clipboard. */
  const copied = (from: string, to: string) => frame.evaluate(call(from, to, "copy")) as Promise<Required<P.Payload>>;
  expect(await copied("#rich", "#numbered")).toEqual(RICH);
  const links = await copied("#links", "#end");
  expect(links.html).toMatch(linksHtml(doc));
  // Cmd+C and Cmd+V into a plain page: none of the page's fonts and colours.
  await tab.page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await frame.click("#numbered li");
  await frame.evaluate(call("#rich", "#numbered > li:last-child"));
  await tab.page.keyboard.press("ControlOrMeta+c");
  const out = await pasteInto(tab.page);
  expect(out.html).not.toMatch(/style|class|font|color|Georgia|<span/i);
  expect(out.pasted).toContain(`<strong>bold</strong>`);
  expect(out.pasted).not.toMatch(/Georgia|rgb|22px|font-size/i);
});
