// Real Git, over smart HTTP, for local development and tests: `git
// http-backend` (Git's own CGI server) on bare repositories in a folder.
// It stands in for the two Git servers Erga talks to and can't reach locally
// (dev/vite-plugin.ts serves them from the dev server):
//
//   /__artifacts/git/<namespace>/<repo>.git/...   Cloudflare Artifacts (which has no local mode:
//                                                 miniflare's binding only proxies to the real service),
//                                                 with repo tokens as Artifacts checks them (read, write)
//   /__github/<owner>/<repo>.git/...              GitHub, for the mirror, with one made-up token
//
// Both make the bare repository the first time it's asked for.

import { spawn, spawnSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GitRequest { method: string; path: string; query: string; headers: Record<string, string | undefined>; body: Uint8Array }
export interface GitResponse { status: number; headers: Record<string, string>; body: Uint8Array }

/** The token the pretend GitHub takes (as the password, any username). */
export const MOCK_GITHUB_TOKEN = "erga-dev-github-token";

/** A bare repository at `dir` (made, with main as HEAD, if it isn't there). */
export function ensureBare(dir: string) {
  if (existsSync(join(dir, "HEAD"))) return;
  mkdirSync(dirname(dir), { recursive: true });
  const r = spawnSync("git", ["init", "--bare", "--quiet", "--initial-branch=main", dir]);
  if (r.status != 0) throw new Error(`git init: ${r.stderr}`);
  spawnSync("git", ["-C", dir, "config", "http.receivepack", "true"]);
  // Pushes that skip a fast-forward are allowed, as Artifacts and GitHub allow them (Erga holds main's line itself).
  spawnSync("git", ["-C", dir, "config", "receive.denyNonFastForwards", "false"]);
}

/** Runs `git http-backend` for one request against the repositories under `root` (`path` is "/<repo>.git/..."). */
export function httpBackend(root: string, req: GitRequest): Promise<GitResponse> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: req.path,
      REQUEST_METHOD: req.method,
      QUERY_STRING: req.query,
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(req.body.length),
      REMOTE_USER: "erga",
      REMOTE_ADDR: "127.0.0.1",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    if (req.headers["git-protocol"]) env.GIT_PROTOCOL = req.headers["git-protocol"]!;
    if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = req.headers["content-encoding"]!;
    const p = spawn("git", ["http-backend"], { env });
    const out: Buffer[] = [], err: Buffer[] = [];
    p.stdout.on("data", (b: Buffer) => out.push(b));
    p.stderr.on("data", (b: Buffer) => err.push(b));
    p.on("error", reject);
    p.on("close", (code, signal) => {
      const all = Buffer.concat(out);
      let split = all.indexOf("\r\n\r\n"), skip = 4;
      if (split < 0) { split = all.indexOf("\n\n"); skip = 2; }
      // It failed (upload-pack or receive-pack died part-way): its headers said 200 before it did, and what follows is
      // half a pack, which a client reads as "expected 'packfile'". The client gets an error and git's own message
      // instead (git shows a text/plain body as "remote: ..."). A status of its own (404, 403) is an answer: kept.
      const said = split < 0 ? "" : all.subarray(0, split).toString();
      if (split < 0 || ((code != 0 || signal) && !/^status:/im.test(said))) {
        const why = Buffer.concat(err).toString().trim() || `git http-backend ${signal ? `was stopped (${signal})` : `exited with ${code}`}`;
        return resolve({ status: 500, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode(`${why}\n`) });
      }
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of all.subarray(0, split).toString().split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const key = line.slice(0, i).trim().toLowerCase(), value = line.slice(i + 1).trim();
        if (key == "status") status = parseInt(value, 10);
        else headers[key] = value;
      }
      resolve({ status, headers, body: new Uint8Array(all.subarray(split + skip)) });
    });
    // git can exit before it reads the whole body (it refused, or had all it needed): the write then fails with EPIPE,
    // which unhandled stops the dev server, Vite and all. "close" above answers either way.
    p.stdin.on("error", () => {});
    p.stdin.end(Buffer.from(req.body));
  });
}

// ---- Artifacts' repo tokens, locally ------------------------------------------------

const mac = (secret: string, scope: string, exp: number, repo: string) => createHmac("sha256", secret).update(`${scope}:${exp}:${repo}`).digest("hex").slice(0, 40);

/** A local repo token (the Worker's stand-in binding makes them the same way, cloudflare/artifacts.ts). */
export function localToken(secret: string, repo: string, scope: "read" | "write", ttl = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return `art_local_${scope}_${exp}_${mac(secret, scope, exp, repo)}?expires=${exp}`;
}

/** The scope a local repo token gives on `repo`, or null if it's no good (wrong, expired, another repo's). */
export function checkToken(secret: string, repo: string, token: string): "read" | "write" | null {
  const m = /^art_local_(read|write)_(\d+)_([0-9a-f]{40})/.exec(token);
  if (!m) return null;
  const [, scope, exp, given] = m;
  if (Number(exp) < Date.now() / 1000) return null;
  const want = Buffer.from(mac(secret, scope, Number(exp), repo)), got = Buffer.from(given);
  return want.length == got.length && timingSafeEqual(want, got) ? (scope as "read" | "write") : null;
}

/** The token in a request: "Bearer <token>", or Basic with the token as the password (any username). */
export function tokenOf(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (bearer) return bearer[1];
  const basic = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!basic) return null;
  const decoded = Buffer.from(basic[1], "base64").toString();
  return decoded.slice(decoded.indexOf(":") + 1) || null;
}

/**
 * The two pretend servers' routes (above), for a request to `path`, or null
 * if it isn't theirs. Repositories live under `stateDir`.
 */
export async function gitServers(stateDir: string, secret: string, req: GitRequest): Promise<GitResponse | null> {
  const deny = (status: number, why: string): GitResponse => ({ status, headers: { "content-type": "text/plain", ...(status == 401 ? { "www-authenticate": 'Basic realm="git"' } : {}) }, body: new TextEncoder().encode(`${why}\n`) });
  const pushing = req.query.includes("service=git-receive-pack") || req.path.endsWith("/git-receive-pack");
  const artifacts = /^\/__artifacts\/git\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)\.git(\/.*)$/.exec(req.path);
  if (artifacts) {
    const [, ns, repo, rest] = artifacts;
    const token = tokenOf(req.headers.authorization);
    const scope = token ? checkToken(secret, `${ns}/${repo}`, token) : null;
    if (!scope) return deny(401, "Artifacts: a repo token is needed");
    if (pushing && scope != "write") return deny(403, "Artifacts: this token can only read");
    const root = join(stateDir, "artifacts", ns);
    ensureBare(join(root, `${repo}.git`));
    return httpBackend(root, { ...req, path: `/${repo}.git${rest}` });
  }
  const github = /^\/__github\/([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?(\/.*)$/.exec(req.path);
  if (github) {
    const [, owner, repo, rest] = github;
    if (tokenOf(req.headers.authorization) != MOCK_GITHUB_TOKEN) return deny(401, "GitHub (pretend): bad credentials");
    const root = join(stateDir, "github", owner);
    ensureBare(join(root, `${repo}.git`));
    return httpBackend(root, { ...req, path: `/${repo}.git${rest}` });
  }
  return null;
}
