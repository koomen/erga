// Problems with the page that the page itself reports (a script error, a file that didn't load: the page's problem
// watch, client/inline/page-problems.ts, tells the viewer each), in words; and the editor's notices that the agent can
// fix (a paragraph whose HTML is broken), which it reports the same way.

/** Something wrong with the document that the user can see, and how the agent could fix it. */
export interface PageProblem {
  /** Identifies the problem across renders (the same error, the same missing file). */
  key: string;
  message: string;
  /** A prompt asking the agent to fix it. */
  fix: string;
}

export type RawProblem =
  | { kind: "resource"; tag: string; url: string }
  | { kind: "script"; message: string; file: string; line: number; stack?: string }
  /** `draft`: `fix` is the start of a request for the person to complete in the agent's box, not one to send as it is. */
  | { kind: "notice"; message: string; fix: string; draft?: boolean };

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

/**
 * A problem the page reported, in words, with a prompt for the agent to fix it: `origin` is the page's, `base` its
 * folder there, for the names of its files.
 */
export function describeProblem(raw: Exclude<RawProblem, { kind: "notice" }>, base: string, origin: string): PageProblem | null {
  const local = (u: string) => {
    try {
      const url = new URL(u, origin + base);
      return url.origin == origin && url.pathname.startsWith(base) ? decodeURIComponent(url.pathname.slice(base.length)) : u;
    } catch {
      return u;
    }
  };
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
