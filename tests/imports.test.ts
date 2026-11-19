// The shape of the code, as rules its imports keep (this header). The layers, lowest first: a file
// imports only its own layer and the layers below it.
//
//   1. shared/        nothing of ours (assets/ is data: any layer may import it). A library's API (libs/<name>/api/) is
//                     in this layer too: it needs no browser, and the document's object runs it for agents.
//                     gate/ too (the auth gate: its core and its mounts): it imports nothing of ours, and runs apart
//                     from Erga where the deploy puts it in front. gate/build.ts and gate/lower.ts are tools.
//   2. document/      shared/. It gets the directory and the sandbox through DocumentDeps. It knows no agent. Its
//                     files are in six folders, highest first: a file imports only its own folder and those below.
//                       api/      serves the document to callers
//                       room/     runs the open document
//                       history/  cuts versions and brings them back
//                       life/     opens, closes and expires the document
//                       store/    saves and loads bytes
//                       model/    defines what a document is: no IO of its own, and all that the browser has
//   3. server/'s areas (directory, identity, documents, pages, sites, admin, operations) and its other files but app.ts and
//                     api.ts: platform.ts, http.ts, security.ts, live.ts, health.ts. directory/ never
//                     imports identity/; documents/ and admin/ never import operations/.
//   4. agents/        each person's agent and the tools
//   5. server/app.ts and server/api.ts: the route table, and the HTTP API for outside agents
//   6. cloudflare/    the app Worker. It knows no instance's name: the deploy and the request tell it.
//   7. client/        the browser: shared/, and of document/ only model/ (content.ts, pages.ts, merge.ts; names.ts's
//                     types) and api/api.ts's types.
//                     A library's UI (libs/<name>/ui/) is in this layer too. A library's API never imports its UI.
//                     (tests/browser-imports.test.ts follows what the bundles reach)
//   8. deploy/, dev/, tests/, e2e/, client/build.ts and the scripts at the top: anything. Nothing imports them.
//      But deploy/deployer/ (the code that deploys with a credential in someone's cloud account) imports only its own
//      files and Effect: what it can do is what one small folder says.
//
// And:
//   - An area of server/ is imported from outside only through its index.ts. Tools may look inside.
//   - Only cloudflare/ imports cloudflare:workers: the Worker's bindings and types stay there.
//   - `bun erga` reaches no file of .build/ (git ignores it): it runs in a new clone, after only `bun install`.
//   - A layer adds its part of server/platform.ts's Platform with a `declare module`, not an import the other way.
//
// Type-only imports count too: a type from the wrong place is a dependency on it.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");
const AREAS = ["directory", "identity", "documents", "pages", "sites", "admin", "operations", "news"];
/** The repository's folders (an import that names none is a package's). */
const REPO = readdirSync(ROOT).filter((n) => !n.startsWith(".") && n != "node_modules" && statSync(join(ROOT, n)).isDirectory());
const BROWSER_DOCUMENT = ["document/model/content", "document/model/pages", "document/model/merge"];
/** The folders of document/, highest first. */
const DOCUMENT = ["api", "room", "history", "life", "store", "model"];
const folderOf = (path: string) => (path.startsWith("document/") ? DOCUMENT.indexOf(path.split("/")[1]) : null);

/** Every .ts file under these folders, as repo paths. */
function files(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name != "node_modules") walk(p);
      } else if (name.endsWith(".ts")) out.push(relative(ROOT, p));
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return out;
}

/** A file's imports (static and dynamic), relative ones as repo paths without the extension, and whether each is type-only. */
function imports(file: string): { spec: string; type: boolean }[] {
  const src = readFileSync(join(ROOT, file), "utf8");
  const out: { spec: string; type: boolean }[] = [];
  for (const m of src.matchAll(/(?:^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+|import\s*\(\s*)["']([^"']+)["']/gm)) {
    const spec = m[2];
    const path = spec.startsWith(".")
      ? relative(ROOT, resolve(join(ROOT, file), "..", spec))
          .replace(/\.ts$/, "")
          .replace(/\/index$/, "/index")
      : spec;
    out.push({ spec: path, type: !!m[1] });
  }
  return out;
}

/** A file's layer (1-7, as above), or 8 for the tools. */
function layer(path: string): number {
  const top = path.split("/")[0];
  if (top == "shared") return 1;
  if (top == "gate") return path == "gate/build" || path == "gate/lower" ? 8 : 1;
  if (top == "libs") return path.split("/")[2] == "api" ? 1 : 7;
  if (top == "document") return 2;
  if (top == "server") return path == "server/app" || path == "server/api" ? 5 : 3;
  if (top == "agents") return 4;
  if (top == "cloudflare") return 6;
  if (top == "client") return path == "client/build" ? 8 : 7;
  return 8;
}

/** What is wrong with `from` importing `to` (repo paths without .ts), or null. */
function wrong(from: string, to: string, type: boolean): string | null {
  if (from.startsWith("deploy/deployer/"))
    return to.startsWith("deploy/deployer/") || to == "effect" || to.startsWith("effect/")
      ? null
      : "deploy/deployer/ imports only its own files and Effect";
  if (to.startsWith("cloudflare:")) return from.startsWith("cloudflare/") ? null : "only cloudflare/ imports cloudflare:workers";
  if (!REPO.includes(to.split("/")[0])) return null;
  const mine = layer(from),
    theirs = layer(to);
  if (mine == 8 || to.startsWith("assets/")) return null;
  if (mine == 7) {
    if (
      to.startsWith("client/") ||
      to.startsWith("shared/") ||
      to.startsWith("libs/") ||
      BROWSER_DOCUMENT.includes(to) ||
      (type && (to == "document/api/api" || to.startsWith("document/model/")))
    )
      return null;
    return "the browser imports only shared/ and a few files of document/";
  }
  if (theirs == 8) {
    return "nothing above the tools imports them";
  }
  if (theirs == 7) return "only the browser imports client/ and a library's UI";
  if (theirs > mine) return `layer ${mine} imports layer ${theirs}`;
  const mineIn = folderOf(from),
    theirsIn = folderOf(to);
  if (mineIn == -1) return "a file of document/ is in one of its six folders";
  if (mineIn != null && theirsIn != null && theirsIn < mineIn)
    return `document/${DOCUMENT[mineIn]}/ imports document/${DOCUMENT[theirsIn]}/, which is above it`;
  // The document knows no agent: nothing of agents/ (the layers), and no route or file of its own by that name.
  if (mineIn != null && /agent/.test(to)) return "document/ names no agent";
  const area = /^server\/([a-z-]+)\/(.+)$/.exec(to);
  if (area && AREAS.includes(area[1]) && area[2] != "index" && !from.startsWith(`server/${area[1]}/`))
    return `server/${area[1]} is imported through its index.ts`;
  if (from.startsWith("server/directory/") && to.startsWith("server/identity/")) return "directory/ never imports identity/";
  if ((from.startsWith("server/documents/") || from.startsWith("server/admin/")) && to.startsWith("server/operations/"))
    return "documents/ and admin/ never import operations/ (operations/ imports documents/, which imports admin/)";
  return null;
}

test("every import keeps the layers", () => {
  const found: string[] = [];
  const code = ["shared", "gate", "libs", "document", "server", "agents", "cloudflare", "client", "deploy", "dev"];
  for (const f of files(code)) {
    const from = f.replace(/\.ts$/, "");
    for (const { spec, type } of imports(f)) {
      const why = wrong(from, spec, type);
      if (why) found.push(`${f} imports ${spec}: ${why}`);
    }
  }
  expect(found).toEqual([]);
});

test("bun erga reaches no file of the build: it runs in a new clone", () => {
  const seen = new Set<string>();
  const todo = ["deploy/cli/main"];
  const built: string[] = [];
  for (let from = todo.pop(); from; from = todo.pop()) {
    const file = [`${from}.ts`, `${from}/index.ts`].find((f) => !seen.has(f) && existsSync(join(ROOT, f)));
    if (!file) continue;
    seen.add(file);
    for (const { spec, type } of imports(file)) {
      if (spec.startsWith(".build/")) built.push(`${file} imports ${spec}`);
      else if (!type && REPO.includes(spec.split("/")[0])) todo.push(spec);
    }
  }
  expect(built).toEqual([]);
});

test("the rules catch what they are for", () => {
  const no = [
    ["shared/html", "document/model/pages"],
    ["document/life/document", "agents/models"],
    ["document/life/document", "document/room/open"],
    ["document/history/history", "document/api/uploads"],
    ["document/store/storage", "document/room/room"],
    ["document/model/access", "document/store/storage"],
    ["document/room/open", "document/api/http"],
    ["document/tabs", "document/room/room"],
    ["client/shell/main", "document/room/room"],
    ["client/shell/main", "document/api/http"],
    ["server/directory/settings", "server/identity/index"],
    ["server/documents/view", "server/directory/users"],
    ["server/admin/routes", "server/operations/index"],
    ["server/platform", "agents/admin/sessions"],
    ["server/platform", "cloudflare/env"],
    ["agents/tools", "server/api"],
    ["server/identity/settings", "deploy/cli/config"],
    ["cloudflare/platform", "deploy/cli/config"],
    ["cloudflare/blobs", "deploy/cli/config"],
    ["client/shell/main", "deploy/cli/config"],
    ["cloudflare/objects/document", "dev/disk-storage"],
    ["server/health", "deploy/pipeline/pipeline"],
    ["deploy/deployer/deploy", "deploy/pipeline/pipeline"],
    ["deploy/deployer/cloudflare", "shared/bytes"],
    ["deploy/deployer/aws", "deploy/aws/machine"],
    ["deploy/deployer/deploy", "node:fs"],
    ["deploy/deployer/deploy", "bun"],
    ["server/app", "cloudflare:workers"],
    ["client/shell/main", "document/api/host"],
    ["libs/text/api/rules", "libs/text/ui/core"],
    ["libs/text/api/rules", "client/common/link-target"],
    ["libs/text/ui/core", "document/api/host"],
    ["document/api/operations", "libs/text/ui/editor"],
  ];
  for (const [from, to] of no) expect([from, to, wrong(from, to, true)]).not.toEqual([from, to, null]);
  const yes = [
    ["client/shell/main", "document/api/api", true],
    ["client/shell/main", "document/model/names", true],
    ["client/shell/main", "document/model/pages", false],
    ["document/api/host", "document/life/document", false],
    ["document/room/open", "document/history/history", true],
    ["libs/text/ui/edit", "libs/text/api/rules", false],
    ["document/api/operations", "libs/text/api/rules", false],
    ["client/shell/main", "libs/text/ui/editor", false],
    ["cloudflare/platform", "server/health", true],
    ["tests/room.test", "cloudflare/objects/document", false],
    ["deploy/deployer/deploy", "deploy/deployer/job", false],
    ["deploy/deployer/cloudflare", "effect/Schedule", false],
    ["deploy/pipeline/pipeline", "deploy/deployer/cloudflare", false],
  ] as const;
  for (const [from, to, type] of yes) expect([from, to, wrong(from, to, type)]).toEqual([from, to, null]);
});

test("the document's own routes name no agent: a caller is a user, in person or via something", () => {
  const routes = ["document/api/api.ts", "document/api/http.ts"].flatMap((f) =>
    [...readFileSync(join(ROOT, f), "utf8").matchAll(/"\/api\/[^"]*"/g)].map((m) => m[0])
  );
  expect(routes.length).toBeGreaterThan(5);
  expect(routes.filter((r) => /agent/.test(r))).toEqual([]);
});
