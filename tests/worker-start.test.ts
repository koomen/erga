// What the Worker reads before its first answer: the modules cloudflare/index.ts reaches by static imports. A new
// copy of the Worker reads them all first, so the large parts that few requests need stay out of them, behind an
// import() at their first use: the model providers' code (agents/models.ts, document/versions.ts) and the landing
// project's files (cloudflare/platform.ts). The deploy's build minifies the rest (vite.config.ts).

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");

/** A file's static imports that are not type-only: packages by name, our files as repo paths. */
function staticImports(file: string): string[] {
  const src = readFileSync(join(ROOT, file), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^;"']*?\sfrom\s+)?["']([^"']+)["']/gm)) {
    const spec = m[1];
    if (!spec.startsWith(".")) {
      out.push(spec);
      continue;
    }
    const base = resolve(join(ROOT, file), "..", spec);
    const path = [base, `${base}.ts`, join(base, "index.ts")].find((p) => existsSync(p) && !p.endsWith("/"));
    if (path?.endsWith(".ts")) out.push(relative(ROOT, path));
  }
  return out;
}

/** Everything `entry` reaches by static imports: our files and the packages' names. */
function reached(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  for (let file = queue.pop(); file; file = queue.pop()) {
    for (const next of staticImports(file)) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (next.endsWith(".ts") && existsSync(join(ROOT, next))) queue.push(next);
    }
  }
  return seen;
}

test("the Worker starts without the model providers' code and the landing project's files", () => {
  const start = reached("cloudflare/index.ts");
  // The walk works: it reaches the agents' loop and the document.
  expect(start.has("agents/models.ts")).toBe(true);
  expect(start.has("document/versions.ts")).toBe(true);
  const late = [...start].filter(
    (m) =>
      m.startsWith("@effect/ai-") ||
      m.startsWith("@earendil-works/pi-ai") ||
      m == "agents/pi-model.ts" ||
      m == "cloudflare/landing-files.ts"
  );
  expect(late).toEqual([]);
});

test("the deploy's build minifies the Worker", () => {
  // In Node, as the build runs: the Worker's config doesn't load in Bun.
  const script = `import("vite").then(async (v) => {
    const config = await v.resolveConfig({ logLevel: "silent" }, "build");
    console.log(JSON.stringify(Object.entries(config.environments).map(([name, env]) => [name, !!env.build.minify])));
  })`;
  const run = Bun.spawnSync(["node", "--no-experimental-webstorage", "-e", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  expect(run.stderr.toString()).toBe("");
  const worker = (JSON.parse(run.stdout.toString().trim().split("\n").pop()!) as [string, boolean][]).filter(([name]) => name != "client");
  expect(worker.length).toBeGreaterThan(0);
  expect(worker.filter(([, minify]) => !minify)).toEqual([]);
}, 60_000);
