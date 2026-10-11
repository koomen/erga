// A small Git host for the source tests (tests/source.test.ts): Erga's Git
// endpoint (source/http.ts) and SourceRepo on bun:sqlite, in front of the
// pretend Artifacts and GitHub (dev/git-server.ts, real `git http-backend`),
// all on one Bun server. No Worker: the logic alone, quickly.

import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitServers, localToken, MOCK_GITHUB_TOKEN } from "../dev/git-server.ts";
import { gitHttp } from "../server/source/http.ts";
import { SourceRepo, type Move } from "../server/source/repo.ts";
import type { Remote } from "../server/source/remote.ts";

export interface Fixture {
  url: string;
  /** Erga's endpoint, with credentials, for the git CLI. */
  erga: string;
  /** The pretend GitHub's repository, with credentials. */
  github: string;
  /** The pretend Artifacts' repository, with a write token. */
  artifacts: string;
  repo: SourceRepo;
  moves: Move[];
  /** Background work (the mirror) settled. */
  settle(): Promise<void>;
  dir: string;
  stop(): void;
}

/**
 * git, run without blocking: the fixture's server answers in this same process. With node:child_process: Bun.spawn
 * with its output read as Responses now and then never finished (a git push, under 1 s, waited out the 30 s limit).
 */
export function git(cwd: string, ...args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } },
      (e, out, err) => resolve({ ok: !e, out: String(out ?? "").trim(), err: String(err ?? "").trim() }));
  });
}
export async function must(cwd: string, ...args: string[]) {
  const r = await git(cwd, ...args);
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out;
}

export function startFixture(opts: { mirror?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "erga-source-"));
  const secret = "test-secret";
  const background: Promise<unknown>[] = [];
  const moves: Move[] = [];
  let origin = "";
  const artifacts = (): Remote => ({ url: `${origin}/__artifacts/git/erga/erga.git`, headers: { Authorization: `Bearer ${localToken(secret, "erga/erga", "write")}` } });
  const repo = new SourceRepo({
    db: (() => { const db = new Database(":memory:"); return { exec: <T>(q: string, ...p: (string | number | null)[]) => db.query(q).all(...p) as T[] }; })(),
    artifacts: async () => artifacts(),
    github: () => (opts.mirror === false ? null : { url: `${origin}/__github/koomen/erga.git`, headers: { Authorization: `Basic ${btoa(`x-access-token:${MOCK_GITHUB_TOKEN}`)}` } }),
    moved: (m) => moves.push(m),
    changed: () => {},
    background: (p) => background.push(p),
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/git/erga.git")) {
        // As worker/source.ts, but anyone with credentials is Ada.
        const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
        if (!basic) return new Response("who?", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Erga"' } });
        return gitHttp(request, url.pathname.slice("/git/erga.git".length), {
          upstream: async () => artifacts(),
          advertise: () => repo.advertise(),
          receive: (body) => repo.receive(body, { login: "ada", name: "Ada" }),
        });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      const r = await gitServers(dir, secret, { method: request.method, path: url.pathname, query: url.search.slice(1), headers: Object.fromEntries(request.headers), body });
      if (!r) return new Response("Not found", { status: 404 });
      return new Response(r.body as BodyInit, { status: r.status, headers: r.headers });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  const withAuth = (path: string, user: string, pass: string) => `http://${user}:${encodeURIComponent(pass)}@127.0.0.1:${server.port}${path}`;
  return {
    url: origin,
    erga: withAuth("/git/erga.git", "x", "anything"),
    github: withAuth("/__github/koomen/erga.git", "x", MOCK_GITHUB_TOKEN),
    artifacts: withAuth("/__artifacts/git/erga/erga.git", "x", localToken(secret, "erga/erga", "write").split("?")[0]),
    repo, moves, dir,
    async settle() { while (background.length) await Promise.allSettled(background.splice(0)); },
    stop() { server.stop(true); rmSync(dir, { recursive: true, force: true }); },
  };
}
