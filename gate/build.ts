// Builds the gate's AWS functions, each one file with the deploy's settings in it (none has environment variables at
// the edge): the CloudFront Functions (mounts/cloudfront.ts) and the Lambda@Edge function (mounts/lambda.ts). A
// CloudFront Function must stay under CloudFront's 10 KB, in the syntax that its runtime takes (lower.ts): a build
// over the size, or with syntax that the runtime refuses, fails here.

import { join } from "node:path";
import type { Config } from "./core.ts";
import { lower, refused } from "./lower.ts";
import type { Oidc } from "./oidc.ts";

/** CloudFront's limit on a function's code. */
export const FUNCTION_MAX = 10 * 1024;

const build = async (entry: string, define: Record<string, string>, external: string[], target: "browser" | "node") => {
  const out = await Bun.build({ entrypoints: [join(import.meta.dir, entry)], minify: true, define, external, target, format: "esm" });
  if (!out.success) throw new Error(out.logs.join("\n"));
  return out.outputs[0].text();
};

/** The gate's four CloudFront Functions (mounts/cloudfront.ts). */
export const PARTS = ["edge", "agents", "request", "response"] as const;
export type Part = (typeof PARTS)[number];

/**
 * One CloudFront Function's code for a deploy's settings (the key is not among them: it is in the KeyValueStore).
 * `module`: with its export kept, for the tests to load; CloudFront takes none, and calls `handler` by its name.
 */
export async function buildFunction(part: Part, config: Omit<Config, "key">, module = false): Promise<string> {
  const built = lower(
    await build(`mounts/cloudfront-${part}.ts`, { GATE_CONFIG: JSON.stringify(config) }, ["crypto", "cloudfront"], "node")
  );
  const name = /export\s*\{[^}]*?([\w$]+) as handler[^}]*\};?\s*$/.exec(built)?.[1];
  if (!name) throw new Error("The build has no handler.");
  const code = module ? built : built.replace(/export\s*\{[^}]*\};?\s*$/, `function handler(e){return ${name}(e)}`);
  const size = new TextEncoder().encode(code).length;
  if (size > FUNCTION_MAX)
    throw new Error(`The gate's CloudFront Function "${part}" is ${size} bytes: CloudFront takes ${FUNCTION_MAX} at most.`);
  const syntax = refused(code);
  if (syntax.length) throw new Error(`The gate's CloudFront Function "${part}" has syntax that CloudFront refuses: ${syntax.join(", ")}.`);
  return code;
}

/** The Lambda@Edge function's code: the issuers, and the name of each one's client secret in Systems Manager. */
export const buildLambda = (settings: { shell: string; region: string; idp: Record<string, Omit<Oidc, "secret"> & { secret: string }> }) =>
  build("mounts/lambda.ts", { GATE_LAMBDA: JSON.stringify(settings) }, ["@aws-sdk/client-ssm"], "node");
