// The render tools (window.__ergaRender, client/inline/page-render.ts) as the server's browser calls them in a page
// (cloudflare/render.ts): put into the page before the first call.

import type { PageRender } from "../shared/agent-log";
import { inlineCall } from "../server/pages/index";

/** Runs an expression in a page, and gives its value. */
export type Runner = <T>(expression: string) => Promise<T>;

/**
 * One of the render tools in the page that `where` runs in, with its arguments. A page that loaded again since the
 * tools went in (its own script, the editor for a changed file) has none: they go in again, and the call runs on the
 * page as it is now.
 */
export const renderTools = (where: Runner) => {
  const install = () => where(inlineCall("page-render"));
  let installed: Promise<unknown> | null = null;
  return async <K extends keyof PageRender>(name: K, ...args: Parameters<PageRender[K]>) => {
    type Value = Awaited<ReturnType<PageRender[K]>>;
    const run = () =>
      where<{ gone: true } | { value: Value }>(
        `(async () => { const r = globalThis.__ergaRender; return r ? { value: await r[${JSON.stringify(name)}](...${JSON.stringify(args)}) } : { gone: true }; })()`
      );
    await (installed ??= install());
    let answer = await run();
    if ("gone" in answer) {
      await (installed = install());
      answer = await run();
    }
    if ("gone" in answer) throw new Error("The page loaded again while Erga looked at it. Try again.");
    return answer.value;
  };
};
