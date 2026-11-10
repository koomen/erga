// Samples for the agents' tools journey (tools.e2e.ts): pages, a picture, a PDF, a sound; and clicks on two fixtures'
// own controls (the deck's slide bar, the views' buttons).
import { F, type Editor } from "../helpers/editor";
import { expect } from "../helpers/fixtures";
import type { DocTools } from "./panel";

/** A 1×1 PNG. */
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaPhfDwAEgQHAp0dVPQAAAABJRU5ErkJggg==";

/** A page of a document with many pages: its title, its body, and the way up to the stylesheet. */
const PAGE = (title: string, body: string, up = "") =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n<link rel="stylesheet" href="${up}style.css">\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

/** The files of a document with many pages: a home page, an about page, and a blog folder with its own stylesheet. */
export const SITE = {
  "index.html": PAGE("Home", `<h1>Home</h1>\n<p>The first page of a document with several.</p>`),
  "style.css": "body { background: rgb(250, 246, 236); }\n",
  "about.html": PAGE("About", `<h1>About</h1>\n<p>Who made this.</p>`),
  "blog/index.html": PAGE("Blog", `<h1>Blog</h1>\n<p>Posts, one page each, in this folder.</p>`, "../"),
  "blog/post.html": PAGE("A post", `<h1>A post</h1>\n<p>A page two folders down.</p>`, "../"),
  "blog/blog.css": "h1 { color: rgb(180, 40, 30); }\n",
};

/** A small PDF: one page for each line given. */
export function pdf(...pages: string[]): Uint8Array<ArrayBuffer> {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  for (const line of pages) {
    const content = `BT /F1 18 Tf 72 720 Td (${line}) Tj ET`;
    kids.push(`${objs.length + 1} 0 R`);
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objs.length + 2} 0 R /Resources << /Font << /F1 FONT 0 R >> >> >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
    );
  }
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o.replace("FONT", String(objs.length))}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** One second of a quiet 440 Hz tone, as a WAV file (PCM, 8 kHz, 16-bit mono), in base 64. */
export function tone(): string {
  const rate = 8000,
    n = rate,
    data = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) data.setUint8(at + i, text.charCodeAt(i));
  };
  str(0, "RIFF");
  data.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, rate, true);
  data.setUint32(28, rate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  str(36, "data");
  data.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) data.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 2000), true);
  return Buffer.from(data.buffer).toString("base64");
}

/** A page with a sound and a button that plays it. Its script warns 1000 times as it loads. */
export const PLAYER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Player</title></head>
<body>
<h1>Player</h1>
<p>Press play.</p>
<div data-erga-noedit><button id="play" type="button">Play</button><audio id="track" src="tone.wav" preload="auto" loop></audio></div>
<script>
for (let i = 0; i < 1000; i++) console.warn("The AudioContext was not allowed to start");
document.getElementById("play").addEventListener("click", () => {
  document.getElementById("track").play().then(() => console.log("playing"), (e) => console.warn("play() failed: " + e.name));
});
</script>
</body>
</html>
`;

/** A page with a script file and an image of its own: the files, by path. */
const PROBE = {
  "probe.js": "function probeFn() { return 42; }\n",
  "probe-logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#c00"/></svg>\n`,
  "index.html": `<!doctype html>\n<html><head><meta charset="utf-8"><title>Probe</title><script src="probe.js"></script></head>\n<body><h1>Probe</h1><img id="logo" src="probe-logo.svg" alt="logo"></body></html>\n`,
};

/**
 * Writes a page with a script file and an image into the document, and asks the render whether both loaded: the
 * render's token and pages origin must name the document's real owner, or the page's own files give 404. `view`:
 * view_page's arguments.
 */
export async function probe(d: DocTools, view: Record<string, unknown>) {
  for (const [path, content] of Object.entries(PROBE)) await d.ok("write", { path, content });
  const loaded = await d.ok("eval_in_page", {
    expression: `(() => { const i = document.getElementById("logo"); return [typeof probeFn, i.complete && i.naturalWidth]; })()`,
  });
  expect(JSON.parse(loaded.text.split("\n\n")[0])).toEqual(["function", 40]);
  expect((await d.ok("view_page", view)).text).not.toMatch(/probeFn|404/);
}

/** The document that a page of the site shows: in the viewer's frame, or served directly (its controls name it). */
export const docOf = (html: string) =>
  /<meta name="erga-doc" content="([a-z0-9]{8})">/.exec(html)?.[1] ?? /<erga-controls data-doc="([a-z0-9]{8})"/.exec(html)?.[1];

/** Clicks a button of the deck's slide bar (data-act: add, title, up, down, layout, delete) with the mouse, as a person does. */
export async function slideBar(ed: Editor, act: string) {
  const r = await ed.frame<{ x: number; y: number } | null>(
    `(() => { const b = ${F}.querySelector("slide-bar")?.shadowRoot?.querySelector('[data-act="${act}"]'); if (!b || b.closest("[hidden]")) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
  );
  expect(r, `the slide bar shows its ${act} button`).not.toBeNull();
  const f = await ed.frameAt();
  await ed.page.mouse.click(f.x + r!.x, f.y + r!.y);
}

/** Clicks a button (by its class) on the view whose heading is `name` (e2e/fixtures/page-api), or the "New view" row of the list it's in. */
export async function viewButton(ed: Editor, name: string, button: string) {
  const sel = await ed.frame<string>(`(() => {
    const h = [...${F}.querySelectorAll(".map h3")].find((h) => h.textContent == ${JSON.stringify(name)});
    const li = h.closest("li"), b = ${JSON.stringify(button)} == "add" ? li.parentElement.querySelector(":scope > .add-row button") : li.querySelector(":scope > .view > .ctl button.${button}");
    ${F}.querySelectorAll("[data-test-target]").forEach((x) => x.removeAttribute("data-test-target"));
    b.setAttribute("data-test-target", "");
    return "[data-test-target]";
  })()`);
  const at = await ed.rectOf(sel);
  await ed.click(at.x, at.y);
  await ed.settle();
}

/** What page_log's "frames" says of the person's open page: each frame's permissions and media. */
export type LiveFacts = {
  frame: string;
  allow?: string;
  autoplay?: { allowsFeature: boolean; fullscreen?: boolean };
  media?: { element: string; paused: boolean; readyState: string }[];
  editorFrame?: { allow: string };
}[];

/** Code that eval_in_page runs in a render. */
export const CODE = {
  /** In the viewer's own window (shell: true): its address, whether the page's frame is on another origin, and its breadcrumbs. */
  viewer: `({ path: location.pathname, frame: new URL(document.getElementById("frame").src).origin != location.origin, crumbs: !!document.querySelector(".erga-crumbs") })`,
  /** In the page (e2e/fixtures/page): two clicks on its button, then its count, and where the code ran. */
  bump: `document.getElementById("bump").click(); document.getElementById("bump").click(); return { count: document.getElementById("count").textContent, framed: window.top !== window, origin: location.origin };`,
  /** In the editor's own window (editor: true, shell: true): the editor's controls, and the answer to a request for the person's Share token. */
  editor: `const r = await fetch(location.pathname + "/api/share", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); return { editing: document.body.classList.contains("erga-editing"), controls: !!document.getElementById("erga-editor"), share: !!document.querySelector("#erga-editor [aria-label*='Share' i], #erga-editor [title*='Share' i]"), status: r.status, body: await r.text() };`,
};
