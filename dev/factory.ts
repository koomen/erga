// The factory's local stand-ins (experimental; README, The factory), served
// by the dev server (dev/plugin.ts) because they need this machine: what the
// Worker reaches on Cloudflare as Erga's repository (Artifacts) and as
// Containers.
//
//   /__factory/git/erga.git/...   Erga's repository, locally: a bare repository in the state directory
//                                 (factory/erga.git), served by real `git http-backend`. Made the first time
//                                 from this checkout's HEAD, as staging and main. A factory token
//                                 (worker/factory.ts, gitToken) is the password: a task's token pushes its
//                                 own branch only; a merge token also moves staging. Nothing else is pushed.
//   POST /__factory/vm?link=      the VMs: { op: "start" | "job" | "stop" | "alive" | "info", ... }, from the
//                                 Worker only (the dev server's secret)
//
// VMs are Docker containers of the factory's image (factory/vm/Dockerfile,
// built on first use) when Docker runs here, else a simulation: a folder per
// VM, with the same scripts run straight from the repo, and a light preview.
// ERGA_FACTORY_RUNNER=docker|sim picks one.
//
// No real repository, Cloudflare account or credential of this machine is
// used: the simulation gives its jobs a HOME of their own, and a job gets
// only the environment the factory hands it.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { dockerUp, ensureImage } from "../factory/vm/build.ts";
import { isTaskBranch, refsAllowed, type GitGrant } from "../factory/git-grant.ts";

export { refsAllowed, type GitGrant };

const EDITOR = resolve(import.meta.dirname, "..");
const VM_SCRIPTS = join(EDITOR, "factory/vm");
/** The preview's port inside a VM, and the relay that shows it outside (factory/vm/common.ts). */
const PREVIEW_PORT = 4400, PUBLIC_PORT = 4401;

export interface FactoryDev {
  /** Handles a request if it's the factory's; false if it isn't. */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  /** Stops every VM's simulated processes (the dev server stopping); Docker containers stay, as Cloudflare's would. */
  close(): void;
}

// ---- tokens --------------------------------------------------------------------------

const b64url = (s: string) => Buffer.from(s).toString("base64url");
/** The key factory tokens are signed with, from the dev server's secret (worker/factory.ts derives the same). */
export const gitKey = (secret: string) => createHmac("sha256", secret).update("erga-factory-git").digest();

export function checkGitToken(secret: string, token: string): GitGrant | null {
  const m = /^fgt\.([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const want = createHmac("sha256", gitKey(secret)).update(m[1]).digest("hex");
  if (!timingSafeEqual(Buffer.from(want), Buffer.from(m[2]))) return null;
  try {
    const g = JSON.parse(Buffer.from(m[1], "base64url").toString()) as GitGrant;
    if (!isTaskBranch(g.branch) || g.exp * 1000 < Date.now()) return null;
    return g;
  } catch { return null; }
}

/** Mints a token as the Worker does (for tests). */
export function mintGitToken(secret: string, grant: GitGrant): string {
  const body = b64url(JSON.stringify(grant));
  return `fgt.${body}.${createHmac("sha256", gitKey(secret)).update(body).digest("hex")}`;
}

/** The token in a request: Bearer, or Basic with it as the password. */
function tokenOf(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (bearer) return bearer[1];
  const basic = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!basic) return null;
  const d = Buffer.from(basic[1], "base64").toString();
  return d.slice(d.indexOf(":") + 1) || null;
}

/** The refs a receive-pack request updates: [old, new, ref] each (pkt-lines up to the first flush). */
export function pushedRefs(body: Uint8Array): { old: string; next: string; ref: string }[] {
  const out: { old: string; next: string; ref: string }[] = [];
  const buf = Buffer.from(body);
  let at = 0;
  while (at + 4 <= buf.length) {
    const len = parseInt(buf.subarray(at, at + 4).toString(), 16);
    if (!len) break;
    const line = buf.subarray(at + 4, at + len).toString().split("\0")[0].trim();
    at += len;
    const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (\S+)$/.exec(line);
    if (m) out.push({ old: m[1], next: m[2], ref: m[3] });
  }
  return out;
}

// ---- the repository ------------------------------------------------------------------

/** The local repository: made the first time from this checkout's HEAD, as staging and main. */
export function ensureRepo(stateDir: string, from = EDITOR): string {
  const dir = join(stateDir, "factory", "erga.git");
  if (existsSync(join(dir, "HEAD")) && spawnSync("git", ["-C", dir, "rev-parse", "--verify", "-q", "refs/heads/staging"]).status == 0) return dir;
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { encoding: "utf8" });
    if (r.status != 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "--bare", "--quiet", "--initial-branch=main", dir);
  git("-C", dir, "config", "http.receivepack", "true");
  git("-C", dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  // Reads this checkout; writes only the new repository.
  git("-C", from, "push", "--quiet", dir, "HEAD:refs/heads/staging", "HEAD:refs/heads/main");
  git("-C", dir, "symbolic-ref", "HEAD", "refs/heads/staging");
  return dir;
}

/** The repository's branches and their heads (for tests and the Worker's view). */
export function branches(stateDir: string): Record<string, string> {
  const dir = join(stateDir, "factory", "erga.git");
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const line of spawnSync("git", ["-C", dir, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], { encoding: "utf8" }).stdout.split("\n")) {
    const [name, sha] = line.split(" ");
    if (name) out[name] = sha;
  }
  return out;
}

function httpBackend(root: string, path: string, req: IncomingMessage, body: Uint8Array, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", GIT_CONFIG_NOSYSTEM: "1",
    GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: path, REQUEST_METHOD: req.method ?? "GET",
    QUERY_STRING: url.search.slice(1), CONTENT_LENGTH: String(body.length), CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: "factory", REMOTE_ADDR: "127.0.0.1",
  };
  if (req.headers["git-protocol"]) env.GIT_PROTOCOL = String(req.headers["git-protocol"]);
  const p = spawn("git", ["http-backend"], { env });
  const out: Buffer[] = [];
  p.stdout.on("data", (b: Buffer) => out.push(b));
  p.on("close", () => {
    const all = Buffer.concat(out);
    let split = all.indexOf("\r\n\r\n"), skip = 4;
    if (split < 0) { split = all.indexOf("\n\n"); skip = 2; }
    if (split < 0) { res.writeHead(500).end("git http-backend failed"); return; }
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of all.subarray(0, split).toString().split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
      if (k == "status") status = parseInt(v, 10); else headers[k] = v;
    }
    res.writeHead(status, headers).end(all.subarray(split + skip));
  });
  p.stdin.end(Buffer.from(body));
}

// ---- the VMs -------------------------------------------------------------------------

interface StartReq { op: "start"; task: number }
interface JobReq { op: "job"; vm: string; script: "run.ts" | "merge.ts"; args: string[]; env: Record<string, string>; wait?: boolean }
interface VmReq { op: "stop" | "alive"; vm: string }
type Req = StartReq | JobReq | VmReq | { op: "info" };

/** What runs the VMs: Docker or the simulation. */
interface Runner {
  kind: "docker" | "sim";
  start(task: number): Promise<{ vm: string; preview: string }>;
  job(r: JobReq): Promise<{ code: number; output: string } | null>;
  stop(vm: string): Promise<void>;
  alive(vm: string): Promise<boolean>;
  close(): void;
}

/** A port nothing listens on now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const port = (srv.address() as AddressInfo).port; srv.close(() => resolve(port)); });
  });
}

/** Runs a job's process, its output to the VM's log; resolves when it ends (with the output's tail). */
function watch(p: ChildProcess, logFile: string): Promise<{ code: number; output: string }> {
  const file = createWriteStream(logFile, { flags: "a" });
  let tail = "";
  const take = (c: Buffer) => { file.write(c); tail = (tail + c.toString()).slice(-20000); };
  p.stdout?.on("data", take);
  p.stderr?.on("data", take);
  return new Promise((resolve) => {
    p.on("error", (e) => { take(Buffer.from(String(e))); });
    p.on("close", (code) => { file.end(); resolve({ code: code ?? 1, output: tail }); });
  });
}

/** The VM's job scripts, by name (factory/vm/*.ts but the agent, the build and the Worker's bundle of them). */
export function jobScripts(): Record<string, string> {
  return Object.fromEntries(readdirSync(VM_SCRIPTS).filter((n) => n.endsWith(".ts") && !["agent.ts", "build.ts", "push.ts", "scripts.ts"].includes(n)).sort().map((n) => [n, readFileSync(join(VM_SCRIPTS, n), "utf8")]));
}

/** The label on a dev server's Docker VMs: from its state folder, so test servers never touch each other's. */
export const dockerLabel = (stateDir: string) => createHmac("sha1", "erga-factory").update(resolve(stateDir)).digest("hex").slice(0, 12);

function dockerRunner(stateDir: string, log: (line: string) => void): Runner {
  /** This dev server's containers, so tests' servers don't touch each other's. */
  const label = `erga.factory=${dockerLabel(stateDir)}`;
  const logs = join(stateDir, "factory", "vms");
  mkdirSync(logs, { recursive: true });
  /** A VM's agent (factory/vm/agent.ts): where Docker publishes it, and its secret (kept on the container, so a restarted dev server finds it). */
  const agentOf = (vm: string): { url: string; secret: string } => {
    const r = spawnSync("docker", ["inspect", "-f", '{{index .Config.Labels "erga.agent"}} {{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}', vm], { encoding: "utf8" });
    const [secret, port] = r.stdout.trim().split(" ");
    if (r.status != 0 || !secret || !port) throw new Error(`no VM ${vm}`);
    return { url: `http://127.0.0.1:${port}`, secret };
  };
  const agent = async (vm: string, path: string, body?: unknown) => {
    const a = agentOf(vm);
    const r = await fetch(a.url + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${a.secret}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`the VM's agent answered ${r.status}: ${await r.text()}`);
    return r;
  };
  return {
    kind: "docker",
    async start(task) {
      const image = await ensureImage((l) => { if (/^#\d+ (DONE|\[)/.test(l) || /building/.test(l)) log(`factory image: ${l}`); });
      const name = `erga-factory-${task}-${randomBytes(3).toString("hex")}`;
      const secret = randomBytes(18).toString("hex");
      const [agentPort, previewPort] = [await freePort(), await freePort()];
      // As on Cloudflare, the VM shows two ports: its agent's and the preview's relay (on this machine's loopback only).
      const r = spawnSync("docker", ["run", "-d", "--init", "--name", name, "--label", label, "--label", `erga.agent=${secret}`, "--memory", "6g",
        "-e", `FACTORY_AGENT_SECRET=${secret}`, "-p", `127.0.0.1:${agentPort}:8080`, "-p", `127.0.0.1:${previewPort}:${PUBLIC_PORT}`,
        "--add-host", "host.docker.internal:host-gateway", image], { encoding: "utf8" });
      if (r.status != 0) throw new Error(`docker run: ${r.stderr}`);
      for (let i = 0; ; i++) {
        try { await agent(name, "/health"); break; } catch (e) { if (i > 100) throw e; await new Promise((ok) => setTimeout(ok, 100)); }
      }
      return { vm: name, preview: `http://localhost:${previewPort}` };
    },
    async job(j) {
      const env: Record<string, string> = { ...j.env, FACTORY_WORK: "/work", FACTORY_PREVIEW_PORT: String(PREVIEW_PORT), FACTORY_PUBLIC_PORT: String(PUBLIC_PORT) };
      // The VM reaches this machine as host.docker.internal.
      for (const k of ["FACTORY_API", "REPO_URL"]) if (env[k]) env[k] = env[k].replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/])/, "//host.docker.internal");
      // The job's scripts from this checkout, as the Worker sends its own on Cloudflare (factory/vm/scripts.ts).
      const r = await agent(j.vm, "/job", { script: j.script, args: j.args, env, wait: !!j.wait, scripts: jobScripts() });
      return j.wait ? r.json() as Promise<{ code: number; output: string }> : null;
    },
    async stop(vm) {
      // Its log first, for looking into a task afterwards.
      const out = spawnSync("docker", ["exec", vm, "cat", "/work/vm.log"], { encoding: "utf8" });
      if (out.stdout) createWriteStream(join(logs, `${vm}.log`)).end(out.stdout);
      spawnSync("docker", ["rm", "-f", vm], { stdio: "ignore" });
    },
    // Running, and with an agent to talk to (a VM of an older image has none: it's replaced).
    async alive(vm) { return spawnSync("docker", ["inspect", "-f", '{{.State.Running}} {{index .Config.Labels "erga.agent"}}', vm], { encoding: "utf8" }).stdout.trim().split(" ").filter(Boolean).length == 2 && spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", vm], { encoding: "utf8" }).stdout.trim() == "true"; },
    close() {},
  };
}

function simRunner(stateDir: string, log: (line: string) => void): Runner {
  const root = join(stateDir, "factory", "vms");
  const procs = new Map<string, Set<ChildProcess>>();
  const ports = new Map<string, number>();
  const dirOf = (vm: string) => join(root, vm.replace(/^sim:/, ""));
  const kill = (vm: string) => {
    for (const p of procs.get(vm) ?? []) { try { process.kill(-p.pid!, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch { /* gone */ } } }
    procs.delete(vm);
    // The preview runs detached (it outlives its job, as in a VM): found by its folder.
    spawnSync("pkill", ["-f", dirOf(vm)], { stdio: "ignore" });
  };
  return {
    kind: "sim",
    async start(task) {
      const name = `task-${task}-${randomBytes(3).toString("hex")}`;
      mkdirSync(join(root, name, "home"), { recursive: true });
      mkdirSync(join(root, name, "work"), { recursive: true });
      // Tests (tests/factory.ts, ERGA_FACTORY_SIM_NO_SCRIPTS) skip packages' install scripts, by the VM's own Bun settings
      // (its HOME's .bunfig.toml): they cost seconds a VM (a Mac checks each fresh copy of workerd's and esbuild's
      // binaries on its first run), and a simulated VM's preview, a static one, runs neither.
      if (process.env.ERGA_FACTORY_SIM_NO_SCRIPTS) writeFileSync(join(root, name, "home", ".bunfig.toml"), "[install]\nignoreScripts = true\n");
      const port = await freePort();
      ports.set(`sim:${name}`, port);
      log(`factory: simulated VM ${name} (no Docker), preview port ${port}`);
      return { vm: `sim:${name}`, preview: `http://localhost:${port}` };
    },
    async job(j) {
      const dir = dirOf(j.vm);
      if (!existsSync(dir)) throw new Error(`no VM ${j.vm}`);
      const port = ports.get(j.vm) ?? await freePort();
      ports.set(j.vm, port);
      const env: Record<string, string> = {
        // Nothing of this machine's own environment but what runs things: no tokens, no HOME with credentials in it.
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(dir, "home"), TMPDIR: join(dir, "home"),
        GIT_CONFIG_GLOBAL: join(dir, "home", ".gitconfig"), GIT_AUTHOR_NAME: "Erga factory", GIT_AUTHOR_EMAIL: "factory@erga.dev",
        GIT_COMMITTER_NAME: "Erga factory", GIT_COMMITTER_EMAIL: "factory@erga.dev",
        // What this machine has that a VM's image would: Bun's package cache (packages only), and for Chrome its HOME (task.ts, CHROME_HOME).
        BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR || join(homedir(), ".bun", "install", "cache"), CHROME_HOME: homedir(),
        FACTORY_WORK: join(dir, "work"), FACTORY_PREVIEW_PORT: String(port), FACTORY_PUBLIC_PORT: String(port), FACTORY_PREVIEW: "static",
        ...j.env,
      };
      const p = spawn("bun", [join(VM_SCRIPTS, j.script), ...j.args], { env, detached: true, cwd: join(dir, "work") });
      const set = procs.get(j.vm) ?? new Set();
      procs.set(j.vm, set.add(p));
      const done = watch(p, join(dir, "vm.log")).finally(() => set.delete(p));
      return j.wait ? done : null;
    },
    async stop(vm) { kill(vm); rmSync(dirOf(vm), { recursive: true, force: true }); ports.delete(vm); },
    async alive(vm) { return existsSync(dirOf(vm)); },
    close() { for (const vm of procs.keys()) kill(vm); },
  };
}

// ---- the routes ----------------------------------------------------------------------

export function factoryDev(opts: { stateDir: string; secret: string; port: () => number; log: (line: string) => void }): FactoryDev {
  let runner: Runner | null = null;
  const pick = (): Runner => {
    if (runner) return runner;
    const want = process.env.ERGA_FACTORY_RUNNER;
    const docker = want == "docker" || (want != "sim" && dockerUp());
    runner = docker ? dockerRunner(opts.stateDir, opts.log) : simRunner(opts.stateDir, opts.log);
    opts.log(`factory: VMs are ${docker ? "Docker containers" : "simulated (no Docker)"}`);
    return runner;
  };

  const read = (req: IncomingMessage) => new Promise<Uint8Array>((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => ok(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", fail);
  });
  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

  async function git(req: IncomingMessage, res: ServerResponse, rest: string) {
    const grant = (() => { const t = tokenOf(req.headers.authorization); return t ? checkGitToken(opts.secret, t) : null; })();
    if (!grant) return void res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Erga factory"', "Content-Type": "text/plain" }).end("a factory token is needed\n");
    let body = await read(req);
    if (rest.endsWith("/git-receive-pack")) {
      if (req.headers["content-encoding"] == "gzip") body = new Uint8Array(gunzipSync(body));
      const why = refsAllowed(grant, pushedRefs(body));
      if (why) return void res.writeHead(403, { "Content-Type": "text/plain" }).end(`${why}\n`);
    }
    const dir = ensureRepo(opts.stateDir);
    httpBackend(join(dir, ".."), `/erga.git${rest}`, { ...req, headers: { ...req.headers, "content-encoding": undefined } } as IncomingMessage, body, res);
  }

  async function vm(req: IncomingMessage, res: ServerResponse) {
    const r = JSON.parse(Buffer.from(await read(req)).toString()) as Req;
    const run = pick();
    try {
      switch (r.op) {
        case "info": ensureRepo(opts.stateDir); return json(res, 200, { runner: run.kind, branches: branches(opts.stateDir) });
        case "start": return json(res, 200, await run.start(r.task));
        case "job": return json(res, 200, (await run.job(r)) ?? { started: true });
        case "stop": await run.stop(r.vm); return json(res, 200, { ok: true });
        case "alive": return json(res, 200, { alive: await run.alive(r.vm) });
      }
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  }

  return {
    handle(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const git_ = /^\/__factory\/git\/erga\.git(\/.*)$/.exec(url.pathname);
      if (git_) { git(req, res, git_[1]).catch((e) => res.writeHead(500).end(String(e))); return true; }
      if (url.pathname == "/__factory/vm" && req.method == "POST") {
        if (url.searchParams.get("link") != opts.secret) { res.writeHead(404).end(); return true; }
        vm(req, res).catch((e) => json(res, 500, { error: String(e) }));
        return true;
      }
      return false;
    },
    close() { runner?.close(); },
  };
}
