// `bun erga`: the ops page, a local server on 127.0.0.1 and the page it serves (deploy/cli/ops-view.ts draws it). It
// reads .erga/config.json and .erga/jobs/ in the main clone, which it watches (a change reaches the page at once,
// through /api/events), the clone's git as it is (no fetch), and each instance's commit and health, with its ops token:
// every 30 seconds, and every 5 while a job runs. Every command works without it. Its Merge and Deploy buttons run
// `bun erga merge` and `bun erga deploy` (POST /api/merge, /api/deploy) in a process of their own, as a terminal does:
// the same code, locks and job records. A merge's tests take minutes, and this server must answer while they run.

import { existsSync, type FSWatcher, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, originOf, readConfig } from "./config";
import { messageRefusal } from "./flow";
import { readOps } from "./ops";
import {
  type Answer,
  type Branch,
  busyWith,
  type Commit,
  chosenOf,
  deployOf,
  type Facts,
  type Git,
  groupsOf,
  type JobRecord,
  jobOf,
  mergeBlock,
  pageHtml,
  viewHtml,
} from "./ops-view";

const ROOT = new URL("../..", import.meta.url).pathname;

/** A job's process lives (deploy/cli/deploy.ts reads its locks the same way). */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code == "EPERM";
  }
};

/** What an instance answers now: the commit it runs (with its ops token) and its health. */
export async function askInstance(e: Entry): Promise<Answer> {
  const origin = originOf(e.host);
  const site = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  const [ops, health] = await Promise.all([
    // An instance that setup has not registered yet has no token.
    (e.token ? readOps(origin, e.token, site) : Promise.reject(new Error("no token"))).then(
      (f) => ({ version: f.version }),
      (err: Error) => ({
        version: null,
        error: !e.token
          ? `not registered yet: bun erga setup ${e.host}`
          : /refused/.test(err.message)
            ? `refuses the ops token: bun erga login ${e.host}`
            : "no answer",
      })
    ),
    site(`${origin}/api/health`, { headers: { "Cache-Control": "no-cache" } }).then(
      async (r) => r.status == 200 && ((await r.json().catch(() => null)) as { ok?: unknown } | null)?.ok === true,
      () => null
    ),
  ]);
  return { ...ops, healthy: health };
}

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode == 0, code: r.exitCode, out: r.stdout.toString().trim() };
};

/** The origin's branches in the clone, with their commits: the key that says when to read git again. */
const refsOf = (cwd: string) => git(cwd, "for-each-ref", "refs/remotes/origin", "--format=%(objectname) %(refname:short)").out;

/** The clone's log and feature branches, as they are: no fetch. */
export function readGit(cwd: string, versions: string[]): Git {
  const has = (ref: string) => git(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).ok;
  const heads = ["origin/staging", "origin/main"].filter(has);
  const base = heads[0] ?? "HEAD";
  const main = has("origin/main") ? git(cwd, "rev-parse", "origin/main").out : null;
  const out = git(cwd, "log", "--topo-order", "-n", "200", "--format=%H%x1f%s%x1f%ct%x1f%an", ...(heads.length ? heads : ["HEAD"])).out;
  const log: Commit[] = out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, subject, at, author] = l.split("\x1f");
      return { sha, subject, at: Number(at) * 1000, author };
    });
  const branches: Branch[] = git(
    cwd,
    "for-each-ref",
    "refs/remotes/origin",
    "--format=%(refname:short)%1f%(objectname)%1f%(committerdate:unix)%1f%(subject)%1f%(authorname)"
  )
    .out.split("\n")
    .filter(Boolean)
    .map((l) => l.split("\x1f"))
    .map(([ref, sha, at, subject, author]) => ({ name: ref.replace(/^origin\//, ""), sha, at: Number(at) * 1000, subject, author }))
    .filter((b) => !["HEAD", "origin", "staging", "main"].includes(b.name))
    .map((b) => {
      const [behind, ahead] = git(cwd, "rev-list", "--left-right", "--count", `${base}...origin/${b.name}`).out.split(/\s+/).map(Number);
      let conflicts: string[] = [];
      if (ahead) {
        // git merge-tree writes nothing to the clone. Exit 1: the conflicted files follow the tree's line.
        const m = git(cwd, "merge-tree", "--write-tree", "--name-only", "--no-messages", base, `origin/${b.name}`);
        if (m.code == 1) conflicts = [...new Set(m.out.split("\n").slice(1).filter(Boolean))];
      }
      return { ...b, ahead: ahead || 0, behind: behind || 0, conflicts };
    });
  const elsewhere: Record<string, boolean> = {};
  for (const v of versions) if (!log.some((c) => c.sha.startsWith(v))) elsewhere[v] = has(v);
  return { log, branches, base: base.replace(/^origin\//, ""), main, elsewhere };
}

/** Each job record in .erga/jobs/, newest last (the file names start with the time). */
function readJobs(dir: string): JobRecord[] {
  const jobs = join(dir, "jobs");
  if (!existsSync(jobs)) return [];
  return readdirSync(jobs)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .slice(-200)
    .map((f) => {
      try {
        return jobOf(readFileSync(join(jobs, f), "utf8"), alive, f.slice(0, -".jsonl".length));
      } catch {
        return null;
      }
    })
    .filter((j) => j != null);
}

/** The host of the setup in progress: .erga/setup.json's answers (deploy/own/store.ts), or "". */
function setupHost(dir: string): string {
  try {
    const host = (JSON.parse(readFileSync(join(dir, "setup.json"), "utf8")) as { answers?: { host?: unknown } }).answers?.host;
    return typeof host == "string" ? host : "";
  } catch {
    return "";
  }
}

/** A command that the page started: its process, and its end with its output. */
export interface Run {
  pid: number;
  done: Promise<{ code: number; out: string }>;
}

/** `bun erga <args>` in a process of its own, in the clone; its job record says the page started it. */
const runCli =
  (cwd: string) =>
  (args: string[]): Run => {
    const p = Bun.spawn([process.execPath, join(ROOT, "deploy/cli/main.ts"), ...args], {
      cwd,
      env: { ...process.env, ERGA_JOB_FROM: "page" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]).then(([o, e]) => `${o}\n${e}`);
    return { pid: p.pid, done: Promise.all([p.exited, out]).then(([code, text]) => ({ code, out: text })) };
  };

export interface OpsPageOptions {
  /** .erga/ in the main clone. */
  dir: string;
  /** Where git reads the clone. */
  cwd: string;
  port: number;
  /** askInstance, or a fake in the tests. */
  ask?: (e: Entry) => Promise<Answer>;
  /** Runs `bun erga <args>` for the Merge and Deploy buttons (default: the CLI, in a process of its own), or a fake. */
  run?: (args: string[]) => Run;
}

const FILES: Record<string, [string, string]> = {
  "/ops-page.css": ["deploy/cli/ops-page.css", "text/css"],
  "/bars.css": ["client/inline/bars.css", "text/css"],
};

/** The ops page's server, on 127.0.0.1. */
export function serveOpsPage(o: OpsPageOptions) {
  const ask = o.ask ?? askInstance;
  const run = o.run ?? runCli(o.cwd);
  const script = readFileSync(join(ROOT, "deploy/cli/ops-page.js"), "utf8");
  const facts: Facts = {
    config: { instances: [] },
    answers: {},
    git: { error: "Reading git…" },
    jobs: [],
    setup: "",
    starting: "",
    failed: "",
  };
  let refs = "";
  let asked = 0;
  let sent = "";
  const clients = new Set<ReadableStreamDefaultController<string>>();

  const send = (msg: string) => {
    for (const c of clients) {
      try {
        c.enqueue(msg);
      } catch {
        clients.delete(c);
      }
    }
  };
  /** Tells the pages when what they show changed. */
  const changed = () => {
    const now = JSON.stringify(facts);
    if (now == sent) return;
    sent = now;
    send("data: change\n\n");
  };
  const entries = () => ("error" in facts.config ? [] : facts.config.instances);
  const versions = () => Object.values(facts.answers).flatMap((a) => (a.version ? [a.version] : []));
  const readFiles = () => {
    try {
      facts.config = readConfig(o.dir);
    } catch (e) {
      facts.config = { error: (e as Error).message };
    }
    const hosts = new Set(entries().map((e) => e.host));
    for (const h of Object.keys(facts.answers)) if (!hosts.has(h)) delete facts.answers[h];
    facts.jobs = readJobs(o.dir);
    facts.setup = setupHost(o.dir);
  };
  const readClone = () => {
    try {
      facts.git = readGit(o.cwd, versions());
    } catch (e) {
      facts.git = { error: `git: ${(e as Error).message}` };
    }
  };
  /** Asks each instance (only the new ones, with `fresh`), then reads git again if an instance runs a new commit. */
  const askAll = async (fresh = false) => {
    const before = versions().join();
    await Promise.all(
      entries()
        .filter((e) => !fresh || !facts.answers[e.host])
        .map(async (e) => {
          facts.answers[e.host] = await ask(e).catch((err: Error) => ({ version: null, healthy: null, error: err.message }));
        })
    );
    if (versions().join() != before) readClone();
    changed();
  };

  // A change in .erga/ (another terminal's register, deploy or rollback) reaches the page at once.
  let watcher: FSWatcher | null = null;
  let soon: ReturnType<typeof setTimeout> | null = null;
  const onFiles = () => {
    if (soon) clearTimeout(soon);
    soon = setTimeout(() => {
      readFiles();
      changed();
      void askAll(true);
    }, 50);
  };
  const watchDir = () => {
    if (watcher || !existsSync(o.dir)) return;
    try {
      watcher = watch(o.dir, { recursive: true }, onFiles);
    } catch {}
  };

  readFiles();
  readClone();
  refs = refsOf(o.cwd);
  watchDir();
  void askAll();
  asked = Date.now();
  // Each 5 seconds: git's refs (a fetch in a terminal), the jobs' processes, and the instances when it is time.
  const tick = setInterval(() => {
    if (!watcher) {
      watchDir();
      if (watcher) onFiles();
    }
    const r = refsOf(o.cwd);
    if (r != refs) {
      refs = r;
      readClone();
    }
    facts.jobs = readJobs(o.dir);
    const due = facts.jobs.some((j) => j.running) ? 5_000 : 30_000;
    if (Date.now() - asked >= due - 500) {
      asked = Date.now();
      void askAll();
    } else changed();
    send(": still here\n\n");
  }, 5_000);

  /** Starts `bun erga <args>`, unless a job runs: the result is the page's answer. */
  const start = (args: string[]) => {
    const busy = busyWith(facts);
    if (busy) return Response.json({ error: `Another job runs: ${busy}. Wait for it to end.` }, { status: 409 });
    const command = `bun erga ${args[0]} ${args[1]}`;
    let r: Run;
    try {
      r = run(args);
    } catch (e) {
      return Response.json({ error: `${command} did not start: ${(e as Error).message}` }, { status: 500 });
    }
    facts.starting = command;
    facts.failed = "";
    changed();
    void r.done.then(({ code, out }) => {
      facts.starting = "";
      readFiles();
      // A command that stopped before its job record (a lock, a missing credential): its own words, here.
      if (code != 0 && !facts.jobs.some((j) => j.id.endsWith(`-${r.pid}`)))
        facts.failed = `${command} stopped: ${out.trim().split("\n").slice(-4).join(" ") || `exit ${code}`}`;
      changed();
      void askAll();
    });
    return Response.json({ ok: true, command }, { status: 202 });
  };
  /** POST /api/merge {branch, message} and /api/deploy {host, sha}: what the buttons show, checked again here. */
  const act = async (req: Request, what: string) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const no = (error: string) => Response.json({ error }, { status: 409 });
    if ("error" in facts.git) return no(facts.git.error);
    if (what == "merge") {
      const b = facts.git.branches.find((x) => x.name == body.branch);
      const message = typeof body.message == "string" ? body.message.trim() : "";
      if (!b) return no(`There is no branch ${String(body.branch)} in this clone.`);
      const block = mergeBlock(b, facts.git.base, "");
      if (block) return no(block);
      const long = messageRefusal(message);
      if (long) return no(long);
      return start(["merge", b.name, "-m", message]);
    }
    const g = "error" in facts.config ? null : chosenOf(groupsOf(facts.config), String(body.host));
    const dep = g && g.primary.host == body.host ? deployOf(g, { ...facts, git: facts.git }) : null;
    if (!g || !dep) return no(`${String(body.host)} is not behind its staging instances now.`);
    if (dep.commit.sha != body.sha)
      return no(`Staging runs ${dep.commit.sha.slice(0, 12)} now, not ${String(body.sha).slice(0, 12)}. Look again, and deploy again.`);
    if (dep.block) return no(dep.block);
    return start(["deploy", g.primary.host]);
  };

  const html = (body: string) =>
    new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  const server = Bun.serve({
    port: o.port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      // Only this machine's browser, by this server's name: another site can't reach it through DNS rebinding.
      const names = [`localhost:${srv.port}`, `127.0.0.1:${srv.port}`];
      if (!names.includes(req.headers.get("host") ?? "")) return new Response("Wrong host.", { status: 403 });
      // A POST only from this page (the Setup tab's forms, Merge and Deploy): no other site.
      if (req.method != "GET" && !names.some((n) => req.headers.get("origin") == `http://${n}`))
        return new Response("Wrong origin.", { status: 403 });
      // The Setup tab: the checklist of `bun erga setup` (deploy/own/page.ts), loaded only when it is used.
      if (url.pathname == "/setup.js" || url.pathname.startsWith("/setup/"))
        return import("../own/page").then((p) => p.setupRoute(req, url));
      if (req.method == "POST" && (url.pathname == "/api/merge" || url.pathname == "/api/deploy")) return act(req, url.pathname.slice(5));
      if (url.pathname == "/") return html(pageHtml(viewHtml(facts, ""), script));
      if (url.pathname == "/view") return html(viewHtml(facts, url.searchParams.get("hash") ?? ""));
      if (url.pathname == "/api/events") {
        let me: ReadableStreamDefaultController<string>;
        const stream = new ReadableStream<string>({
          start(c) {
            me = c;
            clients.add(c);
            c.enqueue(": open\n\n");
          },
          cancel() {
            clients.delete(me);
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
      }
      if (FILES[url.pathname]) {
        const [path, type] = FILES[url.pathname];
        return new Response(readFileSync(join(ROOT, path)), { headers: { "Content-Type": type } });
      }
      if (url.pathname == "/fonts/inter.css" || /^\/fonts\/[\w-]+\.woff2$/.test(url.pathname)) {
        const type = url.pathname.endsWith(".css") ? "text/css" : "font/woff2";
        return new Response(readFileSync(join(ROOT, "client", url.pathname)), {
          headers: { "Content-Type": type, "Cache-Control": "max-age=3600" },
        });
      }
      return new Response("Not found.", { status: 404 });
    },
  });
  return {
    server,
    stop() {
      clearInterval(tick);
      watcher?.close();
      for (const c of clients) c.close();
      server.stop(true);
    },
  };
}

/** `bun erga [--port N] [--no-open]`: the page on the first free port from 4801, opened in the browser. */
export function startOpsPage(o: { dir: string; cwd: string; port?: number; open: boolean }) {
  let page: ReturnType<typeof serveOpsPage> | null = null;
  const from = o.port ?? 4801;
  for (let p = from; !page && p < from + 20; p++) {
    try {
      page = serveOpsPage({ dir: o.dir, cwd: o.cwd, port: p });
    } catch (e) {
      if (from == 0 || !/in use|EADDRINUSE/i.test((e as Error).message)) throw e;
    }
  }
  if (!page) throw new Error(`No free port from ${from} to ${from + 19}.`);
  const url = `http://127.0.0.1:${page.server.port}/`;
  // Setup's step texts give the person this page's address (deploy/own/cli.ts, pagePort).
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(o.dir, "page.port"), String(page.server.port));
  console.log(`PASS  The ops page: ${url}`);
  console.log(`NOTE  It shows the instances of ${join(o.dir, "config.json")}. Keep this command running; Ctrl-C stops it.`);
  if (o.open) Bun.spawn([process.platform == "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });
  return page;
}
