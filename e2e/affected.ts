// Which end-to-end tests a change needs, for `bun run test` (e2e/run.ts). One
// rule, kept simple so it is never wrong by leaving a test out:
//
//   1. A changed test file (e2e/**/*.e2e.ts) runs.
//   2. A changed file under an area below runs that area's folder of tests.
//   3. Text that no test reads (Markdown, docs/) needs none.
//   4. Anything else, and anything in ALL, runs every test.
//
// So the table only ever narrows a run; a file it doesn't know runs everything.
// What changed: the files that differ from where this branch left staging
// (TEST_BASE, else origin/staging, else staging, else main), committed or not,
// and new files git doesn't ignore.
//
//   bun e2e/affected.ts [FILE...]   prints what to run, one a line ("ALL" for everything)

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Each folder of tests, and the files whose change it checks (a folder ends in /). */
export const AREAS: Record<string, string[]> = {
  "e2e/page/": [
    "src/page/editor.ts", "src/page/main.ts", "src/page/manuscript.ts", "src/page/markdown.ts", "src/page/merge.ts", "src/page/collab.ts",
    "src/page/remote.ts", "src/page/frame.ts", "src/page/bridge.ts", "src/page/layout.ts", "src/page/agent-chat.ts", "src/page/attach-ui.ts",
    "src/page/share-agent.ts", "room.ts", "src/room/", "host.ts", "agent.ts", "workspace.ts", "page.html", "page.js", "frame.js", "style.css",
    "dev/agent-key.ts", "e2e/fixtures/", "src/page/attach.ts",
  ],
  "e2e/factory/": [
    "factory/", "worker/factory.ts", "dev/factory.ts", "dev/git-server.ts", "worker/source.ts", "source/", "tokens.ts",
    "src/page/factory-agent.ts", "src/page/agent-chat.ts", "src/page/share-agent.ts", "src/page/admin-share.ts", "factory-agent.js", "admin-share.js",
    "src/page/chime.ts", "src/page/admin-nav.ts", "admin-layout.ts", "admin.ts", "attribution.ts", "users.ts", "config.ts", "server-api.ts",
    "worker/doc-host.ts", "src/room/doc.ts", "migrations/0170_attribution.sql",
  ],
  "e2e/suite/": [
    "room.ts", "src/room/", "host.ts", "agent.ts", "workspace.ts", "server-api.ts", "api.ts", "attribution.ts", "tokens.ts", "worker/doc-host.ts",
    "src/page/main.ts", "src/page/collab.ts", "src/page/bridge.ts", "src/page/frame.ts", "src/page/agent-chat.ts", "page.js", "frame.js", "e2e/suite/",
  ],
  "e2e/redeploy/": [
    "src/page/live.ts", "src/page/live-client.ts", "src/page/restore.ts", "worker/live.ts", "src/page/collab.ts", "src/page/attach-ui.ts", "src/page/main.ts",
    "factory/page.ts", "live.js", "page.js", "factory-agent.js",
  ],
  "e2e/reload/": ["dev/reload.ts", "front.ts"],
  "e2e/alone/": ["vite.config.ts", "worker/cookies.ts", "worker/auth.ts"],
  "e2e/versions/": ["versions.ts", "src/page/versions.ts", "src/page/settings.ts", "settings.js", "worker/home.ts", "e2e/suite/client.ts", "src/room/"],
  "e2e/pages/": ["tree.ts", "src/page/tree.ts", "pages-tree.js", "src/page/frame.ts", "frame.js"],
  "e2e/home/": ["home.ts", "worker/home.ts", "worker/published.ts", "landing/"],
  "e2e/config/": ["config.ts", "worker/d1.ts"],
  "e2e/deploy/": ["deploy/", "worker/deploy.ts", "worker/deployer.ts", "front.ts", "users.ts"],
  "e2e/staging/": [
    "deploy/", "worker/deploys.ts", "worker/pipeline.ts", "worker/deployer.ts", "worker/gate.ts", "worker/admins-only.ts", "worker/auth-settings.ts",
    "worker/source.ts", "worker/source-host.ts", "worker/artifacts.ts", "source/", "dev/git-server.ts", "dev/mirror.ts", "auth-apps.ts", "admin.ts",
    "admin-layout.ts", "server-tools.ts", "front.ts", "users.ts", "factory/agent.ts", "src/page/factory-agent.ts", "factory-agent.js",
  ],
  "e2e/admin/": [
    "factory/agent.ts", "factory/chat-store.ts", "worker/factory.ts", "worker/source-host.ts", "worker/artifacts.ts", "source/", "dev/git-server.ts",
    "agent-actions.ts", "server-tools.ts", "agent.ts", "admin.ts", "admin-layout.ts", "src/page/factory-agent.ts", "src/page/agent-chat.ts",
    "src/page/agent-log.ts", "src/page/attach-ui.ts", "src/page/layout.ts", "factory-agent.js",
  ],
  "e2e/front/": [
    "front.ts", "api.ts", "server-api.ts", "server-tools.ts", "directory.ts", "users.ts", "tokens.ts", "admin.ts", "account.ts", "templates.ts",
    "templates/", "worker/doc-host.ts", "worker/home.ts", "room.ts", "src/room/", "migrations/", "src/page/settings.ts", "e2e/suite/client.ts",
  ],
  "e2e/access/": [
    "account.ts", "admin-layout.ts", "admin.ts", "users.ts", "directory.ts", "tokens.ts", "front.ts", "home.ts", "worker/auth.ts", "worker/cookies.ts",
    "worker/doc-host.ts", "source/http.ts", "server-api.ts", "src/page/bridge.ts", "src/page/admin-share.ts", "src/page/share-agent.ts", "src/page/admin-nav.ts",
    "src/page/main.ts", "admin-share.js", "admin-nav.js",
  ],
  "e2e/templates/": ["templates.ts", "templates/", "front.ts", "DOCUMENT_PROMPT.md", "src/page/main.ts", "page.html", "e2e/fixtures/steps/", "e2e/fixtures/fade/"],
  "e2e/tree/": [
    "src/page/tree.ts", "pages-tree.js", "tree.ts", "front.ts", "src/page/main.ts", "src/page/remote.ts", "src/page/frame.ts", "page.html",
    "worker/doc-host.ts", "tokens.ts", "server-tools.ts", "e2e/fixtures/multi/",
  ],
  "e2e/viewer/": ["front.ts", "home.ts", "account.ts", "src/page/base.ts", "style.css", "src/page/main.ts", "src/page/layout.ts", "e2e/fixtures/"],
};

/** Changes that need every test: the tests' own machinery, the build, the server's core. */
export const ALL = [
  "e2e/", "e2e.config.ts", "e2e.bench.config.ts", "package.json", "bun.lock", "tsconfig.json", "site.sh", "build.sh", "dev.ts", "dev/plugin.ts",
  "vite.config.ts", "cloudflare.config.ts", "server.config.ts", "worker/index.ts", "worker/env.ts", "worker/auth.ts", "worker/platform.ts",
];

/** Text no test reads. */
const NONE = [/\.md$/, /^docs\//, /^tests\//, /^\.gitignore$/];

const under = (pattern: string, file: string) => (pattern.endsWith("/") ? file.startsWith(pattern) : file == pattern);

/** What to run for these changed files: "ALL", or test files and folders. */
export function affected(changed: string[]): string[] | "ALL" {
  const out = new Set<string>();
  for (const file of changed) {
    if (/^e2e\/.+\.e2e\.ts$/.test(file)) { if (!file.endsWith(".bench.e2e.ts")) out.add(file); continue; }
    const areas = Object.entries(AREAS).filter(([, files]) => files.some((p) => under(p, file))).map(([dir]) => dir);
    // The tests' data and helpers that areas name (e2e/fixtures/multi/, e2e/suite/client.ts) run those areas, not everything.
    if (file.startsWith("e2e/") && areas.length) { for (const a of areas) out.add(a); continue; }
    if (ALL.some((p) => under(p, file))) return "ALL";
    if (areas.length) { for (const a of areas) out.add(a); continue; }
    if (NONE.some((re) => re.test(file))) continue;
    return "ALL";
  }
  return [...out];
}

const git = (...args: string[]) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 30_000 });

/** The files changed since this branch left staging, committed or not, and new ones. */
export function changedFiles(): string[] {
  const base = [process.env.TEST_BASE, "origin/staging", "staging", "main"].find((b) => b && git("rev-parse", "--verify", "-q", b).status == 0);
  const since = base ? git("merge-base", base, "HEAD").stdout.trim() : "HEAD";
  const lines = [
    git("diff", "--name-only", since).stdout,
    git("ls-files", "--others", "--exclude-standard").stdout,
  ].join("\n");
  return [...new Set(lines.split("\n").map((l) => l.trim()).filter(Boolean))];
}

if (import.meta.main) {
  const picked = affected(process.argv.length > 2 ? process.argv.slice(2) : changedFiles());
  console.log(picked == "ALL" ? "ALL" : picked.join("\n"));
}
