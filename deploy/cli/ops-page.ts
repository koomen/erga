// `bun erga`: the ops page, a local server on 127.0.0.1 and the page it serves (deploy/cli/ops-view.ts draws it). It
// reads .erga/config.json, .erga/jobs/ (the merges and the promotes) and .erga/tests/ (the tests' runs, test-run.ts) in the main clone, which it watches (a change reaches the page at once,
// through /api/events), and the clone's git. An instance's deploys and rollbacks are in the instance's own database
// (deploy/deployer/instance.ts): the page reads them with each check of the instance (on AWS, once a minute), and every 5 seconds while one runs there. It checks its sources (poll-state.ts): each repository that an instance
// tracks or names as its upstream, for its branches' heads (one git ls-remote, at most once a minute: the instance's
// commits on the page are the log of that head, and its upstream's commits that it lacks are a comparison of the two heads), each instance's commit (from its platform: running.ts) and health every 15 seconds, and GitHub,
// with a git fetch of the clone, at most once a minute, for the tests' queue. The page
// shows the chosen instance's own checks. It serves each branch's proof page (bun erga proof) at /proof/<branch>/. Every command works without it. Its Deploy and Roll back buttons run
// `bun erga deploy` and `bun erga rollback` (POST /api/deploy, /api/rollback) in a process of their own, as a terminal
// does: the same code, and the same lock and job log on the instance. The page merges nothing: `bun erga merge` does.
// With --auto-deploy it is auto-deploy too (auto-state.ts): it starts `bun erga deploy <head> <host>` for an instance
// that does not run its branch's head, one job at a time, as its buttons do.
// It works the tests' queue (gate.ts, stepQueue): for each pushed branch whose merge has no test record, `bun erga test
// <branch>` (about a minute), one at a time, the oldest first. A branch or a staging head that moves makes a new tree: it waits again.
// The page shows nothing of the queue: `bun erga status` does.
// The verify suite (#verify, verify-view.ts): the page reads its state and its runs' records in .erga/verify/, and its
// buttons run `bun erga verify check`, `bun erga verify <setting> --yes`, `bun erga verify update <setting>` (a kept
// setting) and `bun erga verify remove <setting>` (POST /api/verify), one at a time, apart from the instances' jobs. /verify/log/<id> and /verify/run/<id> give a run's
// output and its record.

import { existsSync, type FSWatcher, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startAuto, stepAuto } from "./auto-state";
import { type Entry, isAws, readConfig } from "./config";
import type { Answer, Branch as StatusBranch } from "./flow";
import { readRuns } from "./test-run";
import { type Queue, stepQueue } from "./gate";
import type { From } from "./jobs";
import { branchesOf, commitsIn, compare, fetchGitHub, inHistory, repoHeads } from "./observe";
import { busyWith, type Facts, type JobRecord, jobOf, pageHtml, repoSource, viewHtml } from "./ops-view";
import { alive } from "./pid";
import { type JobState, stepRun } from "./job-state";
import { GITHUB, type PollEvent, startPolls, stepPolls } from "./poll-state";
import { instanceReader, jobsReader } from "./running";
import { ROOT, sh } from "../root";
import { readKept, readRuns as readVerifyRuns, readState as readVerifyState, verifyDir } from "../../dev/verify/cli";
import { readiness, resultOf, units } from "../../dev/verify/suite";

const git = (cwd: string, ...args: string[]) => sh(["git", ...args], { cwd });

/** The origin's branches in the clone, with their commits: the key that says when to read git again. */
const refsOf = (cwd: string) => git(cwd, "for-each-ref", "refs/remotes/origin", "--format=%(objectname) %(refname:short)").out;

/** A feature branch, for the tests' queue: with the tree of its merge (observe.ts, branchesOf). */
export type Branch = StatusBranch & { author: string; tree: string | null };

/** The clone's feature branches, as the last fetch left them, and the branch they are counted against: what the tests' queue reads. */
export function readGit(cwd: string): { branches: Branch[]; base: string } {
  const base = git(cwd, "rev-parse", "--verify", "--quiet", "origin/staging^{commit}").ok ? "origin/staging" : "HEAD";
  return { branches: branchesOf(null, cwd, base), base: base.replace(/^origin\//, "") };
}

/** Each job record in .erga/jobs/, newest last (the file names start with the time): the merges and the promotes. An instance's jobs are on the instance. */
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
    .filter((j) => j != null)
    .filter((j) => j.kind == "merge" || j.kind == "promote");
}

/** A command that the page started: its process, and its end with its output. */
export interface Run {
  pid: number;
  done: Promise<{ code: number; out: string }>;
}

/** `bun erga <args>` in a process of its own, in the clone; its job's row says that the page started it, or its auto-deploy. */
const runCli =
  (cwd: string) =>
  (args: string[], from: From = "page"): Run => {
    const p = Bun.spawn([process.execPath, join(ROOT, "deploy/cli/main.ts"), ...args], {
      cwd,
      env: { ...process.env, ERGA_JOB_FROM: from },
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
  /** What an instance runs, and its health (running.ts, instanceReader), or a fake in the tests. */
  ask?: (e: Entry) => Promise<Answer>;
  /** An instance's deploys and rollbacks, from its own record (running.ts, jobsReader), or a fake in the tests. */
  jobs?: (e: Entry) => Promise<JobRecord[]>;
  /** fetchGitHub (null: it worked, else why not), or a fake in the tests. */
  fetch?: (cwd: string) => Promise<string | null>;
  /** Runs `bun erga <args>` for the Deploy and Roll back buttons and for auto-deploy (default: the CLI, in a process of its own), or a fake. */
  run?: (args: string[], from: From) => Run;
  /** --auto-deploy: auto-deploy is on. */
  autoDeploy?: boolean;
  /** repoHeads (observe.ts): the heads of a repository's branches, or a fake in the tests. */
  heads?: (cwd: string, repo: string, branches: string[]) => Promise<{ heads: Record<string, string>; error: string | null }>;
  /** Runs all the tests on a branch's merge, for the tests' queue: `bun erga test <branch>` (startOpsPage), or a fake. None: no queue. */
  test?: (branch: string) => Run;
}

/** How often the page reads an AWS instance's jobs while none runs there. */
const AWS_JOBS_MS = 60_000;

const FILES: Record<string, [string, string]> = {
  "/ops-view.css": ["assets/ops/ops-view.css", "text/css"],
  "/ops-page.css": ["deploy/cli/ops-page.css", "text/css"],
  "/bars.css": ["client/inline/bars.css", "text/css"],
};

/** The ops page's server, on 127.0.0.1. */
export function serveOpsPage(o: OpsPageOptions) {
  const ask = o.ask ?? instanceReader();
  const askJobs = o.jobs ?? jobsReader();
  const run = o.run ?? runCli(o.cwd);
  const fetchGit = o.fetch ?? fetchGitHub;
  const askRepo = o.heads ?? repoHeads;
  const script = readFileSync(join(ROOT, "deploy/cli/ops-page.js"), "utf8");
  const facts: Facts = {
    config: { instances: [] },
    answers: {},
    logs: {},
    upstreams: {},
    jobs: [],
    run: { at: "idle" },
    polls: startPolls(),
    runs: [],
    auto: o.autoDeploy ? {} : null,
    heads: {},
    verify: { state: null, runs: [], kept: {}, busy: "", error: "" },
  };
  /** The verify suite's state and records, as the files say them now; a record's result needs its process (pid.ts). */
  const readVerify = () => {
    facts.verify.state = readVerifyState(o.dir);
    facts.verify.runs = readVerifyRuns(o.dir).map((r) => ({ ...r, result: resultOf(r, alive) }));
    facts.verify.kept = readKept(o.dir);
  };
  /** The jobs of this machine's records, and each instance's own, by its host: together, the facts' jobs. */
  let local: JobRecord[] = [];
  const onInstance: Record<string, JobRecord[]> = {};
  const setJobs = () => {
    facts.jobs = [...local, ...entries().flatMap((e) => onInstance[e.host] ?? [])];
  };
  /** Reads an instance's jobs; one read of an instance at a time. An instance that gives no answer keeps its last ones. */
  const reading = new Map<string, Promise<void>>();
  /** When each instance's jobs were last asked for. */
  const asked: Record<string, number> = {};
  const readInstance = (e: Entry): Promise<void> => {
    asked[e.host] = Date.now();
    const now =
      reading.get(e.host) ??
      askJobs(e)
        .then(
          (jobs) => {
            if (stopped) return;
            onInstance[e.host] = jobs;
            setJobs();
          },
          () => {}
        )
        .finally(() => reading.delete(e.host));
    reading.set(e.host, now);
    return now;
  };
  /** The clone's feature branches, for the tests' queue: none before the first fetch ends. */
  let clone: ReturnType<typeof readGit> | null = null;
  /** The head whose log each instance has in the facts: git reads a log again only when its head moves. */
  const logHeads: Record<string, string> = {};
  /** Each instance's upstream: which one its head is of, the head as its repository last answered, and the two heads of the comparison in the facts. */
  const ups: Record<string, { of: string; head: string | null; compared: string }> = {};
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
  /** After each change of the facts: auto-deploy and the tests' queue look at them, and the pages hear when what they show changed. */
  const changed = () => {
    drive();
    work();
    const now = JSON.stringify(facts);
    if (now == sent) return;
    sent = now;
    send("data: change\n\n");
  };
  const entries = () => ("error" in facts.config ? [] : facts.config.instances);
  const readFiles = () => {
    try {
      facts.config = readConfig(o.dir);
    } catch (e) {
      facts.config = { error: (e as Error).message };
    }
    const hosts = new Set(entries().map((e) => e.host));
    for (const h of Object.keys(facts.answers)) if (!hosts.has(h)) delete facts.answers[h];
    for (const h of Object.keys(facts.heads)) if (!hosts.has(h)) delete facts.heads[h];
    for (const h of Object.keys(facts.logs)) if (!hosts.has(h)) delete facts.logs[h], delete logHeads[h];
    for (const h of Object.keys(onInstance)) if (!hosts.has(h)) delete onInstance[h];
    // An upstream that is gone, or another one now (bun erga track): its head and its comparison go.
    for (const h of new Set([...Object.keys(ups), ...Object.keys(facts.upstreams)])) {
      const up = entries().find((e) => e.host == h)?.upstream;
      if (!up || ups[h]?.of != `${up.repo} ${up.branch}`) delete ups[h], delete facts.upstreams[h];
    }
    for (const h of Object.keys(facts.auto ?? {})) if (!hosts.has(h)) delete facts.auto![h];
    // Each repository that an instance tracks or names as its upstream: its branches' heads, for the commits on the
    // page and for auto-deploy.
    const repos = [...new Set(entries().flatMap((e) => [e.repo, ...(e.upstream ? [e.upstream.repo] : [])].map(repoSource)))];
    local = readJobs(o.dir);
    setJobs();
    facts.runs = readRuns(o.dir);
    readVerify();
    poll({ type: "sources", names: [GITHUB, ...repos, ...hosts], now: Date.now() });
  };
  /**
   * Auto-deploy: tells each instance's state what the page sees now, then starts the deploy of the first due one, when
   * no job runs. The deploy's end is an event.
   */
  const drive = () => {
    const auto = facts.auto;
    if (stopped || !auto) return;
    const step = (host: string, e: Parameters<typeof stepAuto>[1]) => {
      const r = stepAuto(auto[host] ?? startAuto(), e);
      auto[host] = r.auto;
      return r.deploy;
    };
    for (const e of entries()) {
      const head = facts.heads[e.host] ?? null;
      const runs = facts.answers[e.host]?.version ?? null;
      const behind = !!head && !!runs && !head.startsWith(runs);
      // A job of this instance has the head: it was tried. Else its history must have the commit that runs.
      const tried = behind && facts.jobs.some((j) => j.kind == "deploy" && j.host == e.host && j.commit == head);
      const rewritten = behind && !tried && !inHistory(o.cwd, runs!, head!);
      step(e.host, { type: "seen", head, runs, tried, rewritten });
    }
    if (busyWith(facts)) return;
    for (const e of entries()) {
      const head = step(e.host, { type: "free" });
      if (!head) continue;
      const job: JobState = { kind: "deploy", host: e.host, commit: head, branch: null, phase: "starting" };
      start(["deploy", head.slice(0, 12), e.host], job, "auto-deploy", (ok, why) => step(e.host, { type: "ended", ok, why }));
      return;
    }
  };
  /** Steps the tests' queue with what git and the records say now, and starts the run it asks for. Its end is an event. */
  const work = () => {
    if (stopped || !o.test || !clone) return;
    const wanted = clone.branches.flatMap((b) => (b.tree ? [{ branch: b.name, tree: b.tree, at: b.at }] : []));
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
  /** Reads the clone's feature branches, once the first fetch ended. */
  const readClone = () => {
    if (!fetched) return;
    try {
      clone = readGit(o.cwd);
    } catch {
      clone = null;
    }
  };
  /** Each instance's commits: the log of the head that its repository last answered, read when that head moves. */
  const readLogs = () => {
    for (const e of entries()) {
      const head = facts.heads[e.host];
      if (!head || logHeads[e.host] == head) continue;
      const log = commitsIn(o.cwd, "-n", "200", head);
      // The clone does not have the head (its fetch failed): the last log stays.
      if (!log.length) continue;
      logHeads[e.host] = head;
      facts.logs[e.host] = log;
    }
  };
  /** Each instance's branch against its upstream: compared again when one of the two heads moves. */
  const readUpstreams = () => {
    for (const e of entries()) {
      const [head, up] = [facts.heads[e.host], ups[e.host]];
      if (!head || !up?.head || up.compared == `${head} ${up.head}`) continue;
      const c = compare(o.cwd, head, up.head);
      // The clone does not have both (a fetch failed): the last comparison stays.
      if (!c) continue;
      up.compared = `${head} ${up.head}`;
      facts.upstreams[e.host] = { head: up.head, behind: c.behind, ahead: c.ahead.length };
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
    } else if (name.startsWith("repo ")) {
      // One repository: the heads of the branches that its instances track, and of those that are an instance's upstream.
      const tracking = entries().filter((e) => repoSource(e.repo) == name);
      const above = entries().filter((e) => e.upstream && repoSource(e.upstream.repo) == name);
      const repo = tracking[0]?.repo ?? above[0]?.upstream?.repo;
      const branches = [...new Set([...tracking.map((e) => e.branch), ...above.map((e) => e.upstream!.branch)])];
      const r = repo
        ? await askRepo(o.cwd, repo, branches).catch((err: Error) => ({
            heads: {} as Record<string, string>,
            error: err.message,
          }))
        : { heads: {}, error: null };
      if (stopped) return;
      // A repository that gave no answer: the last heads stay.
      if (!r.error) {
        for (const e of tracking) facts.heads[e.host] = r.heads[e.branch] ?? null;
        for (const e of above) {
          const up = e.upstream!;
          ups[e.host] = { compared: ups[e.host]?.compared ?? "", of: `${up.repo} ${up.branch}`, head: r.heads[up.branch] ?? null };
        }
      }
      readLogs();
      readUpstreams();
      const gone = branches.filter((b) => !r.heads[b]);
      error = r.error ?? (gone.length ? `no branch ${gone.join(", ")}` : null);
    } else {
      const e = entries().find((x) => x.host == name);
      const [a] = await Promise.all([
        e ? ask(e).catch((err: Error): Answer => ({ version: null, healthy: null, error: err.message })) : null,
        // On AWS a read is a command on the instance's machine: once a minute, while no job runs there.
        e && !(isAws(e) && Date.now() - (asked[e.host] ?? 0) < AWS_JOBS_MS) ? readInstance(e) : null,
      ]);
      if (stopped) return;
      if (a && entries().some((x) => x.host == name)) facts.answers[name] = a;
      error = a?.error ?? null;
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
  // Each 5 seconds: git's refs (a fetch in a terminal), the jobs' processes, and the jobs of each instance where one runs.
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
    local = readJobs(o.dir);
    setJobs();
    for (const e of entries()) {
      const mine = facts.run.at == "starting" && facts.run.job.host == e.host;
      if (mine || onInstance[e.host]?.some((j) => j.phase == "running")) void readInstance(e).then(changed);
    }
    facts.runs = readRuns(o.dir);
    readVerify();
    changed();
    send(": still here\n\n");
  }, 5_000);

  /**
   * Starts `bun erga <args>`, unless a job runs: the result is the page's answer. `ended`: told when the command ends,
   * with its error (its job's on the instance, else its last words).
   */
  const start = (args: string[], job: JobState, from: From = "page", ended?: (ok: boolean, why: string) => void) => {
    const busy = busyWith(facts);
    if (busy) return Response.json({ error: `Another job runs: ${busy}. Wait for it to end.` }, { status: 409 });
    const command = `bun erga ${args[0]} ${args[1]}${args[0] == "deploy" ? ` ${args[2]}` : ""}`;
    let r: Run;
    try {
      r = run(args, from);
    } catch (e) {
      ended?.(false, `${command} did not start: ${(e as Error).message}`);
      return Response.json({ error: `${command} did not start: ${(e as Error).message}` }, { status: 500 });
    }
    const started = Date.now();
    facts.run = stepRun(facts.run, { type: "start", command, job });
    changed();
    void r.done.then(async ({ code, out }) => {
      readFiles();
      // Its job on the instance, read after its end: the newest one of its kind that started with it.
      const e = entries().find((x) => x.host == job.host);
      if (e) await reading.get(e.host), await readInstance(e);
      if (stopped) return;
      // A command that stopped before its job (a lock, a missing credential): its own words, here.
      const record = onInstance[job.host]?.find((j) => j.kind == job.kind && Date.parse(j.started) >= started);
      facts.run = stepRun(facts.run, { type: "exit", code, out, recorded: !!record });
      ended?.(code == 0, record?.error ?? (out.trim().split("\n").slice(-2).join(" ") || `exit ${code}`));
      changed();
    });
    return Response.json({ ok: true, command }, { status: 202 });
  };
  /**
   * POST /api/deploy {host, sha}: a row's Deploy, a commit of the instance's branch that it does not run now. POST
   * /api/rollback {host}: the live row's Roll back. What the button shows, checked again here.
   */
  const act = async (req: Request, what: string) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const no = (error: string) => Response.json({ error }, { status: 409 });
    const e = "error" in facts.config ? null : facts.config.instances.find((x) => x.host == body.host);
    // The live row's Roll back: the instance's version from before its last deploy.
    if (e && what == "rollback")
      return start(["rollback", e.host], { kind: "rollback", host: e.host, commit: null, branch: null, phase: "starting" });
    const c = e ? facts.logs[e.host]?.find((x) => x.sha == body.sha) : null;
    if (!e) return no(`${String(body.host)} has no entry in .erga/config.json.`);
    if (!c) return no(`${e.branch}, the branch that ${e.host} tracks, has no commit ${String(body.sha).slice(0, 12)} in this clone.`);
    const v = facts.answers[e.host]?.version;
    if (v && c.sha.startsWith(v)) return no(`${e.host} runs ${v} already.`);
    return start(["deploy", c.sha.slice(0, 12), e.host], { kind: "deploy", host: e.host, commit: c.sha, branch: null, phase: "starting" });
  };

  /**
   * POST /api/verify {action, unit}: the verify suite's buttons. check: the prerequisites and the accounts again. run:
   * one setting, from deploy to remove (the page asked first, and said the cost). update: a kept setting's code again,
   * and its checks. remove: what a setting's runs left, or a kept setting.
   * One at a time; what the button shows is checked again here, and the command checks the prerequisites itself.
   */
  const verify = async (req: Request) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const no = (error: string, status = 409) => Response.json({ error }, { status });
    const unit = units().find((u) => u.id == body.unit);
    const args =
      body.action == "check"
        ? ["verify", "check"]
        : body.action == "run" && unit
          ? ["verify", unit.id, "--yes"]
          : body.action == "update" && unit
            ? ["verify", "update", unit.id]
            : body.action == "remove" && unit
              ? ["verify", "remove", unit.id]
              : null;
    if (!args) return no("No such action, or no such setting.", 400);
    const busy = facts.verify.busy || facts.verify.runs.find((r) => r.result == "running")?.command;
    if (busy) return no(`Another command runs: ${busy}. Wait for it to end.`);
    if (body.action == "update" && !facts.verify.kept[unit!.id]) return no(`Setting ${unit!.id} is not kept.`);
    if (body.action == "run" && facts.verify.kept[unit!.id]) return no(`Setting ${unit!.id} is kept: Update it, or Remove it first.`);
    if (body.action == "run" || body.action == "update") {
      const r = facts.verify.state ? readiness(unit!, facts.verify.state.prereqs) : null;
      if (!r) return no("The prerequisites are not checked yet: Check again first.");
      if (r.at != "ready") return no(`Blocked by: ${r.by.map((p) => p.title).join("; ")}`);
    }
    const command = `bun erga ${args.filter((a) => a != "--yes").join(" ")}`;
    let r: Run;
    try {
      r = run(args, "page");
    } catch (e) {
      return no(`${command} did not start: ${(e as Error).message}`, 500);
    }
    facts.verify.busy = command;
    facts.verify.error = "";
    changed();
    void r.done.then(({ code, out }) => {
      if (stopped) return;
      facts.verify.busy = "";
      // A run's record says how it ended. A command with no record (a check, a remove, a run that stopped early): its own words, here.
      const recorded = (body.action == "run" || body.action == "update") && readVerifyRuns(o.dir).some((x) => x.pid == r.pid);
      facts.verify.error =
        code == 0 || recorded ? "" : `${command} stopped: ${out.trim().split("\n").slice(-3).join(" ") || `exit ${code}`}`;
      readFiles();
      changed();
    });
    return Response.json({ ok: true, command }, { status: 202 });
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
      // A POST only from this page (Deploy, Roll back): no other site.
      if (req.method != "GET" && !names.some((n) => req.headers.get("origin") == `http://${n}`))
        return new Response("Wrong origin.", { status: 403 });
      if (req.method == "POST" && (url.pathname == "/api/deploy" || url.pathname == "/api/rollback"))
        return act(req, url.pathname.slice(5));
      if (req.method == "POST" && url.pathname == "/api/verify") return verify(req);
      // A run of the verify suite: its output, and its record.
      const ran = /^\/verify\/(log|run)\/([\w.-]+)$/.exec(url.pathname);
      if (ran) {
        const file = Bun.file(join(verifyDir(o.dir), "runs", `${ran[2]}.${ran[1] == "log" ? "log" : "json"}`));
        const type = ran[1] == "log" ? "text/plain; charset=utf-8" : "application/json";
        return file
          .exists()
          .then((is) =>
            is
              ? new Response(file, { headers: { "Content-Type": type, "Cache-Control": "no-store" } })
              : new Response("No such run.", { status: 404 })
          );
      }
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
export function startOpsPage(o: { dir: string; cwd: string; port?: number; open: boolean; autoDeploy?: boolean }) {
  let page: ReturnType<typeof serveOpsPage> | null = null;
  const from = o.port ?? 4801;
  for (let p = from; !page && p < from + 20; p++) {
    try {
      page = serveOpsPage({
        dir: o.dir,
        cwd: o.cwd,
        port: p,
        autoDeploy: o.autoDeploy,
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
  console.log(
    o.autoDeploy
      ? "NOTE  Auto-deploy is on: a new commit on the branch that an instance tracks deploys to it (bun erga deploy), one job at a time."
      : "NOTE  Auto-deploy is off: bun erga --auto-deploy turns it on."
  );
  if (o.open) Bun.spawn([process.platform == "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });
  return page;
}
