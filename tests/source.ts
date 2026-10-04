#!/usr/bin/env bun
// Erga's own source, end to end, on a dev server of its own (tests/host.ts)
// with its stand-ins for Artifacts and GitHub (dev/git-server.ts):
//
//   - the Git endpoint's auth: no token, a token that isn't one, a user who
//     isn't an admin, an admin;
//   - seeding with source/import.ts, then a real `git clone`, `git push`
//     (a fast-forward, and a rewrite main refuses) and `git pull`;
//   - the strict model: main only follows staging, staging keeps main's
//     commits; merging is a fast-forward of main, to staging's head or a
//     chosen commit; who may merge, and a POST from another site;
//   - the GitHub mirror, after each move;
//   - the Source page in headless Chrome: one list with two dot columns
//     (circles only: hollow orange, only on staging; solid green, on main),
//     the deploy columns (from the deploys stand-in) and a deploy's live
//     log, Merge to here, updating by itself, light, dark and a phone.
//
// Screenshots land in tests/cdp.ts's SHOTS.
//
//   bun tests/source.ts [--keep]     (--keep leaves the server running, seeded)

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, ROOT, SHOTS, type Page } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const keep = process.argv.includes("--keep");
/** The dev server's secret, so the test can drive the deploys stand-in (worker/deploys-stub.ts). */
const LINK = crypto.randomUUID();
const host = await startHost(null, { processEnv: { ERGA_LINK_SECRET: LINK } });
const root = host.root, origin = root;
const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });

/** Signs in as someone (no `as`: DEV_LOGIN, "tester", an admin) and mints an agent token. */
async function tokenFor(as: string | null): Promise<{ token: string; cookie: string }> {
  const r = await fetch(`${root}/auth/github?${as ? `as=${as}&` : ""}next=/docs`, { redirect: "manual" });
  const cookie = r.headers.getSetCookie().map((x) => x.split(";")[0]).find((x) => x.startsWith("erga_session="))!;
  const page = await (await fetch(`${root}/tokens/new`, { method: "POST", headers: { Cookie: cookie, Origin: origin }, body: new URLSearchParams({ label: "Git" }) })).text();
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1] ?? "";
  expect(token, `a token for ${as ?? "tester"}`, page.slice(0, 300));
  return { token, cookie };
}

const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } as Record<string, string>;
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  return { ok: r.status == 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const must = (cwd: string, ...args: string[]) => { const r = git(cwd, ...args); expect(r.ok, `git ${args.join(" ")}`, r.err); return r.out; };
const scratch = () => mkdtempSync(join(tmpdir(), "erga-src-e2e-"));
const remote = (token: string | null) => token ? `http://erga:${encodeURIComponent(token)}@127.0.0.1:${host.port}/git/erga.git` : `${root}/git/erga.git`;
const commit = (dir: string, file: string, text: string, message: string) => { writeFileSync(join(dir, file), text); must(dir, "add", file); must(dir, "commit", "-qm", message); };

let browser: Browser | null = null;
try {
  const admin = await tokenFor(null), bo = await tokenFor("Bo");

  // ---- Who may reach the Git endpoint ------------------------------------------------
  const refs = (auth?: string) => get("/git/erga.git/info/refs?service=git-upload-pack", auth ? { headers: { Authorization: auth } } : {});
  let r = await refs();
  expect(r.status == 401 && (r.headers.get("www-authenticate") ?? "").startsWith("Basic"), "no token: 401, asking for Basic credentials (git then asks for them)", r.status);
  r = await refs(`Basic ${btoa("x:erga_not_a_token")}`);
  expect(r.status == 401, "a token that isn't one: 401", r.status);
  r = await refs(`Basic ${btoa(`x:${bo.token}`)}`);
  expect(r.status == 403 && (await r.text()).includes("Only admins"), "a user who isn't an admin: 403", r.status);
  r = await refs(`Basic ${btoa(`anyone:${admin.token}`)}`);
  expect(r.status == 200 && (r.headers.get("content-type") ?? "").includes("git-upload-pack"), "an admin's token, any username: in", r.status);
  expect(!git(scratch(), "clone", "-q", remote(null), "x").ok, "git clone without credentials fails");
  expect(git(scratch(), "clone", "-q", remote(bo.token), "x").err.includes("403"), "git clone with a non-admin's token is refused (403)");
  ok("the Git endpoint: no token 401, a non-admin 403, an admin in");

  // ---- Seed, clone, push, pull ---------------------------------------------------------------
  const src = scratch();
  must(src, "init", "-q", "-b", "main");
  commit(src, "README.md", "# Erga\n\nline 2\nline 3\nline 4\nline 5\nline 6\n", "First");
  commit(src, "app.ts", "export const x = 1;\n", "Second");
  const seeded = spawnSync("bun", [join(ROOT, "source/import.ts"), root, "--from", src], { encoding: "utf8", env: { ...env, ERGA_TOKEN: admin.token } });
  expect(seeded.status == 0 && seeded.stdout.includes("Done: main and staging"), "source/import.ts seeds main and staging through the endpoint", seeded.stdout + seeded.stderr);
  const again = spawnSync("bun", [join(ROOT, "source/import.ts"), root, "--from", src], { encoding: "utf8", env: { ...env, ERGA_TOKEN: admin.token } });
  expect(again.status != 0 && again.stderr.includes("already has a main"), "and only once", again.stderr);

  const a = join(scratch(), "a");
  must(tmpdir(), "clone", "-q", remote(admin.token), a);
  expect(must(a, "log", "--format=%s").split("\n").join(",") == "Second,First", "git clone brings the history");
  commit(a, "third.txt", "three\n", "Third");
  const early = git(a, "push", "origin", "main");
  expect(!early.ok && early.err.includes("main only follows staging"), "a push to main of a commit staging doesn't have is refused", early.err);
  const both = git(a, "push", "origin", "HEAD:staging", "HEAD:main");
  expect(both.ok && both.err.includes("Erga: main is now") && both.err.includes("Erga: staging is now"), "pushed to staging and main at once, it lands, and Erga says so", both.err);
  must(a, "reset", "-q", "--hard", "HEAD~1");
  commit(a, "app.ts", "export const x = 3;\n", "Rewritten");
  const dropped = git(a, "push", "--force", "origin", "HEAD:staging");
  expect(!dropped.ok && dropped.err.includes("staging is always at or ahead of main"), "a rewrite of staging that drops main's commits is refused, even forced", dropped.err);
  const back = git(a, "push", "--force", "origin", "HEAD~1:main");
  expect(!back.ok && back.err.includes("only moves forward"), "main never moves back", back.err);
  expect(git(a, "push", "origin", "HEAD:feature").err.includes("two branches"), "other branches are refused");
  const b = join(scratch(), "b");
  must(tmpdir(), "clone", "-q", remote(admin.token), b);
  must(a, "fetch", "-q", "origin");
  must(a, "checkout", "-q", "-B", "staging", "origin/staging");
  commit(a, "notes.txt", "notes\n", "Fourth");
  commit(a, "app.ts", "export const x = 5;\n", "Fifth");
  must(a, "push", "-q", "origin", "staging");
  must(b, "fetch", "-q");
  expect(must(b, "log", "-1", "--format=%s", "origin/staging") == "Fifth" && must(b, "log", "-1", "--format=%s", "origin/main") == "Third", "git pull brings what another pushed");
  ok("seeded with source/import.ts; git clone, push (main only follows staging, staging keeps main's commits) and pull");

  // ---- The API: branches and merging (a fast-forward, always) -------------------------------
  const api = (path: string, init: RequestInit & { as?: "admin" | "bo" | "cookie" } = {}) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string>) };
    if (init.as == "bo") headers.Authorization = `Bearer ${bo.token}`;
    else if (init.as == "cookie") headers.Cookie = admin.cookie;
    else headers.Authorization = `Bearer ${admin.token}`;
    return fetch(`${root}${path}`, { ...init, headers, redirect: "manual" });
  };
  let view = await (await api("/api/source/branches")).json() as { branches: { name: string; commit: string; ahead?: number; commits: { sha: string; subject: string; inMain: boolean }[] }[]; mirror: { error: string | null; lastPushAt: number | null }; remote: string };
  const [staging, main] = view.branches;
  expect(staging.name == "staging" && main.name == "main" && main.commits[0].subject == "Third" && staging.commits.map((x) => x.subject).join() == "Fifth,Fourth,Third,Second,First" && !staging.commits[0].inMain && staging.commits[2].inMain, "GET /api/source/branches: staging's commits, newest first, and which main has", view);
  expect(staging.ahead == 2 && view.remote == `${root}/git/erga.git`, "how far staging is ahead, and the remote's address", view);
  expect((await api("/api/source/branches", { as: "bo" })).status == 403 && (await api("/api/source/merge", { method: "POST", as: "bo", body: "{}" })).status == 403, "a non-admin can't read or merge");
  expect((await api("/api/source/merge", { method: "POST", as: "cookie", body: "{}", headers: { Origin: "https://evil.example" } })).status == 403, "a merge POSTed from another site is refused");
  expect((await api("/api/source/merge", { method: "POST", body: JSON.stringify({ from: "main", to: "staging" }) })).status == 400, "merging the other way is refused: main only follows staging");
  const fourth = staging.commits[1].sha;
  r = await api("/api/source/merge", { method: "POST", body: JSON.stringify({ from: "staging", to: "main", commit: fourth }) });
  let merged = await r.json() as { commit?: string; fastForward?: boolean; upToDate?: boolean; error?: string };
  expect(r.status == 200 && merged.commit == fourth && merged.fastForward === true, "main fast-forwards to a chosen staging commit", merged);
  r = await api("/api/source/merge", { method: "POST", body: JSON.stringify({ commit: "1".repeat(40) }) });
  expect(r.status == 409, "but never to a commit staging doesn't have", await r.text());
  r = await api("/api/source/merge", { method: "POST", as: "cookie", body: JSON.stringify({ from: "staging", to: "main" }), headers: { Origin: origin } });
  merged = await r.json();
  expect(r.status == 200 && merged.commit == staging.commit && merged.fastForward === true, "then to staging's head (from the page's own session too)", merged);
  merged = await (await api("/api/source/merge", { method: "POST", body: "{}" })).json();
  expect(merged.upToDate === true, "and then there's nothing to merge", merged);
  must(b, "fetch", "-q");
  expect(must(b, "rev-parse", "origin/main") == must(b, "rev-parse", "origin/staging") && !must(b, "log", "--merges", "--format=%s", "origin/main"), "main is at staging, with no merge commits");
  ok("the API: merging is always a fast-forward of main (to staging's head or a chosen commit); admins only, from this site only");

  // ---- The GitHub mirror -------------------------------------------------------------------------
  const github = `http://x:erga-dev-github-token@127.0.0.1:${host.port}/__github/koomen/erga.git`;
  await until(async () => must(b, "ls-remote", github, "main").split("\t")[0] == must(b, "ls-remote", "origin", "main").split("\t")[0], 10_000, "GitHub's main follows Erga's");
  view = await (await api("/api/source/branches")).json();
  expect(view.mirror.error == null && view.mirror.lastPushAt, "the mirror is up to date", view.mirror);
  ok("the mirror pushes each move to (a pretend) GitHub");

  // ---- Deploys (a stand-in for the pipeline's API until it lands) ------------------------------
  const head = view.branches[0].commit;
  const setDeploys = (body: unknown) => fetch(`${root}/__erga/deploys?link=${LINK}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await (await api("/api/deploys")).json()).targets.length == 0, "no deploy targets until there are some");
  const targets = (stagingState: string, stagingCommit: string) => ({ targets: [
    { name: "staging", host: "staging.erga.dev", branch: "staging", state: stagingState, commit: stagingCommit, deployed: stagingState == "deployed" ? stagingCommit : head, at: Date.now(), error: null, log: [] },
    { name: "production", host: "erga.dev", branch: "main", state: "deployed", commit: fourth, deployed: fourth, at: Date.now() - 600_000, error: null, log: [] },
  ] });
  await setDeploys(targets("deployed", head));
  await setDeploys({ log: { target: "staging", deployId: "d1", commit: head, state: "deployed", lines: [{ at: Date.now(), text: "Building 1a2b3c4", step: "build" }, { at: Date.now(), text: "Deployed", step: "deploy" }] } });
  expect((await (await api("/api/deploys/staging/log")).json()).lines.length == 2, "GET /api/deploys/<name>/log answers the latest deploy's log");

  // ---- The Source page ------------------------------------------------------------------------------
  expect((await get("/source?user=Bo")).status == 404, "the Source page is for admins only");
  browser = await Browser.launch();
  const p: Page = await browser.page(await browser.context());
  const state = () => p.eval<{ rows: { subject: string; staging: string; main: string; live: string[] }[]; heads: string[]; ahead: string; merge: boolean; mirror: string; title: string; targets: string[] }>(`(() => {
    const dot = (el) => {
      if (!el) return "none";
      const s = getComputedStyle(el);
      return [s.borderRadius == "50%" ? "circle" : "shape:" + s.borderRadius, s.transform == "none" ? "" : "transformed", s.backgroundColor, s.borderTopColor].join("|");
    };
    return {
      rows: [...document.querySelectorAll("#grid .row")].map((r) => ({ subject: r.querySelector(".subj span").textContent, kind: r.className,
        staging: dot(r.querySelector('[data-lane=staging]')), main: dot(r.querySelector('[data-lane=main]')),
        live: [...r.querySelectorAll(".live")].map((c) => c.textContent) })),
      heads: [...document.querySelectorAll("#grid .head.lane")].map((h) => h.textContent),
      ahead: document.getElementById("ahead").textContent, merge: !document.getElementById("merge").disabled,
      mirror: document.getElementById("mirror-state").textContent, title: document.title,
      targets: [...document.querySelectorAll(".target")].map((t) => t.textContent.replace(/\\s+/g, " ").trim()),
    };
  })()`);
  await p.open(`${root}/source`, { width: 1280, height: 900, scale: 2, clear: false });
  await until(async () => (await state()).rows.length > 0, 10_000, "the list draws");
  let s = await state();
  expect(s.rows.map((x) => x.subject).join() == "Fifth,Fourth,Third,Second,First" && s.title.startsWith("Source") && !s.merge && s.ahead.includes("main is at staging"), "one list: staging's commits, newest first; nothing to merge", s);
  expect(s.heads.join() == "staging,main", "two dot columns, staging and main", s.heads);
  expect(await p.eval(`document.querySelector(".crumbs .brand").textContent == "Erga" && document.querySelector(".crumbs .here").textContent == "Source" && !!document.querySelector("[data-erga-account]")`), "breadcrumbs (Erga › Source) and the avatar");
  expect(s.targets[0].startsWith("staging") && s.targets[0].includes("live") && s.targets[1].startsWith("production") && s.targets[1].includes("live"), "the deploy columns' heads: each target's status", s.targets);
  expect(s.rows[0].live.join() == "live," && s.rows[1].live.join() == ",live", "each deploy column marks the commit its target has live", s.rows.map((x) => x.live));
  // Someone pushes to staging: the page shows it without a reload, and staging starts deploying it.
  must(b, "checkout", "-q", "-B", "staging", "origin/staging");
  commit(b, "app.ts", "export const x = 6;\n", "Staging only, live");
  must(b, "push", "-q", "origin", "staging");
  const sixth = must(b, "rev-parse", "HEAD");
  await until(async () => (await state()).rows[0]?.subject == "Staging only, live", 10_000, "the push shows up by itself", state);
  await setDeploys(targets("building", sixth));
  await until(async () => (await state()).rows[0].live[0] == "building", 10_000, "the deploy columns follow { type: \"deploys\" }", state);
  s = await state();
  expect(s.merge && s.ahead.startsWith("1 commit"), "and Merge lights up", s);
  // The dots: circles only; hollow orange for only on staging, solid green for on main.
  const [top, below] = s.rows;
  const [, , topBg, topBorder] = top.staging.split("|"), [, , belowBg, belowBorder] = below.staging.split("|");
  const green = belowBg;
  expect([top.staging, below.staging, below.main].every((d) => d.startsWith("circle|")) && s.rows.every((x) => x.staging.startsWith("circle|") && (x.main == "none" || x.main.startsWith("circle|"))), "every dot is a circle, untransformed", s.rows);
  expect(topBorder != topBg && /rgb\((19[0-9]|2\d\d), (9\d|1[0-2]\d|1[5-9]\d), \d{1,2}\)/.test(topBorder) && top.main == "none", "a commit only on staging: a hollow orange circle, and no dot in main's column", top);
  expect(belowBg == belowBorder && /rgb\(\d{1,2}, 1[0-4]\d, \d{2}\)/.test(green) && below.main.split("|")[2] == green, "a commit on main: a solid green circle, in both columns", below);
  await p.screenshot(join(SHOTS, "source-light.png"));
  // The live log: clicking staging's status opens it; new lines arrive as the deploy runs.
  await setDeploys({ log: { target: "staging", deployId: "d2", commit: sixth, state: "building", lines: [{ at: Date.now(), text: "Cloning " + sixth.slice(0, 7), step: "build" }] } });
  const click = async (sel: string) => {
    const at = await p.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await p.click(at.x, at.y);
  };
  await click("#target-staging");
  const logText = () => p.eval<string>(`document.getElementById("log").open ? document.getElementById("log-lines").textContent : "(closed)"`);
  await until(async () => (await logText()).includes("Cloning"), 10_000, "the log opens with the deploy's lines", logText);
  await setDeploys({ append: { target: "staging", lines: [{ at: Date.now(), text: "Bundling the Worker", step: "build" }] } });
  await until(async () => (await logText()).includes("Bundling the Worker"), 10_000, "a new line shows up in the open log by itself ({ type: \"deploy-log\" })", logText);
  // A deploy running on another server sends no events here: the open log asks for new lines itself.
  await setDeploys({ append: { target: "staging", quiet: true, lines: [{ at: Date.now(), text: "Uploading assets (heard by asking)", step: "deploy" }] } });
  await until(async () => (await logText()).includes("heard by asking"), 10_000, "with no events, the open log polls and shows new lines", logText);
  await p.screenshot(join(SHOTS, "source-log.png"));
  await click("#log-close");
  // Merge to a chosen commit from the page: hover the row, click "Merge to here".
  const rowAt = await p.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector("#grid .row .subj").getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
  await p.mouse("mouseMoved", rowAt.x, rowAt.y);
  await until(async () => p.eval(`getComputedStyle(document.querySelector("#grid .row button.here")).display != "none"`), 5_000, "hovering a staging-only commit offers Merge to here");
  await click("#grid .row button.here");
  await until(async () => (await state()).rows[0].main != "none", 10_000, "Merge to here moves main to that commit", state);
  expect((await p.eval<string>(`document.getElementById("merge-hint").textContent`)).includes("Merged: main is now " + sixth.slice(0, 7)), "and says so");
  await until(async () => (await state()).mirror.includes("Up to date"), 10_000, "the mirror catches up", state);
  await p.open(`${root}/source`, { width: 1280, height: 900, scale: 2, clear: false, dark: true });
  await until(async () => (await state()).rows.length > 0, 10_000, "the list draws (dark)");
  const bg = await p.eval<string>(`getComputedStyle(document.body).backgroundColor`);
  expect(bg != "rgb(255, 255, 255)", "dark follows the system", bg);
  await p.screenshot(join(SHOTS, "source-dark.png"));
  await p.open(`${root}/source`, { width: 390, height: 844, scale: 2, clear: false });
  await until(async () => (await state()).rows.length > 0, 10_000, "the list draws (phone)");
  expect(await p.eval(`document.documentElement.scrollWidth <= innerWidth`), "no sideways scrolling on a phone", await p.eval(`[...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map((e) => e.tagName + "." + e.className + " " + e.id)`));
  await p.screenshot(join(SHOTS, "source-phone.png"));
  expect(!p.errors.length, "no errors on the page", p.errors);
  ok(`the Source page: one list with circle dots, deploy columns and their live log, Merge to here, light, dark and a phone (screenshots in ${SHOTS})`);
} finally {
  browser?.close();
  if (keep) console.log(`kept: ${root}/source (Ctrl-C to stop)`);
  else await host.dispose();
}
if (keep) await new Promise(() => {});
