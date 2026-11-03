// The shape of the code, as rules its imports keep (README.md, "The layout"). The layers, lowest first: a file
// imports only its own layer and the layers below it.
//
//   1. shared/        nothing of ours (assets/ is data: any layer may import it). A library's API (libs/<name>/api/) is
//                     in this layer too: it needs no browser, and the document's object runs it for agents.
//   2. document/      shared/. It gets the directory and the agents through DocumentDeps.
//   3. server/'s areas (directory, identity, documents, pages, home, admin, operations) and its other files but app.ts and
//                     api.ts: platform.ts, http.ts, security.ts, live.ts, health.ts. directory/ never imports identity/;
//                     documents/ and admin/ never import operations/.
//   4. control/       the control plane: Erga's repository, its deploys, installs, the Ops page. Also deploy/targets.ts.
//   5. agents/        both embedded agents (the admin agent's tools work the control plane)
//   6. server/app.ts and server/api.ts: the route table, and the HTTP API for outside agents
//   7. cloudflare/    the app Worker. Also deploy/targets.ts.
//   8. client/        the browser: shared/, and of document/ only content.ts, pages.ts, merge.ts and api.ts's types.
//                     A library's UI (libs/<name>/ui/) is in this layer too. A library's API never imports its UI.
//                     (tests/browser-imports.test.ts follows what the bundles reach)
//   9. deploy/, dev/, tests/, e2e/, client/build.ts and the scripts at the top: anything. Nothing imports them but
//      deploy/targets.ts (layers 4 and 7) and dev/mock-cloudflare.ts with dev/mock-builder.ts, the pretend Cloudflare of local development
//      and the tests (layers 4 and 7, when ERGA_DEPLOY_MOCK is set).
//
// And:
//   - control/ is a Worker of its own, and never imports cloudflare/, the app Worker: not even a type. Its bindings
//     are control/env.ts's, and the app Worker hosts its objects only on a HostEnv (cloudflare/dev-entry.ts).
//   - An area of server/ is imported from outside only through its index.ts. Tools may look inside, and so may
//     deploy/locked-settings.ts, which the Worker's config loads before anything else and which reads the settings'
//     definitions alone.
//   - Only cloudflare/ and control/ import cloudflare:workers: the Workers' bindings and types stay there.
//   - A layer adds its part of server/platform.ts's Platform with a `declare module`, not an import the other way.
//
// Type-only imports count too: a type from the wrong place is a dependency on it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");
const AREAS = ["directory", "identity", "documents", "pages", "home", "admin", "operations", "news"];
/** The repository's folders (an import that names none is a package's). */
const REPO = readdirSync(ROOT).filter((n) => !n.startsWith(".") && n != "node_modules" && statSync(join(ROOT, n)).isDirectory());
const BROWSER_DOCUMENT = ["document/content", "document/pages", "document/merge"];

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

/** A file's layer (1-8, as above), or 9 for the tools. */
function layer(path: string): number {
  const top = path.split("/")[0];
  if (top == "shared") return 1;
  if (top == "libs") return path.split("/")[2] == "api" ? 1 : 8;
  if (top == "document") return 2;
  if (top == "server") return path == "server/app" || path == "server/api" ? 6 : 3;
  if (top == "control") return 4;
  if (top == "agents") return 5;
  if (top == "cloudflare") return 7;
  if (top == "client") return path == "client/build" ? 9 : 8;
  return 9;
}

/** What is wrong with `from` importing `to` (repo paths without .ts), or null. */
function wrong(from: string, to: string, type: boolean): string | null {
  if (to.startsWith("cloudflare:"))
    return from.startsWith("cloudflare/") || from.startsWith("control/") ? null : "only cloudflare/ and control/ import cloudflare:workers";
  if (!REPO.includes(to.split("/")[0])) return null;
  const mine = layer(from),
    theirs = layer(to);
  if (mine == 9 || to.startsWith("assets/")) return null;
  if (mine == 8) {
    if (
      to.startsWith("client/") ||
      to.startsWith("shared/") ||
      to.startsWith("libs/") ||
      BROWSER_DOCUMENT.includes(to) ||
      (type && to == "document/api")
    )
      return null;
    return "the browser imports only shared/ and a few files of document/";
  }
  if (theirs == 9) {
    if ((to == "deploy/targets" || to == "dev/mock-cloudflare" || to == "dev/mock-builder") && (mine == 4 || mine == 7)) return null;
    return "nothing above the tools imports them";
  }
  if (theirs == 8) return "only the browser imports client/ and a library's UI";
  if (theirs > mine) return `layer ${mine} imports layer ${theirs}`;
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
  const code = ["shared", "libs", "document", "server", "agents", "control", "cloudflare", "client", "deploy", "dev"];
  for (const f of files(code)) {
    const from = f.replace(/\.ts$/, "");
    if (from == "deploy/locked-settings") continue;
    for (const { spec, type } of imports(f)) {
      const why = wrong(from, spec, type);
      if (why) found.push(`${f} imports ${spec}: ${why}`);
    }
  }
  expect(found).toEqual([]);
});

test("the rules catch what they are for", () => {
  const no = [
    ["shared/html", "document/pages"],
    ["document/document", "agents/models"],
    ["server/directory/settings", "server/identity/index"],
    ["server/documents/view", "server/directory/users"],
    ["server/admin/routes", "server/operations/index"],
    ["server/platform", "agents/admin/sessions"],
    ["server/platform", "control/source/index"],
    ["control/deploys/api", "agents/admin/sessions"],
    ["control/routes", "server/identity/session"],
    ["agents/tools", "server/api"],
    ["server/identity/settings", "deploy/targets"],
    ["cloudflare/objects/document", "dev/disk-storage"],
    ["control/routes", "cloudflare/index"],
    ["control/platform", "cloudflare/d1"],
    ["control/index", "cloudflare/env"],
    ["server/app", "cloudflare:workers"],
    ["client/shell/main", "document/host"],
    ["libs/text/api/rules", "libs/text/ui/core"],
    ["libs/text/api/rules", "client/common/link-target"],
    ["libs/text/ui/core", "document/host"],
    ["agents/document/tools", "libs/text/ui/editor"],
  ];
  for (const [from, to] of no) expect([from, to, wrong(from, to, true)]).not.toEqual([from, to, null]);
  const yes = [
    ["client/shell/main", "document/api", true],
    ["libs/text/ui/edit", "libs/text/api/rules", false],
    ["agents/document/tools", "libs/text/api/rules", false],
    ["client/shell/main", "libs/text/ui/editor", false],
    ["agents/admin/sessions", "control/source/index", false],
    ["control/source/page", "server/admin/index", false],
    ["cloudflare/d1", "control/d1", false],
    ["cloudflare/index", "control/index", false],
    ["tests/room.test", "cloudflare/objects/document", false],
  ] as const;
  for (const [from, to, type] of yes) expect([from, to, wrong(from, to, type)]).toEqual([from, to, null]);
});
