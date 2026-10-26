// A small Git host for the source tests: Erga's Git
// endpoint and SourceRepo on bun:sqlite, in front of the
// pretend Artifacts and GitHub (dev/git-server.ts, real `git http-backend`),
// all on one Bun server. No Worker: the logic alone, quickly.

import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitServers, localToken } from "../dev/git-server.ts";
import { mockGithub, type MockGithub } from "../dev/github-mock.ts";
import { gitHttp } from "../control/source/http.ts";
import { installationToken, linkOf, uninstall, type GithubLink } from "../control/source/github.ts";
import { SourceRepo, type Move } from "../control/source/repo.ts";
import type { Remote } from "../control/source/remote.ts";

export interface Fixture {
  url: string;
  /** Erga's endpoint, with credentials, for the git CLI. */
  erga: string;
  /** The pretend GitHub (dev/github-mock.ts), with Erga's App; `githubRepo(owner/name)`: its repository, with credentials, for the git CLI. */
  mock: MockGithub;
  githubRepo(full: string): string;
  /** Connects the repository `owner/name` on the pretend GitHub (as Connect GitHub ends), and waits for the first sync. */
  connectGithub(full: string, by?: string): Promise<GithubLink>;
  /** The pretend Artifacts' repository, with a write token. */
  artifacts: string;
  /** With `upstream`: the pretend upstream's repository (erga/upstream on the pretend Artifacts), with a write token, for the git CLI; and the channel the downstream follows. */
  upstream: string;
  channel: "stable" | "edge";
  /** A second repository on the pretend Artifacts (erga/<name>), as a Remote with a write token (a fork to seed). */
  remoteOf(name: string): Remote & { cli: string };
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

/** The pretend GitHub App the fixture runs with: its key is made once for the test run (the mock checks the JWTs with it). */
export const TEST_APP = { slug: "erga-editor", clientId: "Iv1.testapp", clientSecret: "test-client-secret", webhookSecret: "test-webhook-secret" };
let testKey: Promise<string> | null = null;
export const testPrivateKey = () => (testKey ??= (async () => {
  const k = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", k.privateKey)).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
})());

export function startFixture(opts: { upstream?: boolean; /** The pretend GitHub's repositories from the start ("ada/erga"), and who uses the browser. */ repos?: string[]; user?: string; /** Where the pretend GitHub sends push events (none: nowhere). */ webhook?: (request: Request) => Promise<Response> } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "erga-source-"));
  const secret = "test-secret";
  const background: Promise<unknown>[] = [];
  const moves: Move[] = [];
  let origin = "";
  const artifacts = (): Remote => ({ url: `${origin}/__artifacts/git/erga/erga.git`, headers: { Authorization: `Bearer ${localToken(secret, "erga/erga", "write")}` } });
  const remoteOf = (name: string): Remote => ({ url: `${origin}/__artifacts/git/erga/${name}.git`, headers: { Authorization: `Bearer ${localToken(secret, `erga/${name}`, "write")}` } });
  const state = { channel: "stable" as "stable" | "edge" };
  let mock: MockGithub;
  const app = async () => ({ appId: "1", ...TEST_APP, privateKey: await testPrivateKey(), www: `${origin}/__github`, api: `${origin}/__github/api` });
  const repo = new SourceRepo({
    db: (() => { const db = new Database(":memory:"); return { exec: <T>(q: string, ...p: (string | number | null)[]) => db.query(q).all(...p) as T[] }; })(),
    artifacts: async () => artifacts(),
    // GitHub, as the App: installation tokens from the pretend GitHub (a JWT it checks), the uninstall.
    githubToken: async (id) => installationToken(await app(), id),
    githubUninstall: async (id) => uninstall(await app(), id),
    moved: (m) => moves.push(m),
    changed: () => {},
    background: (p) => background.push(p),
    // A downstream: upstream is a second repository on the pretend Artifacts (anyone may read erga.dev's; here a token does).
    ...(opts.upstream ? { upstream: () => ({ remote: remoteOf("upstream"), origin: "https://ops.erga.test", channel: state.channel }) } : {}),
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const gh = await mock.fetch(request);
      if (gh) return gh;
      if (url.pathname.startsWith("/git/erga.git")) {
        // As control/source/routes.ts, but anyone with credentials is Ada.
        const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
        if (!basic) return new Response("who?", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Erga"' } });
        return gitHttp(request, url.pathname.slice("/git/erga.git".length), {
          upstream: async () => artifacts(),
          advertise: () => repo.advertise(),
          receive: (body) => repo.receive(body, { login: "ada", name: "Ada" }),
        });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      const r = await gitServers(dir, secret, { method: request.method, path: url.pathname, query: url.search.slice(1), headers: Object.fromEntries(request.headers), body }, { githubToken: mock.gitTokenOk });
      if (!r) return new Response("Not found", { status: 404 });
      // A push to the pretend GitHub: its webhook, after the answer.
      const pushed = /^\/__github\/([^/]+)\/([^/]+)\.git\/git-receive-pack$/.exec(url.pathname);
      if (pushed && r.status == 200) background.push(mock.pushed(pushed[1], pushed[2], body));
      return new Response(r.body as BodyInit, { status: r.status, headers: r.headers });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  // The pretend GitHub, on this same server: its clone URLs point at the pretend Git host above; its webhook, where the test says.
  mock = mockGithub({ app: { ...TEST_APP, administration: true }, origin, callback: `${origin}/auth/github/callback`, user: opts.user ?? "ada", repos: opts.repos ?? [], ...(opts.webhook ? { webhook: `${origin}/github/webhook`, net: (async (input: RequestInfo | URL, init?: RequestInit) => opts.webhook!(new Request(input, init))) as typeof fetch } : {}) });
  // The App's key reaches the mock once it's made: from then on it checks the Worker's JWTs with it.
  testPrivateKey().then((k) => { mock.app.privateKey = k; }).catch(() => {});
  const withAuth = (path: string, user: string, pass: string) => `http://${user}:${encodeURIComponent(pass)}@127.0.0.1:${server.port}${path}`;
  return {
    url: origin,
    erga: withAuth("/git/erga.git", "x", "anything"),
    get mock() { return mock; },
    githubRepo: (full) => withAuth(`/__github/${full}.git`, "x-access-token", "erga-dev-github-token"),
    async connectGithub(full, by = "ada") {
      const [owner, name] = full.split("/");
      const r = mock.state.repos.find((x) => x.owner == owner && x.name == name) ?? (() => { const made = { id: 9000 + mock.state.repos.length, owner, name, private: false }; mock.state.repos.push(made); return made; })();
      const installation = mock.state.installations.find((i) => i.account.login == owner) ?? (() => { const made = { id: 5000 + mock.state.installations.length, account: { login: owner, type: "User" }, selection: "selected" as const, repoIds: [] as number[] }; mock.state.installations.push(made); return made; })();
      if (!installation.repoIds.includes(r.id)) installation.repoIds.push(r.id);
      const link = linkOf(installation.id, installation.account, { id: r.id, full_name: full, clone_url: `${origin}/__github/${full}.git`, html_url: `${origin}/__github/${full}`, private: false, default_branch: "main" }, by);
      await repo.connectGithub(link, by);
      return link;
    },
    artifacts: withAuth("/__artifacts/git/erga/erga.git", "x", localToken(secret, "erga/erga", "write").split("?")[0]),
    upstream: withAuth("/__artifacts/git/erga/upstream.git", "x", localToken(secret, "erga/upstream", "write").split("?")[0]),
    get channel() { return state.channel; },
    set channel(c) { state.channel = c; },
    remoteOf: (name) => ({ ...remoteOf(name), cli: withAuth(`/__artifacts/git/erga/${name}.git`, "x", localToken(secret, `erga/${name}`, "write").split("?")[0]) }),
    repo, moves, dir,
    async settle() { while (background.length) await Promise.allSettled(background.splice(0)); },
    stop() { server.stop(true); rmSync(dir, { recursive: true, force: true }); },
  };
}
