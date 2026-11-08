// `bun erga`: the ops page, a local server on 127.0.0.1 and the page it serves (deploy/cli/ops-view.ts draws it). It
// reads .erga/config.json and .erga/jobs/ in the main clone, which it watches (a change reaches the page at once,
// through /api/events), the clone's git as it is (no fetch), GitHub's branch list (git ls-remote: a branch it deleted
// is left out) and each instance's commit and health, with its ops token: every 30 seconds, and every 5 while a job runs. Every command works without it. Its Merge and Deploy buttons run
// `bun erga merge` and `bun erga deploy` (POST /api/merge, /api/deploy) in a process of their own, as a terminal does:
// the same code, locks and job records. A merge's tests take minutes, and this server must answer while they run.

import { existsSync, type FSWatcher, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, entryOrigin, readConfig } from "./config";
import { githubHeads, rememberedBranches } from "./observe";
import { readOps } from "./ops";
import {
  type Answer,
  type Branch,
  busyWith,
  type Commit,
  type Facts,
  type Git,
  type JobRecord,
  jobOf,
  mergeBlock,
  pageHtml,
  viewHtml,
} from "./ops-view";
import { alive } from "./pid";
import { type JobState, stepRun } from "./job-state";

const ROOT = new URL("../..", import.meta.url).pathname;

/** What an instance answers now: the commit it runs (with its ops token) and its health. */
export async function askInstance(e: Entry): Promise<Answer> {
  const origin = entryOrigin(e);
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

/**
 * The clone's log and feature branches, as they are: no fetch. `live`: the branches GitHub has now (githubHeads); a
 * branch that GitHub deleted is left out. Null: GitHub did not answer, and the list is as the clone remembers it.
 */
export function readGit(cwd: string, versions: string[], live: Set<string> | null): Git {
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
  const branches: Branch[] = rememberedBranches(cwd, live).map((b) => {
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
  return { log, branches, github: live != null, base: base.replace(/^origin\//, ""), main, elsewhere };
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
    run: { at: "idle" },
  };
  let refs = "";
  /** The branches GitHub had at the last ask (null: no answer), and their key. */
  let live: Set<string> | null = null;
  let liveKey = "";
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
  /** Reads git, once GitHub has answered (or not) the first time: the page shows no branch that GitHub deleted. */
  const readClone = () => {
    if (!liveKey) return;
    try {
      facts.git = readGit(o.cwd, versions(), live);
    } catch (e) {
      facts.git = { error: `git: ${(e as Error).message}` };
    }
  };
  /** Asks GitHub for its branches; reads git again when they changed. */
  const askGitHub = async () => {
    live = await githubHeads(o.cwd);
    const key = live ? [...live].sort().join() : "no answer";
    if (key != liveKey) {
      liveKey = key;
      readClone();
    }
  };
  /**
   * Asks each instance (only the new ones, with `fresh`), then reads git again if an instance runs a new commit. Without
   * `fresh` (the poll), it asks GitHub for its branches too.
   */
  const askAll = async (fresh = false) => {
    const before = versions().join();
    await Promise.all([
      fresh ? null : askGitHub(),
      ...entries()
        .filter((e) => !fresh || !facts.answers[e.host])
        .map(async (e) => {
          facts.answers[e.host] = await ask(e).catch((err: Error) => ({ version: null, healthy: null, error: err.message }));
        }),
    ]);
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
  refs = refsOf(o.cwd);
  watchDir();
  void askAll();
  asked = Date.now();
  // Each 5 seconds: git's refs (a fetch in a terminal), the jobs' processes, and GitHub and the instances when it is time.
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
    const due = facts.jobs.some((j) => j.phase == "running") ? 5_000 : 30_000;
    if (Date.now() - asked >= due - 500) {
      asked = Date.now();
      void askAll();
    } else changed();
    send(": still here\n\n");
  }, 5_000);

  /** Starts `bun erga <args>`, unless a job runs: the result is the page's answer. */
  const start = (args: string[], job: JobState) => {
    const busy = busyWith(facts);
    if (busy) return Response.json({ error: `Another job runs: ${busy}. Wait for it to end.` }, { status: 409 });
    const command = `bun erga ${args[0]} ${args[1]}${args[0] == "deploy" ? ` ${args[2]}` : ""}`;
    let r: Run;
    try {
      r = run(args);
    } catch (e) {
      return Response.json({ error: `${command} did not start: ${(e as Error).message}` }, { status: 500 });
    }
    facts.run = stepRun(facts.run, { type: "start", command, job });
    changed();
    void r.done.then(({ code, out }) => {
      readFiles();
      // A command that stopped before its job record (a lock, a missing credential): its own words, here.
      const recorded = facts.jobs.some((j) => j.id.endsWith(`-${r.pid}`));
      facts.run = stepRun(facts.run, { type: "exit", code, out, recorded });
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
      if (!message) return no("Write the message of the commit on staging.");
      const host = entries().find((x) => x.stagingOf)?.host ?? "staging";
      return start(["merge", b.name, "-m", message], { kind: "merge", host, commit: null, branch: b.name, phase: "starting" });
    }
    // A row's Deploy: a commit of the log, to an instance that does not run it now.
    const e = "error" in facts.config ? null : facts.config.instances.find((x) => x.host == body.host);
    const c = facts.git.log.find((x) => x.sha == body.sha);
    if (!e) return no(`${String(body.host)} has no entry in .erga/config.json.`);
    if (!c) return no(`This clone's log has no commit ${String(body.sha).slice(0, 12)}.`);
    const v = facts.answers[e.host]?.version;
    if (v && c.sha.startsWith(v)) return no(`${e.host} runs ${v} already.`);
    return start(["deploy", c.sha.slice(0, 12), e.host], { kind: "deploy", host: e.host, commit: c.sha, branch: null, phase: "starting" });
  };

  const html = (body: string, more = {}) =>
    new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...more } });
  /** The page's own code (its script and styles): a tab that loaded other code reloads (ops-page.js, draw). */
  const code = () =>
    Bun.hash(
      script +
        Object.values(FILES)
          .map(([path]) => readFileSync(join(ROOT, path), "utf8"))
          .join("")
    ).toString(36);
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
      if (url.pathname == "/") return html(pageHtml(viewHtml(facts, ""), script, code()));
      if (url.pathname == "/view") return html(viewHtml(facts, url.searchParams.get("hash") ?? ""), { "X-Ops-Code": code() });
      if (url.pathname == "/api/events") {
        let me: ReadableStreamDefaultController<string>;
        const stream = new ReadableStream<string>({
          start(c) {
            me = c;
            clients.add(c);
            // A page that loaded before a change (git waits for GitHub's first answer) draws once it listens.
            c.enqueue("data: change\n\n");
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
