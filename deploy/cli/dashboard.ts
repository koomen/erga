// `bun erga dashboard`: the old Ops page on localhost (deploy/cli/dashboard-page.ts draws it): production, staging and
// the other servers (the release each runs, its health, its branch's last run and its log), the feature branches (ahead
// and behind staging, and whether each merges cleanly), and the log of staging and main. It reads GitHub with gh and the
// servers over HTTPS (deploy/cli/observe.ts), in a worker thread, while a page is open: every 5 seconds while a deploy
// waits or runs, else every 30 (pollDelay, deploy/cli/flow.ts). /view tells the page when to ask again (X-Erga-Poll).
//
// Its buttons run `bun erga` itself (merge, release, rollback), `gh run rerun` (Retry) and a delete of a
// feature branch on GitHub, one at a time, and the page shows the output as it comes. It listens on 127.0.0.1 only.
// An action needs this run's random token, which only the page has (a meta tag): another site in the browser can't
// read the page (no CORS), so it can't send one.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTECTED, pollDelay, type State } from "./flow";
import { liveHtml, pageHtml } from "./dashboard-page";
import { ROOT, repoOf } from "./observe";

/** What the page may ask for: each turns into one command (`argvOf`). */
export type Action =
  | { action: "merge"; branch: string; message?: string }
  | { action: "release"; version: string }
  | { action: "rollback"; server: string }
  | { action: "rerun"; run: string }
  | { action: "delete"; branch: string };

const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,100}$/;

/** The command an action runs, or why it can't run. `bun erga` runs as this process runs it (bun deploy/cli/main.ts). */
export function argvOf(a: Partial<Action> & Record<string, unknown>, repo: string): string[] | { error: string } {
  const erga = [process.execPath, join(ROOT, "deploy/cli/main.ts")];
  const branchOk = (b: unknown): b is string => typeof b == "string" && BRANCH.test(b) && !(PROTECTED as readonly string[]).includes(b);
  switch (a.action) {
    case "merge":
      if (!branchOk(a.branch)) return { error: "That is not a feature branch." };
      return [...erga, "merge", a.branch, ...(typeof a.message == "string" && a.message.trim() ? ["-m", a.message.trim()] : [])];
    case "release":
      if (typeof a.version != "string" || !/^v\d+\.\d+\.\d+$/.test(a.version)) return { error: "A version is vX.Y.Z." };
      return [...erga, "release", a.version];
    case "rollback":
      if (a.server != "staging" && a.server != "production") return { error: "Only staging or production rolls back." };
      return [...erga, "rollback", a.server, "--yes"];
    case "rerun":
      if (typeof a.run != "string" || !/^\d+$/.test(a.run)) return { error: "That is not a run." };
      return ["gh", "run", "rerun", a.run, "--failed", "-R", repo];
    case "delete":
      if (!branchOk(a.branch)) return { error: "That is not a feature branch." };
      return ["git", "push", "origin", "--delete", a.branch];
    default:
      return { error: "No such action." };
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Why a request may not act, or null: it must come from this machine, name this server (no DNS rebinding), come from
 * this page if a browser says where from, and carry this run's token.
 */
export function actionRefusal(o: {
  port: number;
  ip: string | null;
  host: string | null;
  origin: string | null;
  token: string;
  given: string | null;
}): string | null {
  const here = [`localhost:${o.port}`, `127.0.0.1:${o.port}`];
  if (!o.ip || !LOOPBACK.has(o.ip)) return "Only this machine may act.";
  if (!o.host || !here.includes(o.host)) return "Wrong host.";
  if (o.origin && !here.map((h) => `http://${h}`).includes(o.origin)) return "Wrong origin.";
  const a = Buffer.from(o.given ?? ""),
    b = Buffer.from(o.token);
  if (a.length != b.length || !timingSafeEqual(a, b)) return "No token, or the wrong one: load the page again.";
  return null;
}

/** A command the page started: its output so far, line by line. */
export interface Job {
  id: number;
  title: string;
  lines: string[];
  done: boolean;
  ok: boolean | null;
}

/** Runs a command and keeps its output in `job.lines` as it comes. */
export function spawnJob(job: Job, argv: string[], onEnd: () => void) {
  const p = Bun.spawn(argv, { cwd: ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, NO_COLOR: "1" } });
  const pump = async (s: ReadableStream<Uint8Array>) => {
    let rest = "";
    const dec = new TextDecoder();
    for await (const chunk of s) {
      const parts = (rest + dec.decode(chunk, { stream: true })).split("\n");
      rest = parts.pop() ?? "";
      job.lines.push(...parts);
    }
    if (rest) job.lines.push(rest);
  };
  Promise.all([pump(p.stdout), pump(p.stderr), p.exited]).then(([, , code]) => {
    job.lines.push(code == 0 ? "PASS  It ended." : `FAIL  It ended with exit ${code}.`);
    job.ok = code == 0;
    job.done = true;
    onEnd();
  });
}

const FILES: Record<string, [string, string]> = {
  "/dashboard.css": ["deploy/cli/dashboard.css", "text/css"],
  "/bars.css": ["client/inline/bars.css", "text/css"],
};

export interface DashboardOptions {
  port: number;
  token?: string;
  /** What the page shows: readState, or a fake in the tests. */
  read?: () => Promise<State>;
  /** Starts a command: spawnJob, or a fake in the tests. */
  run?: (job: Job, argv: string[], onEnd: () => void) => void;
  repo?: string;
}

/** readState in a worker thread (deploy/cli/dashboard-reader.ts), one read at a time. */
function workerRead(): () => Promise<State> {
  let worker: Worker | null = null;
  return () =>
    new Promise((ok, no) => {
      worker ??= new Worker(new URL("./dashboard-reader.ts", import.meta.url).href);
      worker.onmessage = (e: MessageEvent<{ state?: State; error?: string }>) =>
        e.data.state ? ok(e.data.state) : no(new Error(e.data.error ?? "The read failed."));
      worker.onerror = (e) => {
        worker = null;
        no(new Error(e.message));
      };
      worker.postMessage(null);
    });
}

/** The dashboard's server, on 127.0.0.1. */
export function serveDashboard(o: DashboardOptions) {
  const token = o.token ?? randomBytes(24).toString("base64url");
  const read = o.read ?? workerRead();
  const run = o.run ?? spawnJob;
  const repo = o.repo ?? repoOf() ?? "";
  const script = readFileSync(join(ROOT, "deploy/cli/dashboard-client.js"), "utf8");
  let cached: { at: number; value: State | { error: string } } | null = null;
  let pending: Promise<void> | null = null;
  const refresh = () =>
    (pending ??= read()
      .then((value) => {
        cached = { at: Date.now(), value };
      })
      .catch((e: Error) => {
        cached = { at: Date.now(), value: { error: e.message } };
      })
      .finally(() => {
        pending = null;
      }));
  const state = async (fresh: boolean) => {
    // A read is fresh for a bit less than the page waits between reads (pollDelay), so each of the page's reads is new.
    if (fresh || !cached || Date.now() - cached.at > pollDelay(cached.value) - 2_000) await refresh();
    return cached!.value;
  };
  const jobs: Job[] = [];
  const running = () => jobs.find((j) => !j.done) ?? null;
  const html = (body: string) =>
    new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } });

  const server = Bun.serve({
    port: o.port,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      const port = srv.port ?? 0;
      if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.get("host") ?? ""))
        return new Response("Wrong host.", { status: 403 });
      if (url.pathname == "/") return html(pageHtml({ token, live: liveHtml(cached?.value ?? null), script }));
      if (url.pathname == "/view") {
        const s = await state(url.searchParams.has("fresh"));
        const r = html(liveHtml(s));
        r.headers.set("X-Erga-Poll", String(pollDelay(s)));
        return r;
      }
      if (url.pathname == "/api/state") return json(await state(false));
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
      if (!url.pathname.startsWith("/api/")) return new Response("Not found.", { status: 404 });

      // The rest acts, or runs gh: only from this page.
      const no = actionRefusal({
        port,
        ip: srv.requestIP(req)?.address ?? null,
        host: req.headers.get("host"),
        origin: req.headers.get("origin"),
        token,
        given: req.headers.get("x-erga-token"),
      });
      if (no) return json({ error: no }, 403);
      if (url.pathname == "/api/action" && req.method == "POST") {
        const body = (await req.json().catch(() => null)) as (Partial<Action> & Record<string, unknown>) | null;
        if (!body) return json({ error: "The body is not JSON." }, 400);
        const busy = running();
        if (busy) return json({ error: `Wait: ${busy.title} still runs.` }, 409);
        const argv = argvOf(body, repo);
        if ("error" in argv) return json(argv, 400);
        const job: Job = {
          id: jobs.length + 1,
          title: argv.slice(argv[0] == process.execPath ? 2 : 0).join(" "),
          lines: [],
          done: false,
          ok: null,
        };
        if (argv[0] == process.execPath) job.title = `bun erga ${job.title}`;
        job.lines.push(`$ ${job.title}`);
        jobs.push(job);
        run(job, argv, () => {
          cached = null;
        });
        return json({ job: job.id });
      }
      if (url.pathname == "/api/job") {
        const id = Number(url.searchParams.get("id"));
        const job = id ? jobs.find((j) => j.id == id) : (running() ?? jobs.at(-1));
        if (!job) return json({ id: null });
        const from = Number(url.searchParams.get("from")) || 0;
        return json({ id: job.id, title: job.title, lines: job.lines.slice(from), done: job.done, ok: job.ok });
      }
      if (url.pathname == "/api/log") {
        const id = url.searchParams.get("run") ?? "";
        if (!/^\d+$/.test(id)) return json({ error: "That is not a run." }, 400);
        return json(await runLog(repo, id));
      }
      return json({ error: "Not found." }, 404);
    },
  });
  return { server, token };
}

/** A run's state and the end of its log (the failed jobs' when it failed), with gh. */
async function runLog(repo: string, id: string) {
  const gh = async (...args: string[]) => {
    const p = Bun.spawn(["gh", ...args, "-R", repo], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return (await p.exited) == 0 ? out : `(gh: ${err.trim()})`;
  };
  const view = JSON.parse((await gh("run", "view", id, "--json", "status,conclusion,url,headSha,headBranch")) || "{}") as Record<
    string,
    string
  >;
  const failed = view.conclusion == "failure";
  const log = view.status == "completed" ? await gh("run", "view", id, failed ? "--log-failed" : "--log") : "";
  // The job, the step and the time come before each line, with tabs: the old page showed the time and the text.
  const text = log
    .split("\n")
    .map((l) => l.split("\t").slice(1).join("  "))
    .slice(-600)
    .join("\n");
  const state = `${view.headBranch ?? "?"} ${(view.headSha ?? "").slice(0, 7)}: ${view.status == "completed" ? view.conclusion : (view.status ?? "?")}`;
  return {
    url: view.url ?? `https://github.com/${repo}/actions/runs/${id}`,
    state,
    log:
      text || (view.status == "completed" ? "No log." : "The run has not ended: its log comes when it ends. The jobs: open it on GitHub."),
  };
}

/** The first free port from `from`. */
function freePort(from: number): number {
  for (let p = from; p < from + 20; p++) {
    try {
      Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response() }).stop(true);
      return p;
    } catch {}
  }
  return from;
}

export async function startDashboard(wanted: number, open: boolean) {
  const { server } = serveDashboard({ port: freePort(wanted) });
  console.log(`PASS  The dashboard: http://localhost:${server.port}/`);
  console.log(
    "NOTE  Keep this command running. It reads GitHub and the servers while the page is open: every 5 seconds during a deploy, else every 30."
  );
  console.log("NOTE  Its buttons run bun erga merge, release and rollback. Use them only when Pete asks.");
  if (open) Bun.spawn(["open", `http://localhost:${server.port}/`]);
}
