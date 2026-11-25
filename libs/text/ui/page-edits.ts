// The page's own edits (ergaEditor.call), made in the page: the editor runs the page's API module (its code, as the
// room has it) here, where the page's own scripts run anyway, and turns its answer into a change to the source
// (shared/page-ops.ts, the same checks the server makes on the sandbox's answer). No round trip: the change shows in the
// frame the person dropped or clicked in, as a typed letter does, and goes to the room as their own edit.

import { apiPathOf, changesOf, type Planned } from "../../../shared/page-ops";

type Api = { apply?: (html: string, edit: string, input: unknown) => unknown };

/** The module last imported: its code, and it (imported once, so a call needs no wait). */
let last: { code: string; module: Promise<{ default?: Api }> } | null = null;

/** The page's module, imported in the page from its code (a blob: URL: the same code is the same module). */
function load(code: string): Promise<{ default?: Api }> {
  if (last?.code != code) {
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    const module = import(url) as Promise<{ default?: Api }>;
    void module.catch(() => {}).finally(() => URL.revokeObjectURL(url));
    last = { code, module };
  }
  return last.module;
}

/** The API module's code for a page (`path`, its text `html`): from `read`, a file of the document; null if none. */
export function apiCode(path: string, html: string, read: (path: string) => string | undefined): string | null {
  const module = apiPathOf(path, html);
  return module == null ? null : (read(module) ?? null);
}

/** Imports the module now, so the person's first edit doesn't wait for it. */
export function warm(code: string | null): void {
  if (code != null) void load(code).catch(() => {});
}

const EDIT_TIMEOUT_MS = 5000;

/** One edit of the page's own, on its text `html`: the change, or why not. Fails if `apply` doesn't settle within `timeoutMs`. */
export async function runPageEdit(
  code: string,
  html: string,
  edit: string,
  input: unknown,
  timeoutMs = EDIT_TIMEOUT_MS
): Promise<Planned | { error: string }> {
  let api: Api | undefined;
  try {
    api = (await load(code)).default;
  } catch (e) {
    return { error: `the page's API module doesn't load: ${(e as Error).message}` };
  }
  if (!api || typeof api != "object")
    return { error: "the page's API module has no default export: export default { name, edits, apply }" };
  if (typeof api.apply != "function") return { error: "the page's API module's default export has no apply(html, edit, input)" };
  let answer: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = api.apply(html, edit, input);
    const raw =
      pending instanceof Promise || (pending != null && typeof (pending as PromiseLike<unknown>).then == "function")
        ? await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
            }),
          ])
        : pending;
    // (As the sandbox answers: JSON, so the page's answer is plain data.)
    answer = JSON.parse(JSON.stringify(raw ?? null));
  } catch (e) {
    return { error: `the page's API failed: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
  const r = changesOf(html, edit, answer);
  return "refused" in r ? { error: r.refused } : r;
}
