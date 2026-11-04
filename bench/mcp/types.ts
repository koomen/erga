import type { Page } from "playwright-core";

/** A document's files: relative path to text (text files only; binary files are left out). */
export type Files = Record<string, string>;

/** A real headless Chromium (playwright-core) on the final files, served from a local folder over http. */
export interface Probe {
  /** Opens a page (relative path, default index.html), returns a playwright-core Page. Requests outside the folder are blocked. */
  open(path?: string): Promise<Page>;
  /** The page's problems so far: script errors, and the document's files that failed to load. */
  errors(page: Page): string[];
}

export interface Task {
  /** For example "essay-typo". */
  id: string;
  /** The corpus folder's name. */
  doc: string;
  /** The task's text, as a person asks it. */
  prompt: string;
  /** Returns the list of failures (empty = pass). Deterministic. */
  check(files: Files, probe: Probe): Promise<string[]> | string[];
}
