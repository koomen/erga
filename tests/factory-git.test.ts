// The factory's local Git endpoint (dev/factory.ts, /__factory/git/erga.git, on
// git http-backend: dev/git-server.ts), with real git clients over HTTP:
//
//   - a fetch whose request git gzips (more than 1 KB of wants or haves: a
//     repository with many branches, as a busy factory's has) clones whole;
//   - when git http-backend fails, the client gets an error status with
//     git's own message, not a 200 with a broken pack ("expected 'packfile'");
//   - when git http-backend exits before it reads the body, the write to it
//     fails (EPIPE) without stopping the server.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ensureRepo, factoryDev, mintGitToken } from "../dev/factory.ts";
import { httpBackend } from "../dev/git-server.ts";

setDefaultTimeout(60_000);
const SECRET = "factory-git-test";
let dir = "", server: Server, base = "";
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: dir } });
const must = (cwd: string, ...args: string[]) => { const r = git(cwd, ...args); if (r.status) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
/** git as a client of the server in this process: async, so the server can answer. */
function client(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const p = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: dir, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (b) => { stdout += b; });
    p.stderr.on("data", (b) => { stderr += b; });
    p.on("close", (code) => done({ status: code ?? 1, stdout: stdout.trim(), stderr }));
  });
}
const ok = async (cwd: string, ...args: string[]) => { const r = await client(cwd, args); if (r.status) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); return r.stdout; };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "erga-factory-git-"));
  // A small repository (staging, main) with 60 task branches, each its own commit: a clone wants 60 commits (~3 KB), so git gzips it.
  const src = join(dir, "src");
  mkdirSync(src);
  must(src, "init", "-q", "-b", "staging");
  must(src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  for (let i = 1; i <= 60; i++) {
    writeFileSync(join(src, `f${i}.txt`), `task ${i}\n`);
    must(src, "add", ".");
    must(src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `task ${i}`);
    must(src, "branch", `task/${i}-x`);
  }
  const state = join(dir, "state");
  const bare = ensureRepo(state, src);
  must(src, "push", "-q", bare, "refs/heads/*:refs/heads/*");
  const factory = factoryDev({ stateDir: state, secret: SECRET, port: () => 0, log: () => {} });
  server = createServer((req, res) => { if (!factory.handle(req, res)) res.writeHead(404).end(); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const token = mintGitToken(SECRET, { scope: "task", branch: "task/1-x", exp: Math.floor(Date.now() / 1000) + 600 });
  base = `http://x:${token}@127.0.0.1:${(server.address() as { port: number }).port}/__factory/git/erga.git`;
});
afterAll(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

test("a clone whose fetch request git gzips gets every branch", async () => {
  const out = join(dir, "clone");
  // GIT_TRACE_CURL shows the request's headers: this fetch is the gzipped kind.
  const r = await client(dir, ["clone", "--mirror", base, out], { GIT_TRACE_CURL: "1", GIT_TRACE_CURL_NO_DATA: "1" });
  expect(r.stderr).toContain("Content-Encoding: gzip");
  expect(r.status, r.stderr.split("\n").filter((l) => !/^\d\d:\d\d/.test(l)).join("\n")).toBe(0);
  expect(must(out, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").length).toBe(62);
  // And a fetch into it with many haves (all 60 commits) after a new commit: gzipped too.
  const work = join(dir, "work");
  await ok(dir, "clone", "-q", "-b", "staging", base, work);
  must(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "on the task");
  await ok(work, "push", "-q", "origin", "HEAD:refs/heads/task/1-x");
  await ok(out, "fetch", "-q", "origin", "+refs/heads/*:refs/heads/*");
  expect(must(out, "rev-parse", "refs/heads/task/1-x")).toBe(must(work, "rev-parse", "HEAD"));
});

test("git http-backend's failure is an error status with git's message, not a 200 with half a pack", async () => {
  const root = join(dir, "state", "factory");
  // A want of a commit the repository doesn't have: upload-pack fails ("not our ref").
  const want = "0".repeat(39) + "1";
  const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
  const body = new TextEncoder().encode(pkt("command=fetch\n") + "0001" + pkt(`want ${want}\n`) + pkt("done\n") + "0000");
  const r = await httpBackend(root, { method: "POST", path: "/erga.git/git-upload-pack", query: "", headers: { "content-type": "application/x-git-upload-pack-request", "git-protocol": "version=2" }, body });
  expect(r.status).toBe(500);
  expect(r.headers["content-type"]).toBe("text/plain");
  expect(new TextDecoder().decode(r.body)).toContain("not our ref");
  // A gzipped request is read as gzip (HTTP_CONTENT_ENCODING): the same request, the same answer.
  const z = await httpBackend(root, { method: "POST", path: "/erga.git/git-upload-pack", query: "", headers: { "content-type": "application/x-git-upload-pack-request", "git-protocol": "version=2", "content-encoding": "gzip" }, body: gzipSync(body) });
  expect(new TextDecoder().decode(z.body)).toContain("not our ref");
});

test("git http-backend that exits before it reads the body answers, and doesn't stop the server (EPIPE)", async () => {
  // A push to a repository that isn't there: git answers 404 without reading the 8 MB body.
  const r = await httpBackend(join(dir, "state", "factory"), { method: "POST", path: "/missing.git/git-receive-pack", query: "", headers: { "content-type": "application/x-git-receive-pack-request" }, body: new Uint8Array(8 << 20) });
  expect(r.status).toBe(404);
});
