// The benchmark's documents, and the few calls to the server that make them
// and read them back. These calls set the benchmark up; they are not measured.
// The measurements themselves (measure.ts) look only at what a person sees,
// and at what a second editor of the document would see (`live`).

import * as Y from "yjs";
import { decodeStart } from "../../shared/room-socket";
//
// Each document's first <h1> holds MARK, with elementtiming="erga-bench" (the
// Element Timing API: the browser says when it painted it). Below it, a
// paragraph (data-bench="type") starts with LINE: the editor cases type at
// its end. (Not in the heading: the document's address follows its heading.)

/** The text that shows the document is on screen. Plain words: no entity, no markup. */
export const MARK = "Bench marker heading";
/** The start of the paragraph the bench types in. */
export const LINE = "Bench typing line";

/** The length of the text of the paragraph the bench types in, in a page's HTML (tags inside it dropped), or -1. */
export function lineLength(html: string): number {
  const m = /<p\b[^>]*data-bench="type"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  return m ? m[1].replace(/<[^>]*>/g, "").replace(/&[a-z]+;|&#\d+;/g, "x").length : -1;
}

/** A document kind: its files, and whether it is a project (pages) rather than a document (one page). */
export interface DocKind {
  name: string;
  files: Record<string, string>;
  project?: boolean;
}

const STYLE = `body { font: 17px/1.6 Georgia, serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; color: #222; }
h1 { font: 700 2.4rem/1.15 system-ui, sans-serif; letter-spacing: -.02em; } h2 { font: 600 1.4rem/1.2 system-ui, sans-serif; margin-top: 2.2em; }
.card { border: 1px solid #ddd; border-radius: 10px; padding: 1rem 1.25rem; background: #fafafa; } figure svg { width: 100%; height: auto; }`;
const SCRIPT = `document.querySelectorAll("[data-count]").forEach((el) => { let n = 0; el.addEventListener("click", () => { el.textContent = "Clicked " + (++n); }); });`;
const PARA = "Erga opens a page and lets you edit its text in place, on the rendered page, with the page's own styles and scripts running around it. Each paragraph is its own small editor; everything else keeps working as an ordinary web page. ";

const WORDS = PARA.toLowerCase().replace(/[^a-z' ]/g, "").split(" ").filter(Boolean)
  .concat(["layout", "server", "request", "frame", "cache", "socket", "render", "stream", "quiet", "measure", "header", "column", "figure", "notice", "budget"]);
/** `n` words, the same each time (a fixed seed), varied as prose is: they compress as real text does, not as one sentence repeated. */
function prose(seed: number, n: number): string {
  let x = (seed * 2654435761) % 4294967296;
  const next = () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(next() * WORDS.length)] + (next() < 0.08 ? "." : next() < 0.06 ? "," : ""));
  return out.join(" ").replace(/(^|\. )([a-z])/g, (_, a: string, c: string) => a + c.toUpperCase()) + ".";
}

const section = (i: number) => `<h2>Section ${i + 1}</h2>
<p>${prose(i * 3 + 1, 80)}</p>
<ul><li>${prose(i * 3 + 2, 14)}</li><li>${prose(i * 3 + 3, 16)}</li></ul>${i % 4 == 3 ? `
<figure><svg viewBox="0 0 400 120"><rect x="10" y="10" width="380" height="100" rx="12" fill="#e8eefc"/><text x="200" y="68" text-anchor="middle" font-size="22">Diagram ${i + 1}</text></svg></figure>` : ""}
<p><button data-count>Click me</button></p>`;

/** A page with a stylesheet, a script and `sections` sections of text (from section `from` on: each page's own text). */
const page = (sections: number, from = 0) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>A field guide to loading fast</title><link rel="stylesheet" href="style.css"></head>
<body>
<h1 elementtiming="erga-bench">${MARK}</h1>
<p data-bench="type">${LINE}</p>
<p class="card"><b>Summary.</b> ${PARA}</p>
${Array.from({ length: sections }, (_, i) => section(from + i)).join("\n")}
<script src="widget.js"></script>
</body></html>
`;

/** About 10 kB of HTML. */
export const SMALL: DocKind = { name: "small", files: { "style.css": STYLE, "widget.js": SCRIPT, "index.html": page(12) } };
/** About 200 kB of HTML. */
export const LARGE: DocKind = { name: "large", files: { "style.css": STYLE, "widget.js": SCRIPT, "index.html": page(256) } };
/** A project of 30 pages of about 10 kB each: about 300 kB of text, as Pete's largest (erga-designs). Its home page is the small one. */
export const PROJECT: DocKind = {
  name: "project",
  project: true,
  files: {
    "style.css": STYLE,
    "widget.js": SCRIPT,
    ...Object.fromEntries(Array.from({ length: 29 }, (_, i) => [`notes/page-${i + 1}.html`, page(12, (i + 1) * 12)])),
    "index.html": page(12),
  },
};

// ---------------------------------------------------------------- the server

/** A document id (server/directory: eight lowercase letters and digits). Local development lets /new name it. */
const newId = () => "b" + Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

/** Where to read and write a document's files, raw (/d/<id>/api/stored/<path>): set-up only. */
const stored = (root: string, id: string, path: string) => `${root}/d/${id}/api/stored/${path}`;

/** Makes a document (POST /new): its id and its address (no ?edit). `from`: a copy of that document. */
async function make(root: string, from?: string, project = false): Promise<{ id: string; address: string }> {
  const id = newId();
  const r = await fetch(`${root}/new?id=${id}${from ? `&from=${from}` : ""}${project ? "&kind=project" : ""}`, {
    method: "POST",
    headers: { Origin: root },
    redirect: "manual",
  });
  const at = r.headers.get("location");
  if (r.status != 302 || !at) throw new Error(`/new answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return { id, address: at.replace(/[?&]edit=?$/, "") };
}

/**
 * The source documents, one for each kind, made once. Each run loads a fresh
 * copy (fresh()), so its Durable Object holds its files but has not opened
 * its room, as a document that nobody opened for a while on erga.dev.
 */
export class Docs {
  private sources = new Map<string, Promise<string>>();
  constructor(private root: string) {}

  private source(kind: DocKind): Promise<string> {
    let p = this.sources.get(kind.name);
    if (!p) this.sources.set(kind.name, p = (async () => {
          const { id } = await make(this.root, undefined, kind.project);
      // index.html last: the page's files are there when it changes.
      for (const [path, text] of Object.entries(kind.files).sort(([a], [b]) => (a == "index.html" ? 1 : b == "index.html" ? -1 : 0))) {
        const r = await fetch(stored(this.root, id, path), { method: "PUT", body: text });
        if (!r.ok) throw new Error(`PUT ${path}: ${r.status} ${await r.text()}`);
      }
      return id;
    })());
    return p;
  }

  /** A new copy of a kind's document: its id and its address (no ?edit). */
  async fresh(kind: DocKind): Promise<{ id: string; address: string }> {
    return make(this.root, await this.source(kind));
  }

  /**
   * The document's page as a second editor sees it now: the room's state
   * from GET /d/<id>/api/start, the request an editor starts with
   * (shared/room-socket.ts). "" if there is none.
   */
  async live(id: string): Promise<string> {
    const r = await fetch(`${this.root}/d/${id}/api/start`, { cache: "no-store" });
    if (!r.ok) return "";
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decodeStart(new Uint8Array(await r.arrayBuffer())).state);
    return doc.getMap<Y.Text>("files").get("index.html")?.toString() ?? "";
  }

  /** The document's page as the server stores it now, as a file (the room writes it lazily: up to about 3 s after an edit). */
  async stored(id: string): Promise<string> {
    const r = await fetch(stored(this.root, id, "index.html"), { cache: "no-store" });
    return r.ok ? r.text() : "";
  }
}
