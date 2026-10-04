#!/usr/bin/env bun
// Builds the factory's VM image (factory/vm/Dockerfile) with Docker, tagged
// by a hash of what goes in it, so an unchanged image is reused at once.
//
//   bun factory/vm/build.ts            build (or find) the image; prints its tag
//   bun factory/vm/build.ts --print    print the tag it would have, build nothing
//
// The context is staged in a temporary folder: the Dockerfile, package.json
// and bun.lock (the dependencies the image caches), and the VM's scripts
// (factory/vm/*.ts, as /opt/factory in the image). Nothing else of the repo
// goes in: a task clones the source when it starts.
//
// Node's APIs only, not Bun's: the dev server (Vite, under Node) uses it too.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const VM = join(ROOT, "factory/vm");
export const IMAGE = "erga-factory";

/** The files that make the image, by their path in the context. */
function inputs(): Record<string, string> {
  const files: Record<string, string> = {
    Dockerfile: join(VM, "Dockerfile"),
    "package.json": join(ROOT, "package.json"),
    "bun.lock": join(ROOT, "bun.lock"),
  };
  for (const name of readdirSync(VM).sort()) if (name.endsWith(".ts") && name != "build.ts") files[`scripts/${name}`] = join(VM, name);
  return files;
}

/** The image's tag: erga-factory:<the first 12 hex of a hash of its inputs, and the Bun version>. */
export function imageTag(): string {
  const h = createHash("sha256");
  const bun = readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
  h.update(`bun ${bun}\n`);
  for (const [path, file] of Object.entries(inputs())) h.update(`${path}\n`).update(readFileSync(file)).update("\n");
  return `${IMAGE}:${h.digest("hex").slice(0, 12)}`;
}

/** Whether Docker answers on this machine. */
export function dockerUp(): boolean {
  try { return spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 15_000 }).status == 0; } catch { return false; }
}

/** The image, built if there isn't one with this tag yet. `log` hears Docker's output. */
export async function ensureImage(log: (line: string) => void = () => {}): Promise<string> {
  const tag = imageTag();
  if (spawnSync("docker", ["image", "inspect", tag], { stdio: "ignore" }).status == 0) return tag;
  const ctx = mkdtempSync(join(tmpdir(), "erga-factory-image-"));
  try {
    for (const [path, file] of Object.entries(inputs())) {
      mkdirSync(join(ctx, path, ".."), { recursive: true });
      cpSync(file, join(ctx, path));
    }
    const bun = readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
    log(`building ${tag} (the first build downloads Chromium and Claude Code: a few minutes)`);
    const p = spawn("docker", ["build", "--build-arg", `BUN_VERSION=${bun}`, "-t", tag, "-t", `${IMAGE}:latest`, ctx], { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const take = (c: Buffer) => { const t = c.toString(); tail = (tail + t).slice(-4000); for (const l of t.split("\n")) if (l.trim()) log(l); };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    const code = await new Promise<number>((resolve) => p.on("close", (c) => resolve(c ?? 1)));
    if (code != 0) throw new Error(`docker build failed:\n${tail}`);
    return tag;
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.includes("--print")) console.log(imageTag());
  else {
    if (!dockerUp()) { console.error("Docker isn't running here."); process.exit(1); }
    console.log(await ensureImage((l) => console.error(l)));
  }
}
