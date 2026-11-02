// The sandbox a page's own API runs in (document/page-api.ts): a Worker of its own for each module's code, which the
// Worker Loader (env.LOADER) starts from that code alone. It has no bindings and no network (globalOutbound: null),
// and gets nothing but the call: the page's HTML and the edit's input. The same code is the same Worker, kept warm.

import type { Sandbox } from "../document/page-api";
import { SANDBOX_MAIN } from "../document/page-api";
import { sha256Hex } from "../shared/bytes";

/** How long one call may take before it's refused. */
const CALL_MS = 5_000;

export const sandboxOf =
  (loader: WorkerLoader | undefined): Sandbox =>
  async (code, call) => {
    if (!loader) throw new Error("this server has no Worker Loader (the LOADER binding), so it can't run a page's own API");
    const worker = loader.get(`page-api:${await sha256Hex(code)}`, () => ({
      compatibilityDate: "2026-09-30",
      mainModule: "main.js",
      modules: { "main.js": SANDBOX_MAIN, "api.js": code },
      globalOutbound: null,
    }));
    const timeout = new Promise<never>((_, fail) => setTimeout(() => fail(new Error(`it took over ${CALL_MS / 1000} s`)), CALL_MS));
    const r = await Promise.race([
      worker.getEntrypoint().fetch("http://sandbox/", { method: "POST", body: JSON.stringify(call) }),
      timeout,
    ]);
    const answer = (await r.json()) as { ok: boolean; value?: unknown; error?: string };
    if (!answer.ok) throw new Error(answer.error ?? "it failed");
    return answer.value;
  };
