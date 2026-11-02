// erga/text's API: the named edits on a page's HTML that a person's keys make, as an agent (or any caller) asks for
// them. Each edit takes a page's HTML and its input, and gives the changes to the HTML, or refuses with a reason. No
// browser: the document's object runs them for an agent's call_edit (agents/document/tools.ts), on the page's text as it
// is in the room. The editor's own keys go through the same rules (rules.ts, format.ts).
//
// An edit names where it acts by the element that holds the text (`selector`, a CSS selector as the source has it:
// "h1", "#intro", "ul li:nth-of-type(2)") and, inside it, a piece of its text as a person reads it (`find`, `after`,
// `before`), or its start or end (`at`).
//
// This is the standard shape of a document's API (DocumentApi): its edits, each with a description and the JSON Schema
// of its input, and `apply`. A page with its own editor gives one the same way.

import * as M from "../../../shared/manuscript";
import { findInSource } from "../../../shared/source-select";
import { rules, type Page } from "./rules";
import { applyLink, clearStyles, hasStyle, toggleStyle } from "./format";
import { fromText, toSource } from "./clipboard";
import { HEADING, type InlineStyle } from "./source";
import type { Change } from "./lists";

/** A JSON Schema, as an edit's input is described. */
export type JsonSchema = Record<string, unknown>;

/** What an edit gives: the changes to the page's HTML (against the HTML it was given), and what it did, or why not. */
export type EditResult = { changes: { from: number; to: number; insert: string }[]; done: string } | { refused: string };

/** A document's API: its edits, and the one way to run them. */
export interface DocumentApi {
  name: string;
  description: string;
  edits: { name: string; description: string; input: JsonSchema }[];
  apply(html: string, path: string, edit: string, input: unknown): EditResult;
}

// ------------------------------------------------------------------ where an edit acts

const str = (description: string): JsonSchema => ({ type: "string", description });
const SELECTOR = str(
  'The element that holds the text, as a CSS selector of the source ("h1", "#intro", "ul li:nth-of-type(2)"); it must match one.'
);
const FIND = str("The text to act on, as a person reads it in that element (no tags); it must be there once.");
const PLACE = {
  at: { type: "string", enum: ["start", "end"], description: "The start or the end of the element's text." },
  after: str("Or: right after this text of the element (as a person reads it)."),
  before: str("Or: right before this text of the element."),
};

type Input = Record<string, unknown>;

/** The page's text blocks in the element `selector` names, and its own range; or why there are none. */
function scope(page: Page, path: string, selector: unknown): { units: M.Unit[]; from: number; to: number } | string {
  if (typeof selector != "string" || !selector.trim()) return "Give the selector of the element that holds the text.";
  const found = findInSource(page.src, path, { selector });
  if (typeof found == "string") return found;
  let units = page.units.filter((u) => u.from >= found.from && u.to <= found.to);
  // An element inside a block of text (a <strong> in a paragraph): that block, its range the element's.
  if (!units.length) units = page.units.filter((u) => u.from <= found.from && found.to <= u.to);
  return units.length ? { units, from: found.from, to: found.to } : `"${selector}" holds no text a person can edit.`;
}

/** The text of a scope as a person reads it (its blocks one per line), and the source position of each place in it. */
function reading(s: { units: M.Unit[]; from: number; to: number }): { text: string; pos(k: number): number } {
  const parts: { run: M.TextRun; start: number }[] = [];
  let text = "";
  for (const [i, u] of s.units.entries()) {
    if (i) text += "\n";
    for (const run of u.runs) {
      if (!run.editable || run.to <= s.from || run.from >= s.to) continue;
      parts.push({ run, start: text.length });
      text += run.text;
    }
  }
  const pos = (k: number) => {
    const p = parts.find((x) => k >= x.start && k <= x.start + x.run.text.length) ?? parts[parts.length - 1];
    return M.runPos(p.run, Math.max(0, Math.min(p.run.text.length, k - p.start)));
  };
  return { text, pos };
}

/** The source range of a piece of a scope's text, found once; or why not. */
function rangeOf(page: Page, path: string, input: Input, key = "find"): { from: number; to: number; units: M.Unit[] } | string {
  const s = scope(page, path, input.selector);
  if (typeof s == "string") return s;
  const quote = input[key];
  if (typeof quote != "string" || !quote) return `Give ${key}: the text to act on.`;
  const { text, pos } = reading(s);
  const at = text.indexOf(quote);
  if (at < 0) return `"${quote}" isn't in the text of ${input.selector}, which reads: "${text.slice(0, 300)}".`;
  if (text.indexOf(quote, at + 1) >= 0) return `"${quote}" is in the text of ${input.selector} more than once: give more of it.`;
  return { from: pos(at), to: pos(at + quote.length), units: s.units };
}

/** The source position of a place in a scope (at, after, before); or why not. */
function placeOf(page: Page, path: string, input: Input): number | string {
  const s = scope(page, path, input.selector);
  if (typeof s == "string") return s;
  const given = ["at", "after", "before"].filter((k) => input[k] != null);
  if (given.length != 1) return "Give one place: at (start or end), after, or before.";
  if (input.at == "start") return Math.max(M.textStart(s.units[0]), s.from);
  if (input.at == "end") return Math.min(M.textEnd(s.units[s.units.length - 1]), s.to);
  if (input.at != null) return 'at is "start" or "end".';
  const key = input.after != null ? "after" : "before";
  const r = rangeOf(page, path, { selector: input.selector, find: input[key] });
  return typeof r == "string" ? r : key == "after" ? r.to : r.from;
}

/** The changes, as an edit gives them. */
const out = (changes: Change[], done: string): EditResult => ({
  changes: changes.map((c) => ({ from: c.from, to: c.to ?? c.from, insert: c.insert ?? "" })),
  done,
});

/** A key's step at a caret or over a range (rules.ts), as an edit's result. */
function key(page: Page, sel: { anchor: number; head: number }, intent: Parameters<typeof rules>[2], done: string): EditResult {
  const step = rules(page, sel, intent);
  if (step == null) return { refused: "That text can't be edited there." };
  if (step == "stay" || !step.changes.length) return { changes: [], done: "No change." };
  return out(step.changes, done);
}

// ------------------------------------------------------------------ the edits

type Edit = { name: string; description: string; input: JsonSchema; run(page: Page, path: string, input: Input): EditResult };

const object = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const BLOCKS = ["p", "h1", "h2", "h3", "h4", "h5", "h6"];

const EDITS: Edit[] = [
  {
    name: "insert_text",
    description: "Type text at a place in an element's text, as a person would: it takes the styling at that place.",
    input: object({ selector: SELECTOR, text: str("The text to type (plain text: no tags)."), ...PLACE }, ["selector", "text"]),
    run(page, path, input) {
      if (typeof input.text != "string" || !input.text) return { refused: "Give the text to type." };
      const at = placeOf(page, path, input);
      if (typeof at == "string") return { refused: at };
      return key(
        page,
        { anchor: at, head: at },
        { kind: "type", from: at, to: at, text: input.text, userEvent: "input.type" },
        `Typed "${input.text}".`
      );
    },
  },
  {
    name: "replace_text",
    description:
      "Replace a piece of an element's text with other text, as a person typing over a selection would (an empty text deletes it).",
    input: object({ selector: SELECTOR, find: FIND, text: str("The new text (plain text: no tags); empty to delete.") }, [
      "selector",
      "find",
      "text",
    ]),
    run(page, path, input) {
      if (typeof input.text != "string") return { refused: "Give the new text (empty to delete)." };
      const r = rangeOf(page, path, input);
      if (typeof r == "string") return { refused: r };
      return key(
        page,
        { anchor: r.from, head: r.to },
        { kind: "type", from: r.from, to: r.to, text: input.text, userEvent: input.text ? "input.type" : "delete" },
        input.text ? `Replaced "${input.find}".` : `Deleted "${input.find}".`
      );
    },
  },
  {
    name: "split",
    description: "Press Enter at a place in an element's text: a new paragraph (or list item) starts there, with the text after it.",
    input: object(
      {
        selector: SELECTOR,
        ...PLACE,
        line_break: { type: "boolean", description: "A line break in the same block instead (Shift+Enter)." },
      },
      ["selector"]
    ),
    run(page, path, input) {
      const at = placeOf(page, path, input);
      if (typeof at == "string") return { refused: at };
      return key(
        page,
        { anchor: at, head: at },
        { kind: "enter", shift: input.line_break === true },
        input.line_break ? "Broke the line." : "Split the block."
      );
    },
  },
  {
    name: "set_block",
    description: "Make a block of text a paragraph or a heading (h1 to h6), keeping its text and its attributes.",
    input: object({ selector: SELECTOR, to: { type: "string", enum: BLOCKS, description: "What it becomes." } }, ["selector", "to"]),
    run(page, path, input) {
      if (typeof input.to != "string" || !BLOCKS.includes(input.to)) return { refused: `to is one of ${BLOCKS.join(", ")}.` };
      const s = scope(page, path, input.selector);
      if (typeof s == "string") return { refused: s };
      const changes: Change[] = [];
      for (const u of s.units) {
        if (u.tag != "p" && !HEADING.test(u.tag))
          return { refused: `A <${u.tag}> can't become a <${input.to}> here: only paragraphs and headings.` };
        if (u.tag == input.to) continue;
        const close = page.src.slice(u.contentTo, u.to);
        if (!new RegExp(`^</${u.tag}\\s*>$`, "i").test(close))
          return { refused: `The <${u.tag}> has no end tag of its own: edit its source instead.` };
        changes.push(
          { from: u.openFrom + 1, to: u.openFrom + 1 + u.tag.length, insert: input.to },
          { from: u.contentTo + 2, to: u.contentTo + 2 + u.tag.length, insert: input.to }
        );
      }
      return out(changes, changes.length ? `Made it a <${input.to}>.` : "No change.");
    },
  },
  {
    name: "style",
    description: "Make a piece of an element's text bold, italic, code or underlined, or take that style off it.",
    input: object(
      {
        selector: SELECTOR,
        find: FIND,
        style: { type: "string", enum: ["strong", "em", "code", "u"], description: "strong (bold), em (italic), code, or u (underline)." },
        on: { type: "boolean", description: "true: the text has the style after (default); false: it doesn't." },
      },
      ["selector", "find", "style"]
    ),
    run(page, path, input) {
      const style = input.style as InlineStyle;
      if (!["strong", "em", "code", "u"].includes(style)) return { refused: "style is strong, em, code or u." };
      const r = rangeOf(page, path, input);
      if (typeof r == "string") return { refused: r };
      if (hasStyle(page, r.from, r.to, style) == (input.on !== false)) return { changes: [], done: "No change: it is so already." };
      const done = toggleStyle(page, r.from, r.to, style);
      return "why" in done
        ? { refused: done.why }
        : out(done.changes, `${input.on === false ? "Took" : "Put"} ${style} ${input.on === false ? "off" : "on"} "${input.find}".`);
    },
  },
  {
    name: "clear_styles",
    description:
      "Take every inline style (bold, italic, code, links and the rest) off a piece of an element's text; a heading it touches becomes a paragraph.",
    input: object({ selector: SELECTOR, find: FIND }, ["selector", "find"]),
    run(page, path, input) {
      const r = rangeOf(page, path, input);
      if (typeof r == "string") return { refused: r };
      const done = clearStyles(page, r.from, r.to);
      return "why" in done ? { refused: done.why } : out(done.changes, `Cleared the styles of "${input.find}".`);
    },
  },
  {
    name: "link",
    description:
      "Link a piece of an element's text, or change the link it's in: its address, its text, and whether it opens in this tab. An empty url takes the link off.",
    input: object(
      {
        selector: SELECTOR,
        find: FIND,
        url: str(
          'The address ("https://...", "mailto:...", "#id", or another page of the document: "notes.html"); empty to take the link off.'
        ),
        text: str("New text for the link, if it changes."),
        same_tab: { type: "boolean", description: "It opens in this tab (target=_self); else a reader's click opens a new tab." },
      },
      ["selector", "find", "url"]
    ),
    run(page, path, input) {
      if (typeof input.url != "string") return { refused: "Give the url (empty to take the link off)." };
      const r = rangeOf(page, path, input);
      if (typeof r == "string") return { refused: r };
      const done = applyLink(page, r.from, r.to, {
        url: input.url,
        ...(typeof input.text == "string" ? { text: input.text } : {}),
        ...(typeof input.same_tab == "boolean" ? { self: input.same_tab } : {}),
      });
      return "why" in done
        ? { refused: done.why }
        : out(done.changes, input.url ? `Linked "${input.find}".` : `Took the link off "${input.find}".`);
    },
  },
  {
    name: "indent",
    description:
      "Press Tab in a block: a list item goes under the one above; another block moves in a step. With out, Shift+Tab: it comes back out.",
    input: object({ selector: SELECTOR, out: { type: "boolean", description: "Shift+Tab: out a step." } }, ["selector"]),
    run(page, path, input) {
      const s = scope(page, path, input.selector);
      if (typeof s == "string") return { refused: s };
      const from = M.textStart(s.units[0]),
        to = M.textEnd(s.units[s.units.length - 1]);
      return key(
        page,
        { anchor: from, head: s.units.length > 1 ? to : from },
        { kind: "indent", out: input.out === true },
        input.out ? "Moved it out." : "Moved it in."
      );
    },
  },
  {
    name: "insert_blocks",
    description: "Add blocks after an element, written as Markdown: paragraphs, headings (#), lists (- or 1.), quotes (>), code (```).",
    input: object({ selector: SELECTOR, markdown: str("The blocks, as Markdown.") }, ["selector", "markdown"]),
    run(page, path, input) {
      if (typeof input.markdown != "string" || !input.markdown.trim()) return { refused: "Give the blocks, as Markdown." };
      const found = findInSource(page.src, path, { selector: String(input.selector ?? "") });
      if (typeof found == "string") return { refused: found };
      const blocks = fromText(input.markdown);
      if (!blocks.length) return { refused: "The Markdown makes no blocks." };
      const indent = M.lineIndent(page.src, found.from);
      return out(
        [{ from: found.to, insert: `\n${indent}${toSource(blocks, indent)}` }],
        `Added ${blocks.length} block${blocks.length > 1 ? "s" : ""}.`
      );
    },
  },
];

/** erga/text's API, for the document's object (agents/document/tools.ts) and any caller. */
export const textApi: DocumentApi = {
  name: "erga/text",
  description:
    "The edits a person makes in Erga's editor, on a page's text: type, replace, split, block kinds, styles, links, lists, new blocks. Each keeps the page's HTML as a person's editing would.",
  edits: EDITS.map(({ name, description, input }) => ({ name, description, input })),
  apply(html, path, edit, input) {
    const e = EDITS.find((x) => x.name == edit);
    if (!e) return { refused: `erga/text has no edit "${edit}": its edits are ${EDITS.map((x) => x.name).join(", ")}.` };
    if (!input || typeof input != "object") return { refused: "Give the edit's input, as an object." };
    const a = M.analyzeHtml(html);
    const page: Page = { src: html, units: a.units, decode: M.basicDecoder, editable: () => true, open: () => false };
    return e.run(page, path, input as Input);
  },
};
