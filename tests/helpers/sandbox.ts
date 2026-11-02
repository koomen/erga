// The sandbox a page's own API runs in, for the tests (bun): the same main module as the Worker Loader's
// (document/page-api.ts, SANDBOX_MAIN), the code beside it in a folder of its own, imported in this process.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOX_MAIN, type Sandbox } from "../../document/page-api";

export const testSandbox: Sandbox = async (code, call) => {
  const dir = mkdtempSync(join(tmpdir(), "erga-sandbox-"));
  writeFileSync(join(dir, "main.js"), SANDBOX_MAIN);
  writeFileSync(join(dir, "api.js"), code);
  const main = (await import(join(dir, "main.js"))).default as { fetch(r: Request): Promise<Response> };
  const answer = (await (await main.fetch(new Request("http://sandbox/", { method: "POST", body: JSON.stringify(call) }))).json()) as {
    ok: boolean;
    value?: unknown;
    error?: string;
  };
  if (!answer.ok) throw new Error(answer.error ?? "it failed");
  return answer.value;
};
