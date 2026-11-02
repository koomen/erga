// erga/slides' API: a deck's edits, as its slide bar makes them and agents call them (call_edit). A deck is a page that
// imports erga/slides (<script type="module" src="https://erga.dev/erga/slides/editor.js">) and holds a
// <section class="slide" data-layout="..."> for each slide; its text is edited as erga/text's is, so its edits are
// erga/text's and these: add a slide, delete one, move one, change its layout. Slides are numbered from 1, in the
// source's order. Pure: each gives the changes to the page's HTML, or why not.

import * as M from "../../../shared/manuscript";
import { selectInSource } from "../../../shared/source-select";
import { textApi, type DocumentApi, type EditResult, type JsonSchema } from "../../text/api/edits";
import { escapeAttr, setAttr } from "../../text/api/source";

/** The layouts a slide can have: its data-layout, which the deck's style (libs/slides/ui/style.ts) draws. */
export const LAYOUTS = ["title", "content"] as const;
export type Layout = (typeof LAYOUTS)[number];

/** A new slide's HTML, with its placeholder text (the editor selects it, to type over). */
function slideHtml(layout: Layout, title: string): string {
  const t = M.escapeHtmlText(title);
  return layout == "title"
    ? `<section class="slide" data-layout="title">\n  <h1>${t}</h1>\n  <p>Subtitle</p>\n</section>`
    : `<section class="slide" data-layout="content">\n  <h2>${t}</h2>\n  <ul>\n    <li>A point</li>\n  </ul>\n</section>`;
}

/** The deck's slides, in the source's order. */
export const slidesOf = (src: string): M.ElementNode[] => {
  const found = selectInSource(src, "section.slide");
  return typeof found == "string" ? [] : found;
};

/** Where a slide's text starts: the line break before it, if it starts its line. */
const lineFrom = (src: string, el: M.ElementNode) => {
  const m = /\n[ \t]*$/.exec(src.slice(0, el.from));
  return m ? m.index : el.from;
};
/** A block's lines after the first, indented by `ind`. */
const indent = (block: string, ind: string) => block.replace(/\n/g, `\n${ind}`);

/** The slide numbered `n` (from 1), or why there's none. */
function slideAt(slides: M.ElementNode[], n: unknown): M.ElementNode | string {
  if (typeof n != "number" || !Number.isInteger(n) || n < 1 || n > slides.length)
    return slides.length ? `There's no slide ${n}: the deck has slides 1 to ${slides.length}.` : "The deck has no slides.";
  return slides[n - 1];
}

/** A new slide after slide `after` (0: before the first). */
export function addSlide(src: string, after: number, layout: Layout, title?: string): EditResult {
  const slides = slidesOf(src);
  if (!LAYOUTS.includes(layout)) return { refused: `A slide's layout is one of ${LAYOUTS.join(", ")}.` };
  if (!slides.length) return { refused: 'The page has no slides to put one beside: add a <section class="slide"> with edit.' };
  if (!Number.isInteger(after) || after < 0 || after > slides.length)
    return { refused: `after is a slide's number, 1 to ${slides.length}, or 0 for the start.` };
  const block = slideHtml(layout, title?.trim() || "Title");
  const ref = slides[Math.max(0, after - 1)];
  const ind = M.lineIndent(src, ref.from);
  const insert = after == 0 ? indent(block, ind) + "\n" + ind : "\n" + ind + indent(block, ind);
  return {
    changes: [{ from: after == 0 ? ref.from : ref.to, to: after == 0 ? ref.from : ref.to, insert }],
    done: `Added slide ${after + 1}.`,
  };
}

export function deleteSlide(src: string, n: number): EditResult {
  const slides = slidesOf(src);
  const el = slideAt(slides, n);
  if (typeof el == "string") return { refused: el };
  if (slides.length == 1) return { refused: "A deck keeps at least one slide." };
  return { changes: [{ from: lineFrom(src, el), to: el.to, insert: "" }], done: `Deleted slide ${n}.` };
}

/** Slide `n` moved, so it's number `to`. */
export function moveSlide(src: string, n: number, to: number): EditResult {
  const slides = slidesOf(src);
  const el = slideAt(slides, n),
    at = slideAt(slides, to);
  if (typeof el == "string") return { refused: el };
  if (typeof at == "string") return { refused: at };
  if (n == to) return { refused: `Slide ${n} is there already.` };
  const text = src.slice(el.from, el.to).replace(new RegExp(`\n${M.lineIndent(src, el.from)}`, "g"), "\n");
  const ind = M.lineIndent(src, at.from);
  const place =
    to > n ? { from: at.to, insert: "\n" + ind + indent(text, ind) } : { from: at.from, insert: indent(text, ind) + "\n" + ind };
  return {
    changes: [
      { from: lineFrom(src, el), to: el.to, insert: "" },
      { from: place.from, to: place.from, insert: place.insert },
    ].sort((a, b) => a.from - b.from),
    done: `Moved slide ${n} to ${to}.`,
  };
}

export function setLayout(src: string, n: number, layout: Layout): EditResult {
  const el = slideAt(slidesOf(src), n);
  if (typeof el == "string") return { refused: el };
  if (!LAYOUTS.includes(layout)) return { refused: `A slide's layout is one of ${LAYOUTS.join(", ")}.` };
  const open = src.slice(el.from, el.openTo);
  return {
    changes: [{ from: el.from, to: el.openTo, insert: setAttr(open, "data-layout", escapeAttr(layout)) }],
    done: `Slide ${n} has the ${layout} layout.`,
  };
}

const SLIDE: JsonSchema = { type: "integer", minimum: 1, description: "The slide's number, from 1, in the deck's order." };
const LAYOUT: JsonSchema = {
  type: "string",
  enum: [...LAYOUTS],
  description: "title: a heading and a line; content: a heading and points.",
};
const SLIDE_EDITS: {
  name: string;
  description: string;
  input: JsonSchema;
  run: (src: string, i: Record<string, unknown>) => EditResult;
}[] = [
  {
    name: "add_slide",
    description: "Adds a slide after another, with a layout and a title.",
    input: {
      type: "object",
      properties: {
        after: { type: "integer", minimum: 0, description: "The slide it comes after; 0 for the start." },
        layout: LAYOUT,
        title: { type: "string", description: "Its heading (else a placeholder)." },
      },
      required: ["after", "layout"],
    },
    run: (src, i) => addSlide(src, i.after as number, i.layout as Layout, typeof i.title == "string" ? i.title : undefined),
  },
  {
    name: "delete_slide",
    description: "Deletes a slide.",
    input: { type: "object", properties: { slide: SLIDE }, required: ["slide"] },
    run: (src, i) => deleteSlide(src, i.slide as number),
  },
  {
    name: "move_slide",
    description: "Moves a slide to another place.",
    input: {
      type: "object",
      properties: { slide: SLIDE, to: { ...SLIDE, description: "Its number after the move." } },
      required: ["slide", "to"],
    },
    run: (src, i) => moveSlide(src, i.slide as number, i.to as number),
  },
  {
    name: "set_layout",
    description: "Changes a slide's layout.",
    input: { type: "object", properties: { slide: SLIDE, layout: LAYOUT }, required: ["slide", "layout"] },
    run: (src, i) => setLayout(src, i.slide as number, i.layout as Layout),
  },
];

export const slidesApi: DocumentApi = {
  name: "erga/slides",
  description: "A deck's edits: its slides (add, delete, move, layout), and erga/text's edits for the text in them.",
  edits: [...SLIDE_EDITS.map(({ name, description, input }) => ({ name, description, input })), ...textApi.edits],
  apply(html, path, edit, input) {
    const e = SLIDE_EDITS.find((x) => x.name == edit);
    if (!e) {
      if (textApi.edits.some((x) => x.name == edit)) return textApi.apply(html, path, edit, input);
      return { refused: `erga/slides has no edit "${edit}": its edits are ${slidesApi.edits.map((x) => x.name).join(", ")}.` };
    }
    if (!input || typeof input != "object") return { refused: "Give the edit's input, as an object." };
    return e.run(html, input as Record<string, unknown>);
  },
};
