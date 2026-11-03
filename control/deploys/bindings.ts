// The app Worker's bindings in Cloudflare's upload form. Two sorts:
//
//   - the kinds the pipeline makes for each target (TARGET_KINDS): a database, a bucket, the target's settings,
//     secrets and services. Their metadata differs from target to target: account.ts (workerMetadata) makes it.
//   - every other kind: the same metadata on every target. The release carries it, written by the release's own
//     code (deploy/release.ts: `bindings` in release.json), and the pipeline sends it as it is.
//
// So a release with a new kind of binding that needs no work of the pipeline deploys with the control Worker that runs
// now: no ordering of main before staging (2026-11-03: the BROWSER binding failed two staging deploys). A new kind
// that does need the pipeline's work is refused before the deploy changes anything (bindingsProblem).

import type { BuiltBinding, Release } from "./release-format";

/** The kinds of binding (as `cf build` names them) whose metadata the pipeline makes for each target. */
export const TARGET_KINDS: readonly string[] = ["durable-object", "d1", "text", "secret", "service", "artifacts", "r2"];

/** A name as Cloudflare's API writes it: `worker-loader` and `exportName` become `worker_loader` and `export_name`. */
const snake = (s: string) =>
  s
    .replace(/-/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

/**
 * One binding in Cloudflare's metadata form, as `cf build` describes it: its kind and fields in snake case.
 * A kind whose form differs gets its own line here, in the same change that uses it: the release carries the result.
 */
export function cloudflareBinding(name: string, b: BuiltBinding): Record<string, unknown> {
  const { type, ...fields } = b;
  return { type: snake(type), name, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [snake(k), v])) };
}

/** The release's own metadata for each binding the pipeline does not make (deploy/release.ts writes it into release.json). */
export function releaseBindings(env: Record<string, BuiltBinding>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([, b]) => !TARGET_KINDS.includes(b.type))
      .map(([n, b]) => [n, cloudflareBinding(n, b)])
  );
}

/**
 * The metadata of a binding the pipeline does not make: the release's own, or (a release from before it carried
 * its bindings) the same translation done here. Null: the release says the pipeline must make it, and this
 * pipeline doesn't know how.
 */
export function passedBinding(release: Release, name: string, b: BuiltBinding): Record<string, unknown> | null {
  if (!release.bindings) return cloudflareBinding(name, b);
  return release.bindings[name] ?? null;
}

/**
 * Why this pipeline can't deploy the release's bindings, or null. Checked before the deploy changes anything, so a
 * release that needs a newer pipeline stops at once, with the target as it was.
 */
export function bindingsProblem(release: Release): string | null {
  const missing = Object.entries(release.worker.env).filter(([n, b]) => !TARGET_KINDS.includes(b.type) && !passedBinding(release, n, b));
  if (!missing.length) return null;
  const list = missing.map(([n, b]) => `${n} (${b.type})`).join(", ");
  return `Release ${release.version} has a binding that the deploy pipeline must make for each target, and the control Worker that runs now can't: ${list}. Nothing changed. The pipeline's change (control/deploys/) must reach main, and the control Worker must deploy it, before this release can deploy.`;
}
