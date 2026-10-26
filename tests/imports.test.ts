// The shape of the code, as rules the imports must keep (README.md, "The layout"):
//
//   1. Only cloudflare/ and control/ import cloudflare:workers or a file of
//      cloudflare/: the Workers' bindings and types stay there. The tests test
//      cloudflare/'s files directly.
//   2. server/ and document/ never import cloudflare/: the app runs on the
//      Platform alone (server/platform.ts), so the tests run it under bun.
//   3. An area of server/ (directory, identity, documents, pages, home,
//      admin) is imported from outside only through its index.ts, its
//      interface; its other files are its own. Tests may look inside, and so
//      may deploy/locked-settings.ts, which the Worker's config loads before
//      anything else and which reads the settings' definitions alone.
//
// Type-only imports count too: a type from the wrong place is a dependency on it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");
const AREAS = ["directory", "identity", "documents", "pages", "home", "admin"];

/** Every .ts file under these folders, as repo paths. */
function files(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name != "node_modules") walk(p); } else if (name.endsWith(".ts")) out.push(relative(ROOT, p));
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return out;
}

/** A file's import specifiers (static and dynamic), relative ones resolved to repo paths without the extension. */
function imports(file: string): string[] {
  const src = readFileSync(join(ROOT, file), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
    const spec = m[1];
    if (!spec.startsWith(".")) { out.push(spec); continue; }
    out.push(relative(ROOT, resolve(join(ROOT, file), "..", spec)).replace(/\.ts$/, ""));
  }
  return out;
}

const CODE = ["server", "document", "agents", "dev", "shared", "client", "cloudflare", "deploy"];

test("rule 1: only cloudflare/ and control/ import cloudflare:workers or cloudflare/'s files", () => {
  const wrong: string[] = [];
  for (const f of files(CODE.filter((d) => d != "cloudflare"))) {
    for (const i of imports(f)) if (i == "cloudflare:workers" || i.startsWith("cloudflare/")) wrong.push(`${f} imports ${i}`);
  }
  expect(wrong).toEqual([]);
});

test("rule 2: server/ and document/ never import cloudflare/", () => {
  const wrong: string[] = [];
  for (const f of files(["server", "document"])) for (const i of imports(f)) if (i.startsWith("cloudflare")) wrong.push(`${f} imports ${i}`);
  expect(wrong).toEqual([]);
});

test("rule 3: an area of server/ is imported from outside only through its index.ts", () => {
  const wrong: string[] = [];
  for (const f of files(CODE).filter((f) => f != "deploy/locked-settings.ts")) {
    for (const i of imports(f)) {
      const m = /^server\/([a-z-]+)\/(.+)$/.exec(i);
      if (!m || !AREAS.includes(m[1]) || m[2] == "index") continue;
      if (f.startsWith(`server/${m[1]}/`)) continue;
      wrong.push(`${f} imports ${i}`);
    }
  }
  expect(wrong).toEqual([]);
});
