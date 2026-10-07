// Helpers for the tests of the servers that deploy (fixtures.ts:
// servers.staging, servers.gate, servers.pair): signing in, tokens, Erga's
// own repository through its Git endpoint, the deploy pipeline's status and
// the production gate's runs. Erga's repository is one per server, so a test
// on a shared server never expects it new: seed() gives it a main and a
// staging once, and each test pushes commits of its own on top.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv, ROOT } from "../env";
import { expect, until, type Server } from "../fixtures";

/** The deploy hook's secret the mock Cloudflare's servers share (worker/deploys.ts). */
export const HOOK = "mock-hook-secret-0123456789abcdef";

/** A session cookie: DEV_LOGIN ("tester", an admin), or `as`. */
export async function signIn(root: string, as?: string): Promise<string> {
  const r = await fetch(`${root}/auth/github?${as ? `as=${as}&` : ""}next=/docs`, { redirect: "manual" });
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => /^erga_session(_\d+)?=/.test(c))!;
}

/** A token made on /tokens/new with `cookie`'s session: the admin scope, or the documents scope (no admin power). */
export async function mint(root: string, cookie: string, scope: "admin" | "documents", label = scope): Promise<string> {
  const html = await (await fetch(`${root}/tokens/new`, { method: "POST", headers: { Cookie: cookie, Origin: root }, body: new URLSearchParams({ label, scope }) })).text();
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(html)?.[1] ?? "";
  expect(token, html.slice(0, 300)).toBeTruthy();
  return token;
}

/** The admin's session and admin token on `s`. */
export async function admin(s: Server) {
  const cookie = await signIn(s.root);
  return { cookie, token: await mint(s.root, cookie, "admin") };
}

export const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv(), timeout: 60_000 });
  return { ok: r.status == 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() || (r.error?.message ?? "") };
};
export const must = (cwd: string, ...args: string[]) => { const r = git(cwd, ...args); expect(r.ok, `git ${args.join(" ")}: ${r.err}`).toBe(true); return r.out; };
export const commit = (dir: string, file: string, text: string, message: string) => { writeFileSync(join(dir, file), text); must(dir, "add", file); must(dir, "commit", "-qm", message); return must(dir, "rev-parse", "HEAD"); };
/** A folder for this test's clones, in the server's scratch folder (gone with the server). */
export const scratch = (s: Server) => mkdtempSync(join(s.scratch, "git-"));
/** The Git endpoint's address, with a token as Basic's password, or none. */
export const remote = (s: Server, token: string | null) => token ? `http://erga:${encodeURIComponent(token)}@127.0.0.1:${s.port}/git/erga.git` : `${s.root}/git/erga.git`;

/** The refs Erga's repository has (git ls-remote), by name. */
export function heads(s: Server, token: string): Record<string, string> {
  const r = git(ROOT, "ls-remote", remote(s, token));
  return Object.fromEntries(r.out.split("\n").filter(Boolean).map((l) => { const [sha, ref] = l.split("\t"); return [ref.replace("refs/heads/", ""), sha]; }));
}

const seeded = new Map<string, Promise<void>>();
/** Erga's repository on `s` has a main and a staging (seeded once by source/import.ts, through the endpoint, from a two-commit repository). */
export function seed(s: Server, token: string): Promise<void> {
  let p = seeded.get(s.root);
  if (!p) {
    p = (async () => {
      if (heads(s, token).main) return;
      const src = mkdtempSync(join(s.scratch, "seed-"));
      must(src, "init", "-q", "-b", "main");
      commit(src, "README.md", "# Erga\n", "First");
      commit(src, "app.ts", "export const x = 1;\n", "Second");
      const r = spawnSync("bun", [join(ROOT, "source/import.ts"), s.root, "--from", src], { encoding: "utf8", env: cleanEnv({ ERGA_TOKEN: token }), timeout: 60_000 });
      if (r.status != 0) throw new Error(`source/import.ts: ${r.stdout}${r.stderr}`);
    })();
    seeded.set(s.root, p);
    p.catch(() => seeded.delete(s.root));
  }
  return p;
}

/** A clone of Erga's repository on `s` with an admin token, staging checked out. */
export function clone(s: Server, token: string, branch = "staging") {
  const dir = join(scratch(s), "c");
  must(s.scratch, "clone", "-q", "-b", branch, remote(s, token), dir);
  return dir;
}

export type GateRun = { commit: string; state: string; attempt: number; failed: string[]; flaky: string[]; shards: { n: number; state: string; rerun?: boolean }[]; supersededBy?: string };

/** The production gate's run of `sha` (deploy/gate.ts), and its verdict. */
export const gateOf = async (s: Server, token: string, sha: string) => (await (await fetch(`${s.root}/api/gate/${sha}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { run: GateRun | null; verdict: { ok: boolean; state: string; reason: string | null } };

/** Waits until the tests of `sha` passed (the fake runner: its subject decides), starting a run if it has none. */
export async function gateGreen(s: Server, token: string, sha: string, ms = 20_000) {
  if (!(await gateOf(s, token, sha)).run) await fetch(`${s.root}/api/gate/${sha}/run`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  await until(async () => (await gateOf(s, token, sha)).run?.state == "passed", ms, `the tests of ${sha.slice(0, 7)} pass`);
}

export type Target = { name: string; host: string; branch: string; state: string; commit: string | null; deployed: string | null; error: string | null; pending?: unknown; self?: boolean; deployId?: string; steps: { id: string; status: string; detail: string }[]; log: string[]; history?: unknown[] };

/** A deploy target's status (GET /api/deploys), as the admin sees it (locally a request with no cookie is DEV_LOGIN's). */
export const target = async (s: Server, name: "staging" | "production") =>
  ((await (await fetch(`${s.root}/api/deploys`)).json()) as { targets: Target[] }).targets.find((t) => t.name == name)!;

/** Waits until no deploy of `name` runs or waits (one a test before this left going). */
export const settled = (s: Server, name: "staging" | "production", ms = 30_000) =>
  until(async () => { const t = await target(s, name); return !["building", "deploying"].includes(t.state) && !t.pending; }, ms, `no ${name} deploy runs`);

/** A made-up commit id: one starting 0bad fails to build in the mock builder (deploy/mock.ts). */
export const sha = (failing = false) => (failing ? "0bad" : "5e7a") + [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");

export type LogEvent = { target: string; deployId: string; lines: { at: number; text: string; step?: string }[] };

/** Listens to /api/events: each event's type, and the deploy-log events; close() when done. */
export async function listen(s: Server) {
  const ctl = new AbortController();
  const out = { types: [] as string[], logs: [] as LogEvent[], close: () => ctl.abort() };
  const r = await fetch(`${s.root}/api/events`, { signal: ctl.signal });
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toMatch(/^text\/event-stream/);
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const m of parts) {
        const d = /^data: (.*)$/m.exec(m)?.[1];
        if (!d) continue;
        const e = JSON.parse(d);
        out.types.push(e.type);
        if (e.type == "deploy-log") out.logs.push(e);
      }
    }
  })().catch(() => {});
  await until(() => out.types.includes("hello"), 5_000, "the stream says hello");
  return out;
}

/** The deploy hook, as production passes a push to staging on (with the shared secret). */
export const hook = (s: Server, commit: string) => fetch(`${s.root}/api/deploys/staging/hook`, { method: "POST", headers: { Authorization: `Bearer ${HOOK}`, "Content-Type": "application/json" }, body: JSON.stringify({ branch: "staging", commit }) });

/** Up to how long a deploy on the mock Cloudflare may take (about 2 s: the mock builder's three steps, then fourteen against the mock); a test that waits for one has this much more time. */
export const DEPLOY_MS = 10_000;

/** A clone of `s`'s seeded repository that pushes commits of its own to staging (the fake runner's result: their subject). */
export async function pusher(s: Server, token: string) {
  await seed(s, token);
  const dir = clone(s, token);
  return {
    dir,
    /** A new commit on staging, pushed: its id. */
    push(subject: string) {
      must(dir, "pull", "-q", "--rebase", "origin", "staging");
      commit(dir, "gate-test.txt", `${subject}\n${crypto.randomUUID()}\n`, subject);
      must(dir, "push", "-q", "origin", "HEAD:staging");
      return must(dir, "rev-parse", "HEAD");
    },
    main: () => git(dir, "ls-remote", "origin", "main").out.split("\t")[0],
  };
}

/** POST /api/source/merge as the admin (a token, or the page's session), staging to main. */
export async function merge(s: Server, who: { token: string; cookie: string }, as: "token" | "cookie", body: Record<string, unknown> = {}) {
  const r = await fetch(`${s.root}/api/source/merge`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/json", ...(as == "cookie" ? { Cookie: who.cookie, Origin: s.root } : { Authorization: `Bearer ${who.token}` }) },
    body: JSON.stringify({ from: "staging", to: "main", ...body }),
  });
  return { status: r.status, body: await r.json() as { commit?: string; error?: string; override?: boolean; fastForward?: boolean; upToDate?: boolean } };
}
