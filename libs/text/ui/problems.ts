// Problems with the page that the page itself reports (a script error, a file that didn't load), in words.

import type { PageProblem } from "./types";

export type RawProblem =
  | { kind: "resource"; tag: string; url: string }
  | { kind: "script"; message: string; file: string; line: number; stack?: string };

/** Where the editor's own scripts are (this module and its chunks, in the app's /_erga/). */
const OWN = new URL(".", import.meta.url).href;

/**
 * An error thrown in the editor's own code (its file, or the first file in its stack, is one of the editor's): Erga's
 * bug, not the page's. The agent can't fix it; the page's console log keeps it for Erga's maintainers.
 */
export function isOwnError(raw: Extract<RawProblem, { kind: "script" }>): boolean {
  const file = raw.file || raw.stack?.match(/(?:https?|file):\/\/[^\s)]+/)?.[0] || "";
  return file.startsWith(OWN);
}

/** A page that lets the editor pause it (agents/document/PROMPT.md, rule 10). */
export type PausableWindow = Window & { ergaPause?: unknown };

/** A problem the page reported, in words, with a prompt for the agent to fix it. */
export function describeProblem(raw: RawProblem, base: string): PageProblem | null {
  const local = (u: string) => { try { const url = new URL(u, location.origin + base); return url.origin == location.origin && url.pathname.startsWith(base) ? decodeURIComponent(url.pathname.slice(base.length)) : u; } catch { return u; } };
  if (raw.kind == "resource") {
    const what = raw.tag == "link" ? "stylesheet" : raw.tag == "script" ? "script" : raw.tag == "img" ? "image" : `file`;
    const name = local(raw.url);
    return {
      key: `resource:${name}`,
      message: `The page's ${what} “${name}” didn't load, so the page may not look or work as it should.`,
      fix: `The page refers to the ${what} “${name}”, but it fails to load in the browser. Find out why (a wrong path, a missing file) and fix it.`,
    };
  }
  if (/^Script error\.?$/.test(raw.message) && !raw.file) return null; // cross-origin, nothing to go on
  if (isOwnError(raw)) return null;
  const where = raw.file && !/srcdoc/.test(raw.file) ? ` (${local(raw.file)}${raw.line ? `, line ${raw.line}` : ""})` : raw.line ? ` (the page's inline script, line ${raw.line})` : "";
  return {
    key: `script:${raw.message}`,
    message: `The page's script hit an error: ${raw.message}${where}. Parts of the page may not work.`,
    fix: `The page's script throws an error in the browser: “${raw.message}”${where}. Find the cause and fix it.`,
  };
}
