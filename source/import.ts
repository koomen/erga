#!/usr/bin/env bun
// Seeds Erga's repository (once): every commit of a branch of an existing
// repository (GitHub's, by default), pushed through Erga's Git endpoint to
// both main and staging. Through Erga, not straight into Artifacts, so Erga
// indexes the whole history as it lands.
//
//   ERGA_TOKEN=erga_... bun source/import.ts <server> [--from <repo or path>] [--branch main]
//
//   <server>        the Erga server, e.g. https://erga.dev (or http://127.0.0.1:4400 locally)
//   --from          where the history comes from: https://github.com/koomen/erga.git by default,
//                   or a local checkout (".")
//   --branch        which of its branches (main)
//
// ERGA_TOKEN is a token with the admin scope (made at <server>/tokens: README, Tokens). It stops if the server's
// main already has commits: seeding is once. Erga's GitHub mirror then
// adds staging on GitHub (main is already there, the same commit).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1).filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(args.length ? 0 : 2);
}
const flag = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const from = flag("--from", "https://github.com/koomen/erga.git");
const branch = flag("--branch", "main");
const server = args.find((a) => !a.startsWith("--"))?.replace(/\/+$/, "");
const token = process.env.ERGA_TOKEN;
if (!server || !token) { console.error("usage: ERGA_TOKEN=erga_... bun source/import.ts <server> [--from <repo>] [--branch main]"); process.exit(2); }

const remote = `${server}/git/erga.git`;
// The token as HTTP Basic's password, in a header, so it's never in a URL or the repository's config.
const auth = ["-c", `http.extraHeader=Authorization: Basic ${btoa(`erga:${token}`)}`];
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status != 0) { console.error(`git ${a.filter((x) => !x.startsWith("http.extraHeader")).join(" ")}:\n${r.stderr}`); process.exit(1); }
  return { out: r.stdout.trim(), err: r.stderr.trim() };
};

const there = git(process.cwd(), ...auth, "ls-remote", remote).out;
if (/\trefs\/heads\/main$/m.test(there)) { console.error(`${remote} already has a main branch: it's seeded. Push to it as usual.`); process.exit(1); }

const work = mkdtempSync(join(tmpdir(), "erga-import-"));
try {
  console.log(`Reading ${branch} from ${from}…`);
  git(work, "clone", "--bare", "--quiet", "--single-branch", "--branch", branch, from, "repo.git");
  const repo = join(work, "repo.git");
  const count = git(repo, "rev-list", "--count", branch).out;
  console.log(`Pushing ${count} commits to ${remote} (main and staging)…`);
  const pushed = git(repo, ...auth, "push", remote, `${branch}:refs/heads/main`, `${branch}:refs/heads/staging`);
  for (const line of pushed.err.split("\n")) if (line.startsWith("remote: Erga")) console.log(`  ${line.slice(8)}`);
  const head = git(repo, "rev-parse", branch).out;
  const now = git(process.cwd(), ...auth, "ls-remote", remote).out;
  if (!now.includes(`${head}\trefs/heads/main`) || !now.includes(`${head}\trefs/heads/staging`)) { console.error(`The push didn't land as expected:\n${now}`); process.exit(1); }
  console.log(`Done: main and staging are at ${head.slice(0, 7)}. See ${server}/source`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
