// What the checks share: the untouched corpus, a page's text, its links, and its problems in the browser.

import { join, posix } from "node:path";
import { readFiles } from "./probe.ts";
import type { Files, Probe } from "./types.ts";

const cache = new Map<string, Files>();
/** A corpus document as it was before the task. */
export function original(doc: string): Files {
  if (!cache.has(doc)) cache.set(doc, readFiles(join(import.meta.dir, "corpus", doc)));
  return cache.get(doc)!;
}

/** Whitespace collapsed and trimmed. */
export const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** HTML's visible text: no head, scripts, styles or tags; the common entities decoded; whitespace collapsed. */
export function text(html: string): string {
  return squash(
    html
      .replace(/<head\b[\s\S]*?<\/head>/i, " ")
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, "&")
  );
}

export const words = (html: string) => text(html).split(" ").filter(Boolean).length;

/** For a loose text comparison: lower case, letters and digits only. */
export const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The numbers in a text, in order ("10,000" is 10000). */
export const numbers = (s: string) => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, "")));

/** Each link to the document's own files (href and src of its HTML pages), with the file it points to. */
export function links(files: Files): { from: string; href: string; target: string }[] {
  const out: { from: string; href: string; target: string }[] = [];
  for (const [from, html] of Object.entries(files)) {
    if (!from.endsWith(".html")) continue;
    for (const [, , href] of html.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) {
      if (!href || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) continue;
      let target = posix.normalize(posix.join(posix.dirname(from), href.split(/[?#]/)[0]));
      if (target == "." || target.endsWith("/")) target = posix.join(target, "index.html");
      out.push({ from, href, target });
    }
  }
  return out;
}

/** The links that point to no file of the document. */
export const broken = (files: Files) =>
  links(files)
    .filter(({ target }) => !(target in files || `${target}.html` in files))
    .map(({ from, href }) => `${from} links to ${href}, which does not exist`);

/** Opens each page and lists its script errors and the files it failed to load. */
export async function pageErrors(probe: Probe, paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    const page = await probe.open(path);
    out.push(...probe.errors(page).map((e) => `${path}: ${e}`));
    await page.close();
  }
  return out;
}

/** The HTML pages of a document. */
export const pages = (files: Files) => Object.keys(files).filter((f) => f.endsWith(".html"));
