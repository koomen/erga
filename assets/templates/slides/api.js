// The deck's own edits (<meta name="erga-api" content="api.js">): add, delete and move a slide, change its layout, and
// put an image on one. The bar over the slide (slides.js) calls them, Erga calls add_image when a person drops an
// image on a slide (slides.js says where: window.ergaDrop), and agents do (call_edit). Slides are numbered from 1, in the page's
// order: each is a <section class="slide"> in <body>, with a layout (data-layout: title or content).

const LAYOUTS = ["title", "content"];
const slide = (n) => `body > section:nth-of-type(${n})`;

/** A new slide's HTML, with its text, or placeholder text (Erga selects it, to type over). */
function slideHtml(layout, title, points) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const t = esc(title);
  return layout == "title"
    ? `<section class="slide" data-layout="title">\n  <h1>${t}</h1>\n  <p>${esc(points[0] ?? "Subtitle")}</p>\n</section>`
    : `<section class="slide" data-layout="content">\n  <h2>${t}</h2>\n  <ul>\n${(points.length ? points : ["A point"]).map((p) => `    <li>${esc(p)}</li>\n`).join("")}  </ul>\n</section>`;
}

/** How many slides the page has, as written. */
const countOf = (html) => (html.match(/<section\b[^>]*\bclass\s*=\s*["'][^"']*\bslide\b/gi) ?? []).length;

const SLIDE = { type: "integer", minimum: 1, description: "The slide's number, from 1, in the deck's order." };
const LAYOUT = { type: "string", enum: LAYOUTS, description: "title: a heading and a line; content: a heading and points." };

export default {
  name: "slides",
  description: "The deck's slides: add, delete, move, layout; an image on a slide.",
  edits: [
    {
      name: "add_slide",
      description: "Adds a slide after another, with a layout, a title and its points.",
      input: {
        type: "object",
        properties: {
          after: { type: "integer", minimum: 0, description: "The slide it comes after; 0 for the start." },
          layout: LAYOUT,
          title: { type: "string", description: "Its heading (else a placeholder)." },
          points: {
            type: "array",
            items: { type: "string" },
            description: "Its text, plain: content's points; title's line (the first).",
          },
        },
        required: ["after", "layout"],
      },
    },
    {
      name: "delete_slide",
      description: "Deletes a slide.",
      input: { type: "object", properties: { slide: SLIDE }, required: ["slide"] },
    },
    {
      name: "move_slide",
      description: "Moves a slide to another place.",
      input: {
        type: "object",
        properties: { slide: SLIDE, to: { ...SLIDE, description: "Its number after the move." } },
        required: ["slide", "to"],
      },
    },
    {
      name: "set_layout",
      description: "Changes a slide's layout.",
      input: { type: "object", properties: { slide: SLIDE, layout: LAYOUT }, required: ["slide", "layout"] },
    },
    {
      name: "add_image",
      description: "Puts an image on a slide, under its text, or on a new slide after it.",
      input: {
        type: "object",
        properties: {
          slide: SLIDE,
          file: {
            type: "object",
            description: "The image: its address from the page (images/…), its name, and its size in px if known.",
            properties: { src: { type: "string" }, name: { type: "string" }, width: { type: "number" }, height: { type: "number" } },
            required: ["src"],
          },
          height: {
            type: "number",
            description:
              "Its height in cqw (hundredths of the slide's width; a slide is 56.25 high). Default 20: keep the slide's text and it inside the slide.",
          },
          fresh: { type: "boolean", description: "true: on a new slide after this one, under a heading with its name." },
        },
        required: ["slide", "file"],
      },
    },
  ],
  apply(html, edit, input) {
    const count = countOf(html);
    const no = (n) =>
      !Number.isInteger(n) || n < 1 || n > count
        ? count
          ? `There's no slide ${n}: the deck has slides 1 to ${count}.`
          : "The deck has no slides."
        : null;
    if (edit == "add_slide") {
      const { after, layout, title, points = [] } = input;
      if (!Array.isArray(points) || points.some((p) => typeof p != "string")) return { refused: "points is a list of strings." };
      if (!LAYOUTS.includes(layout)) return { refused: `A slide's layout is one of ${LAYOUTS.join(", ")}.` };
      if (!count) return { refused: 'The page has no slides to put one beside: add a <section class="slide"> with edit.' };
      if (!Number.isInteger(after) || after < 0 || after > count)
        return { refused: `after is a slide's number, 1 to ${count}, or 0 for the start.` };
      const html = slideHtml(layout, (typeof title == "string" && title.trim()) || "Title", points);
      return [after == 0 ? { op: "insert", html, before: slide(1) } : { op: "insert", html, after: slide(after) }];
    }
    if (edit == "delete_slide") {
      const n = input.slide;
      if (no(n)) return { refused: no(n) };
      if (count == 1) return { refused: "A deck keeps at least one slide." };
      // The caret goes to the slide before (the first: the one after).
      return [
        { op: "remove", el: slide(n) },
        { op: "caret", el: slide(n > 1 ? n - 1 : 2) },
      ];
    }
    if (edit == "move_slide") {
      const { slide: n, to } = input;
      if (no(n) || no(to)) return { refused: no(n) || no(to) };
      if (n == to) return { refused: `Slide ${n} is there already.` };
      return [
        to > n ? { op: "move", el: slide(n), after: slide(to) } : { op: "move", el: slide(n), before: slide(to) },
        { op: "caret", el: slide(n) },
      ];
    }
    if (edit == "set_layout") {
      const { slide: n, layout } = input;
      if (no(n)) return { refused: no(n) };
      if (!LAYOUTS.includes(layout)) return { refused: `A slide's layout is one of ${LAYOUTS.join(", ")}.` };
      return [
        { op: "attr", el: slide(n), name: "data-layout", value: layout },
        { op: "caret", el: slide(n) },
      ];
    }
    if (edit == "add_image") {
      const { slide: n, file, fresh } = input;
      if (no(n)) return { refused: no(n) };
      if (!file || typeof file.src != "string" || !file.src) return { refused: "file.src is the image's address from the page." };
      const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const height = Number.isFinite(input.height) && input.height > 0 ? Math.min(input.height, 52) : fresh ? 36 : 20;
      const size = file.width > 0 && file.height > 0 ? ` width="${Math.round(file.width)}" height="${Math.round(file.height)}"` : "";
      const name = String(file.name ?? "");
      const img = `<img src="${esc(file.src)}"${size} alt="${esc(name)}" style="height: ${height}cqw; width: auto; max-width: 100%; align-self: flex-start; object-fit: contain">`;
      if (!fresh) return [{ op: "insert", html: img, into: slide(n) }];
      const title = esc(name.replace(/\.[^.]+$/, "") || "Image");
      return [
        { op: "insert", html: `<section class="slide" data-layout="content">\n  <h2>${title}</h2>\n  ${img}\n</section>`, after: slide(n) },
      ];
    }
    return { refused: `The deck has no edit "${edit}".` };
  },
};
