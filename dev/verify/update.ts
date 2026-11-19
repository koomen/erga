// What a deploy of the verify suite deploys again (dev/verify.ts, the steps `deploy` and `update`). A setting's deploy
// is a list of parts, in order: a Worker, the Erga release, on AWS the stacks and the machine's programs. Each part
// has a hash of what it deploys: its built code, its settings and its secrets. A part whose hash is the one of its
// last deploy stays as it is: `bun erga verify update` redeploys only what changed, on infrastructure that a run kept
// (`--keep`). A first deploy has no hash on record, so it deploys each part.
//
//   the hash     of the build's output, never of the sources: a Worker's bundle (bundleHash), the release's files
//                (releaseHash), on AWS the templates that carry the gate's code. The same code gives the same hash in
//                each work folder
//   the release  is named by its hash (buildRelease): the health report of a new release says a new name, so a check
//                of the version proves that the new code runs
//   in place     an update on AWS changes resources in place only (remakes): it never makes the network, the machine,
//                a distribution or a certificate again

import { resolve } from "node:path";
import type { Change } from "../../deploy/aws/stack.ts";
import { buildHere } from "../../deploy/pipeline/build.ts";
import type { Release } from "../../deploy/deployer/release-format.ts";
import { sh } from "./run.ts";

const ROOT = resolve(import.meta.dir, "../..");
const sha = (v: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(v).digest("hex");

/** One hash of some values: of their JSON. */
export const hashOf = (...values: unknown[]): string => sha(JSON.stringify(values));

/** A part of a setting's deploy. `hash`: of what `deploy` would deploy now (asked just before, after the parts before it). */
export interface Part {
  name: string;
  hash: () => string | Promise<string>;
  deploy: () => unknown;
}

/**
 * Deploys each part whose hash is not the one on record (`had`: by the part's name), in order, and records each new
 * hash at once (`save`), so a deploy that stops keeps what it did. The names of the parts it deployed. A part that
 * fails stops it: its hash is not recorded, and the parts after it do not run.
 */
export async function redeploy(
  parts: Part[],
  had: Record<string, string>,
  save: (now: Record<string, string>) => void,
  log: (line: string) => void
): Promise<string[]> {
  const did: string[] = [];
  let now = had;
  for (const p of parts) {
    const hash = await p.hash();
    if (now[p.name] == hash) {
      log(`${p.name}: as its last deploy (${hash.slice(0, 12)}): it stays`);
      continue;
    }
    log(`${p.name}: ${now[p.name] ? `changed (${now[p.name].slice(0, 12)} to ${hash.slice(0, 12)})` : "new"}: deploying...`);
    await p.deploy();
    now = { ...now, [p.name]: hash };
    save(now);
    did.push(p.name);
  }
  return did;
}

/** The hash of a Worker's code as built: its bundle (`main`: from the repository's root), minified, so with no path in it. */
export async function bundleHash(main: string): Promise<string> {
  const out = await Bun.build({
    entrypoints: [resolve(ROOT, main)],
    target: "browser",
    minify: true,
    external: ["cloudflare:*", "node:*"],
  });
  if (!out.success) throw new Error(`${main} does not build: ${out.logs.map(String).join("; ")}`);
  return sha((await Promise.all(out.outputs.map((o) => o.text()))).join("\n"));
}

/** The hash of a release's files: the Worker's modules, the static files, the migrations and its bindings. Not its name or its time. */
export function releaseHash(r: Release): string {
  const files = (m: Record<string, string | Uint8Array>) =>
    Object.keys(m)
      .sort()
      .map((name) => [name, sha(m[name])]);
  return hashOf(r.worker, r.mainModule, r.bindings ?? null, files(r.modules), files(r.assets), files(r.migrations));
}

/** Builds this checkout: its release, named by the first 12 characters of its hash. */
export async function buildRelease(log: (line: string) => void): Promise<Release> {
  sh(["bun", "run", "build"], { cwd: ROOT });
  sh(["bun", "run", "release"], { cwd: ROOT });
  const built = await buildHere("this checkout", log, true);
  return { ...built, version: releaseHash(built).slice(0, 12) };
}

/**
 * The changes of a change set that make a resource again: each one that adds, removes or replaces a resource. An
 * update refuses a change set with any (aws.ts). Not the gate's Lambda@Edge version: each build of the Lambda is a
 * new version (deploy/aws/template.ts), and the old one stays.
 */
export const remakes = (changes: Change[]): Change[] =>
  changes.filter((c) => c.type != "AWS::Lambda::Version" && (c.action != "Modify" || !!c.replacement));
