// `bun erga`: the ops page, a local server on 127.0.0.1 and the page it serves (deploy/cli/ops-view.ts draws it). It
// reads .erga/config.json, .erga/jobs/ and .erga/tests/ (the tests' runs, test-run.ts) in the main clone, which it watches (a change reaches the page at once,
// through /api/events), and the clone's git. It checks its sources (poll-state.ts): GitHub, with a git fetch of the
// clone, at most once a minute, and each instance's commit and health, with its ops token, every 5 seconds. The page
// shows each source's last check. It serves each branch's proof page (bun erga proof) at /proof/<branch>/. Every command works without it. Its Merge and Deploy buttons run
// `bun erga merge` and `bun erga deploy` (POST /api/merge, /api/deploy) in a process of their own, as a terminal does:
// the same code, locks and job records. A merge's tests take minutes, and this server must answer while they run.
// It works the tests' queue (gate.ts, stepQueue): for each pushed branch whose merge has no test record, `bun erga test
// <branch>` (about a minute), one at a time, the oldest first. A branch or a staging head that moves makes a new tree: it waits again.

import { existsSync, type FSWatcher, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, readConfig } from "./config";
import type { Answer } from "./flow";
import { readRuns } from "./test-run";
import { type Queue, stepQueue, testOf } from "./gate";
import { readProofs } from "./proof";
import { askInstance, branchesOf, commitsIn, fetchGitHub } from "./observe";
import { busyWith, type Facts, type Git, type JobRecord, jobOf, mergeBlock, pageHtml, viewHtml } from "./ops-view";
import { alive } from "./pid";
import { type JobState, stepRun } from "./job-state";
import { GITHUB, type PollEvent, startPolls, stepPolls } from "./poll-state";
import { ROOT, sh } from "../root";

const git = (cwd: string, ...args: string[]) => sh(["git", ...args], { cwd });

/** The origin's branches in the clone, with their commits: the key that says when to read git again. */
const refsOf = (cwd: string) => git(cwd, "for-each-ref", "refs/remotes/origin", "--format=%(objectname) %(refname:short)").out;

/** The clone's log and feature branches, as the last fetch left them. */
export function readGit(cwd: string, versions: string[]): Git {
  const has = (ref: string) => git(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).ok;
  const heads = ["origin/staging", "origin/main"].filter(has);
  const base = heads[0] ?? "HEAD";
  const head = (ref: string) => (has(ref) ? git(cwd, "rev-parse", ref).out : null);
  const log = commitsIn(cwd, "--topo-order", "-n", "200", ...(heads.length ? heads : ["HEAD"]));
  const branches = branchesOf(null, cwd, base);
  const elsewhere: Record<string, boolean> = {};
  for (const v of versions) if (!log.some((c) => c.sha.startsWith(v))) elsewhere[v] = has(v);
  return { log, branches, base: base.replace(/^origin\//, ""), main: head("origin/main"), staging: head("origin/staging"), elsewhere };
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
  /** askInstance (observe.ts), or a fake in the tests. */
  ask?: (e: Entry) => Promise<Answer>;
  /** fetchGitHub (null: it worked, else why not), or a fake in the tests. */
  fetch?: (cwd: string) => Promise<string | null>;
  /** Runs `bun erga <args>` for the Merge and Deploy buttons (default: the CLI, in a process of its own), or a fake. */
  run?: (args: string[]) => Run;
  /** Runs all the tests on a branch's merge, for the tests' queue: `bun erga test <branch>` (startOpsPage), or a fake. None: no queue. */
  test?: (branch: string) => Run;
}

const FILES: Record<string, [string, string]> = {
  "/ops-page.css": ["deploy/cli/ops-page.css", "text/css"],
  "/bars.css": ["client/inline/bars.css", "text/css"],
};

/** The ops page's server, on 127.0.0.1. */
export function serveOpsPage(o: OpsPageOptions) {
  const ask = o.ask ?? askInstance;
  const run = o.run ?? runCli(o.cwd);
  const fetchGit = o.fetch ?? fetchGitHub;
  const script = readFileSync(join(ROOT, "deploy/cli/ops-page.js"), "utf8");
  const facts: Facts = {
    config: { instances: [] },
    answers: {},
    git: { error: "Fetching from GitHub…" },
    jobs: [],
    run: { at: "idle" },
    polls: startPolls(),
    runs: [],
    proofs: {},
  };
  /** The tests' queue: the run that this page started, if one is on. */
  let queue: Queue = { at: "idle" };
  let refs = "";
  /** The first fetch ended (well or not): until then, the clone can show branches that GitHub deleted. */
  let fetched = false;
  /** The server stopped: a check that ends after it changes nothing (its clone can be gone). */
  let stopped = false;
  /** The step's next wake (stepPolls). */
  let wake: ReturnType<typeof setTimeout> | null = null;
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
  /** After each change of the facts: the tests' queue looks at them, and the pages hear when what they show changed. */
  const changed = () => {
    work();
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
    facts.runs = readRuns(o.dir);
    facts.proofs = readProofs(o.dir);
    poll({ type: "sources", names: [GITHUB, ...hosts], now: Date.now() });
  };
  /** Steps the tests' queue with what git and the records say now, and starts the run it asks for. Its end is an event. */
  const work = () => {
    if (stopped || !o.test || "error" in facts.git) return;
    const wanted = facts.git.branches.flatMap((b) => (b.tree ? [{ branch: b.name, tree: b.tree, at: b.at }] : []));
    const r = stepQueue(queue, { type: "look", wanted, runs: facts.runs });
    queue = r.queue;
    if (!r.start) return;
    let done: Promise<unknown>;
    try {
      done = o.test(r.start.branch).done;
    } catch {
      done = Promise.resolve();
    }
    void done.then(() => {
      queue = stepQueue(queue, { type: "end" }).queue;
      if (stopped) return;
      // The clone as it is now, so that the next look and the run that ended agree on the trees.
      readClone();
      readFiles();
      changed();
    });
  };
  /** Reads git, once the first fetch ended. */
  const readClone = () => {
    if (!fetched) return;
    try {
      facts.git = readGit(o.cwd, versions());
    } catch (e) {
      facts.git = { error: `git: ${(e as Error).message}` };
    }
  };
  /** Steps the sources' state, starts each check it asks for, and wakes it at the time it names. */
  const poll = (e: PollEvent) => {
    if (stopped) return;
    const r = stepPolls(facts.polls, e);
    facts.polls = r.polls;
    for (const name of r.check) void check(name);
    if (wake) clearTimeout(wake);
    wake = r.wake == null ? null : setTimeout(() => poll({ type: "tick", now: Date.now() }), Math.max(0, r.wake - Date.now()));
    // A check's start alone changes nothing that the page needs at once: its answer redraws it.
    if (e.type != "tick") changed();
  };
  /** One check of a source: GitHub's fetch, or an instance's answer. Its end is the next event. */
  const check = async (name: string) => {
    let error: string | null;
    if (name == GITHUB) {
      error = await fetchGit(o.cwd);
      if (stopped) return;
      fetched = true;
      refs = refsOf(o.cwd);
      readClone();
    } else {
      const e = entries().find((x) => x.host == name);
      const before = versions().join();
      const a = e ? await ask(e).catch((err: Error): Answer => ({ version: null, healthy: null, error: err.message })) : null;
      if (stopped) return;
      if (a && entries().some((x) => x.host == name)) facts.answers[name] = a;
      error = a?.error ?? null;
      if (versions().join() != before) readClone();
    }
    poll({ type: "answer", name, now: Date.now(), error });
  };

  // A change in .erga/ (another terminal's register, deploy or rollback) reaches the page at once.
  let watcher: FSWatcher | null = null;
  let soon: ReturnType<typeof setTimeout> | null = null;
  const onFiles = () => {
    if (soon) clearTimeout(soon);
    soon = setTimeout(readFiles, 50);
  };
  const watchDir = () => {
    if (watcher || !existsSync(o.dir)) return;
    try {
      watcher = watch(o.dir, { recursive: true }, onFiles);
    } catch {}
  };

  refs = refsOf(o.cwd);
  readFiles();
  watchDir();
  // Each 5 seconds: git's refs (a fetch in a terminal) and the jobs' processes.
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
    facts.runs = readRuns(o.dir);
    changed();
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
      const block = mergeBlock(b, facts.git.base, "", testOf(b, facts.runs));
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
      // A POST only from this page (Merge and Deploy): no other site.
      if (req.method != "GET" && !names.some((n) => req.headers.get("origin") == `http://${n}`))
        return new Response("Wrong origin.", { status: 403 });
      if (req.method == "POST" && (url.pathname == "/api/merge" || url.pathname == "/api/deploy")) return act(req, url.pathname.slice(5));
      if (url.pathname == "/") return html(pageHtml(viewHtml(facts, ""), script, code()));
      if (url.pathname == "/view") return html(viewHtml(facts, url.searchParams.get("hash") ?? ""), { "X-Ops-Code": code() });
      if (url.pathname == "/api/events") {
        let me: ReadableStreamDefaultController<string>;
        const stream = new ReadableStream<string>({
          start(c) {
            me = c;
            clients.add(c);
            // A page that loaded before a change (git waits for the first fetch) draws once it listens.
            c.enqueue("data: change\n\n");
          },
          cancel() {
            clients.delete(me);
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
      }
      // A branch's proof page (bun erga proof): the files of .erga/proofs/<branch>/, and nothing above that folder.
      const proof = /^\/proof\/([^/]+)\/([\w.-]*)$/.exec(url.pathname);
      if (proof && !proof[1].startsWith(".") && !proof[2].startsWith(".")) {
        const file = Bun.file(join(o.dir, "proofs", decodeURIComponent(proof[1]).replaceAll("/", "~"), proof[2] || "index.html"));
        return file
          .exists()
          .then((is) =>
            is ? new Response(file, { headers: { "Cache-Control": "no-store" } }) : new Response("No proof here.", { status: 404 })
          );
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
      stopped = true;
      clearInterval(tick);
      if (wake) clearTimeout(wake);
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
      page = serveOpsPage({
        dir: o.dir,
        cwd: o.cwd,
        port: p,
        test: (branch) => runCli(o.cwd)(["test", branch]),
      });
    } catch (e) {
      if (from == 0 || !/in use|EADDRINUSE/i.test((e as Error).message)) throw e;
    }
  }
  if (!page) throw new Error(`No free port from ${from} to ${from + 19}.`);
  const url = `http://127.0.0.1:${page.server.port}/`;
  // The other commands find this page by its port (main.ts).
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(o.dir, "page.port"), String(page.server.port));
  console.log(`PASS  The ops page: ${url}`);
  console.log(`NOTE  It shows the instances of ${join(o.dir, "config.json")}. Keep this command running; Ctrl-C stops it.`);
  if (o.open) Bun.spawn([process.platform == "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });
  return page;
}
