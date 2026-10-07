// Which end-to-end tests a change needs, for `bun run test` (e2e/run.ts). One
// rule, kept simple so it is never wrong by leaving a test out:
//
//   1. A changed test file (e2e/**/*.e2e.ts) runs.
//   2. A changed file under an area below runs that area's folder of tests.
//   3. Text that no test reads (Markdown, docs/, the old harness under tests/,
//      which test.sh runs) needs none.
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
    "dev/agent-key.ts", "tests/fixtures/",
  ],
  "e2e/factory/": [
    "factory/", "worker/factory.ts", "dev/factory.ts", "dev/git-server.ts", "worker/source.ts", "source/", "tokens.ts",
    "src/page/factory-agent.ts", "src/page/agent-chat.ts", "src/page/share-agent.ts", "src/page/admin-share.ts", "factory-agent.js", "admin-share.js",
  ],
  "e2e/access/": [
    "account.ts", "admin-layout.ts", "admin.ts", "users.ts", "directory.ts", "tokens.ts", "front.ts", "home.ts", "worker/auth.ts", "worker/cookies.ts",
    "worker/doc-host.ts", "source/http.ts", "server-api.ts", "src/page/bridge.ts", "src/page/admin-share.ts", "src/page/share-agent.ts", "src/page/admin-nav.ts",
    "src/page/main.ts", "admin-share.js", "admin-nav.js",
  ],
  "e2e/viewer/": ["front.ts", "home.ts", "account.ts", "src/page/base.ts", "style.css", "src/page/main.ts", "src/page/layout.ts", "tests/fixtures/"],
};

/** Changes that need every test: the tests' own machinery, the build, the server's core. */
export const ALL = [
  "e2e/", "e2e.config.ts", "e2e.bench.config.ts", "package.json", "bun.lock", "tsconfig.json", "site.sh", "build.sh", "dev.ts", "dev/plugin.ts",
  "vite.config.ts", "cloudflare.config.ts", "server.config.ts", "worker/index.ts", "worker/env.ts", "worker/auth.ts", "worker/platform.ts", "tests/cores.ts",
];

/** Text no test reads. */
const NONE = [/\.md$/, /^docs\//, /^tests\/(?!fixtures\/|cores\.ts$)/, /^test\.sh$/, /^\.gitignore$/];

const under = (pattern: string, file: string) => (pattern.endsWith("/") ? file.startsWith(pattern) : file == pattern);

/** What to run for these changed files: "ALL", or test files and folders. */
export function affected(changed: string[]): string[] | "ALL" {
  const out = new Set<string>();
  for (const file of changed) {
    if (/^e2e\/.+\.e2e\.ts$/.test(file)) { if (!file.endsWith(".bench.e2e.ts")) out.add(file); continue; }
    if (ALL.some((p) => under(p, file))) return "ALL";
    const areas = Object.entries(AREAS).filter(([, files]) => files.some((p) => under(p, file))).map(([dir]) => dir);
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
