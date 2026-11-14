// The canvas's own edits (<meta name="erga-api" content="api.js">): put an image on the canvas, or in a frame. Erga
// calls add_image when a person drops an image on the canvas (canvas.js says where: window.ergaDrop), and agents do
// (call_edit). Frames are numbered from 1, in the page's order: each is a <section class="frame"> in the canvas.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const frame = (n) => `.canvas > section:nth-of-type(${n})`;
/** How many frames the page has, as written. */
const countOf = (html) => (html.match(/<section\b[^>]*\bclass\s*=\s*["'][^"']*\bframe\b/gi) ?? []).length;
const PX = (what) => ({ type: "number", description: what });

export default {
  name: "canvas",
  description: "The canvas's images: add one, on the canvas or in a frame.",
  edits: [
    {
      name: "add_image",
      description: "Puts an image on the canvas, or in a frame, which it then moves with.",
      input: {
        type: "object",
        properties: {
          frame: { type: "integer", minimum: 0, description: "The frame it belongs to, from 1 in the page's order; 0: the canvas itself." },
          x: PX("Its left edge in px: from the frame's left edge, or the canvas's."),
          y: PX("Its top edge in px: from the frame's top edge, or the canvas's."),
          width: PX("Its width in px on the canvas (default 480; in a frame 240)."),
          file: {
            type: "object",
            description: "The image: its address from the page (images/…), its name, and its size in px if known.",
            properties: { src: { type: "string" }, name: { type: "string" }, width: { type: "number" }, height: { type: "number" } },
            required: ["src"],
          },
          index: {
            type: "integer",
            minimum: 0,
            description: "One of several images at once: which (from 0). Each sits a little further down and right.",
          },
        },
        required: ["frame", "x", "y", "file"],
      },
    },
  ],
  apply(html, edit, input) {
    if (edit != "add_image") return { refused: `The canvas has no edit "${edit}".` };
    const { frame: n = 0, x, y, file, index = 0 } = input ?? {};
    const count = countOf(html);
    if (!Number.isInteger(n) || n < 0 || n > count) return { refused: `frame is a frame's number, 1 to ${count}, or 0 for the canvas.` };
    if (![x, y].every(Number.isFinite)) return { refused: "x and y are numbers of px." };
    if (!file || typeof file.src != "string" || !file.src) return { refused: "file.src is the image's address from the page." };
    const width = Number.isFinite(input.width) && input.width > 0 ? input.width : n ? 240 : 480;
    const size = file.width > 0 && file.height > 0 ? ` width="${Math.round(file.width)}" height="${Math.round(file.height)}"` : "";
    const at = `left: ${Math.round(x + 24 * index)}px; top: ${Math.round(y + 24 * index)}px`;
    const img = `<img src="${esc(file.src)}"${size} alt="${esc(file.name ?? "")}" style="position: absolute; ${at}; width: ${Math.round(width)}px; height: auto; border-radius: 6px">`;
    return [{ op: "insert", html: img, into: n ? frame(n) : ".canvas" }];
  },
};
