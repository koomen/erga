// PDFs for the agents (editor-agent/session.ts): how many pages one has, a
// range of its pages as a PDF of its own (pdf-lib), and its text, page by
// page (PDF.js, through unpdf, which runs in a Worker). A PDF's text is
// extracted once and kept by the PDF's hash (the blob store's `kept`), so
// the second search through it costs nothing.

import type { BlobStore } from "./blobs.ts";

/** pdf-lib, loaded the first time a PDF is read (it isn't in the Worker's main module). */
const pdfLib = () => import("pdf-lib");

/** The most pages one read of a PDF gives the model: a range of them at a time. */
export const PAGES_PER_READ = 20;
/** The most bytes a range of pages may have, as the model takes it (the API takes a request of up to 32 MB). */
export const PDF_READ_MAX = 12_000_000;
/** The most bytes a PDF may have for its text to be extracted here (the object holds it in memory to do it). */
export const PDF_TEXT_MAX = 60_000_000;

export const isPdf = (path: string) => /\.pdf$/i.test(path);

/** "3", "2-5", "10-": the first and last page (1-based, inclusive), within `total`; or why the range is wrong. */
export function pageRange(spec: string | undefined, total: number): { from: number; to: number } | string {
  if (!spec?.trim()) return { from: 1, to: Math.min(total, PAGES_PER_READ) };
  const m = /^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$/.exec(spec);
  if (!m) return `pages is "${spec}": give one page ("3") or a range ("21-40").`;
  const from = Number(m[1]), to = m[2] === undefined ? from : m[2] == "" ? total : Number(m[2]);
  if (from < 1 || from > total) return `The PDF has ${total} page${total == 1 ? "" : "s"}: page ${from} isn't one of them.`;
  if (to < from) return `pages is "${spec}": the last page comes before the first.`;
  if (to - from + 1 > PAGES_PER_READ) return `That's ${to - from + 1} pages: read at most ${PAGES_PER_READ} at a time ("${from}-${from + PAGES_PER_READ - 1}").`;
  return { from, to: Math.min(to, total) };
}

/** How many pages a PDF has. */
export async function pageCount(bytes: Uint8Array): Promise<number> {
  const { PDFDocument } = await pdfLib();
  return (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
}

/** Pages `from` to `to` (1-based) as a PDF of their own; the PDF itself when that's all of it. */
export async function pdfPages(bytes: Uint8Array, from: number, to: number): Promise<{ bytes: Uint8Array; total: number }> {
  const { PDFDocument } = await pdfLib();
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const total = src.getPageCount();
  if (from == 1 && to >= total) return { bytes, total };
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i));
  for (const p of pages) out.addPage(p);
  return { bytes: await out.save(), total };
}

/** A PDF's text, page by page (a scan's pages have none). */
export async function extractPages(bytes: Uint8Array): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // PDF.js takes its input over: a copy, so the caller's bytes stay whole.
  const pdf = await getDocumentProxy(bytes.slice());
  try {
    return (await extractText(pdf, { mergePages: false })).text as string[];
  } finally {
    await pdf.destroy().catch(() => {});
  }
}

/** Texts extracted in this isolate, by the PDF's hash (a few, the latest). */
const recent = new Map<string, string[]>();

/**
 * A PDF's text, page by page: kept by its hash (in memory, then the blob
 * store's `kept`), else extracted from its bytes (`bytes`, asked only then)
 * and kept. Null when the PDF is too big to extract here, or isn't one.
 */
export async function pdfText(hash: string, bytes: () => Promise<Uint8Array | null>, blobs?: BlobStore | null): Promise<string[] | null> {
  const mine = recent.get(hash);
  if (mine) return mine;
  const kept = await blobs?.kept?.get(`pdf-text/${hash}`).catch(() => null);
  if (kept) { const pages = JSON.parse(kept) as string[]; remember(hash, pages); return pages; }
  const b = await bytes();
  if (!b || b.length > PDF_TEXT_MAX) return null;
  let pages: string[];
  try { pages = await extractPages(b); } catch { return null; }
  remember(hash, pages);
  await blobs?.kept?.put(`pdf-text/${hash}`, JSON.stringify(pages)).catch(() => {});
  return pages;
}

function remember(hash: string, pages: string[]): void {
  if (recent.size >= 32) recent.delete(recent.keys().next().value!);
  recent.set(hash, pages);
}
