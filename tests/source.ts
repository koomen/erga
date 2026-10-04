#!/usr/bin/env bun
// Erga's own source, end to end, on a dev server of its own (tests/host.ts)
// with its stand-ins for Artifacts and GitHub (dev/git-server.ts):
//
//   - the Git endpoint's auth: no token, a token that isn't one, a user who
//     isn't an admin, an admin;
//   - seeding with source/import.ts, then a real `git clone`, `git push`
//     (a fast-forward, and a rewrite main refuses) and `git pull`;
//   - the API: branches, a merge (a fast-forward, a merge commit, a
//     conflict), who may merge, and a POST from another site;
//   - the GitHub mirror, after each move;
//   - the Source page in headless Chrome: both lanes, the Merge button,
//     updating by itself when someone pushes, light and dark.
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
const host = await startHost(null);
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
  const pushed = git(a, "push", "origin", "main");
  expect(pushed.ok && pushed.err.includes("Erga: main is now"), "a fast-forward push to main lands, and Erga says so", pushed.err);
  must(a, "reset", "-q", "--hard", "HEAD~1");
  commit(a, "app.ts", "export const x = 3;\n", "Rewritten");
  const forced = git(a, "push", "--force", "origin", "main");
  expect(!forced.ok && forced.err.includes("non-fast-forward") && forced.err.includes("fast-forward pushes only"), "a rewrite of main is refused, even forced", forced.err);
  expect(git(a, "push", "--force", "origin", "HEAD:staging").ok, "staging takes it");
  expect(git(a, "push", "origin", "HEAD:feature").err.includes("two branches"), "other branches are refused");
  const b = join(scratch(), "b");
  must(tmpdir(), "clone", "-q", remote(admin.token), b);
  must(a, "checkout", "-q", "-B", "main", "origin/main");
  must(a, "pull", "-q", "--ff-only", "origin", "main");
  commit(a, "notes.txt", "notes\n", "Fourth");
  must(a, "push", "-q", "origin", "main");
  must(b, "pull", "-q", "--ff-only");
  expect(must(b, "log", "-1", "--format=%s") == "Fourth", "git pull brings what another pushed");
  ok("seeded with source/import.ts; git clone, push (fast-forward in, rewrite of main refused) and pull");

  // ---- The API: branches and merging -----------------------------------------------------
  const api = (path: string, init: RequestInit & { as?: "admin" | "bo" | "cookie" | "none" } = {}) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string>) };
    if (init.as == "bo") headers.Authorization = `Bearer ${bo.token}`;
    else if (init.as == "cookie") headers.Cookie = admin.cookie;
    else if (init.as != "none") headers.Authorization = `Bearer ${admin.token}`;
    return fetch(`${root}${path}${init.as == "none" ? "?user=Bo" : ""}`, { ...init, headers, redirect: "manual" });
  };
  let view = await (await api("/api/source/branches")).json() as { branches: { name: string; commit: string; ahead?: number; commits: { subject: string; inMain: boolean }[] }[]; mirror: { error: string | null; lastPushAt: number | null }; remote: string };
  const [staging, main] = view.branches;
  expect(staging.name == "staging" && main.name == "main" && main.commits[0].subject == "Fourth" && staging.commits[0].subject == "Rewritten" && !staging.commits[0].inMain && staging.commits[1].inMain, "GET /api/source/branches: each head and its commits, newest first, and which main has", view);
  expect(staging.ahead == 1 && view.remote == `${root}/git/erga.git`, "how far staging is ahead, and the remote's address", view);
  expect((await api("/api/source/branches", { as: "bo" })).status == 403 && (await api("/api/source/merge", { method: "POST", as: "bo", body: "{}" })).status == 403, "a non-admin can't read or merge");
  expect((await api("/api/source/merge", { method: "POST", as: "cookie", body: "{}", headers: { Origin: "https://evil.example" } })).status == 403, "a merge POSTed from another site is refused");
  r = await api("/api/source/merge", { method: "POST", body: JSON.stringify({ from: "staging", to: "main" }) });
  let merged = await r.json() as { commit?: string; fastForward?: boolean; error?: string };
  expect(r.status == 200 && merged.commit && merged.fastForward === false, "staging and main both moved: a merge commit", merged);
  must(b, "pull", "-q", "--ff-only");
  expect(must(b, "log", "-1", "--format=%s %P").startsWith("Merge staging into main ") && must(b, "show", "HEAD:app.ts") == "export const x = 3;", "the merge commit has both parents and staging's change");
  must(b, "fsck", "--strict");
  // A conflict: the same line, both ways.
  must(b, "checkout", "-q", "-B", "staging", "origin/main");
  commit(b, "README.md", "# Erga, on staging\n\nline 2\nline 3\nline 4\nline 5\nline 6\n", "Staging title");
  must(b, "push", "-q", "--force", "origin", "staging");
  must(b, "checkout", "-q", "main");
  commit(b, "README.md", "# Erga, on main\n\nline 2\nline 3\nline 4\nline 5\nline 6\n", "Main title");
  must(b, "push", "-q", "origin", "main");
  r = await api("/api/source/merge", { method: "POST", body: JSON.stringify({ from: "staging", to: "main" }) });
  const conflict = await r.json() as { error?: string };
  expect(r.status == 409 && conflict.error?.includes("README.md") && conflict.error.includes("by hand"), "a conflict is refused, naming the file", conflict);
  // Fixed by hand on staging (merging main in, keeping staging's title); then the merge is a fast-forward.
  must(b, "checkout", "-q", "staging");
  git(b, "merge", "-q", "main");
  writeFileSync(join(b, "README.md"), "# Erga, on both\n\nline 2\nline 3\nline 4\nline 5\nline 6\n");
  must(b, "commit", "-qam", "Merge main into staging");
  must(b, "push", "-q", "origin", "staging");
  r = await api("/api/source/merge", { method: "POST", as: "cookie", body: JSON.stringify({ from: "staging", to: "main" }), headers: { Origin: origin } });
  merged = await r.json();
  expect(r.status == 200 && merged.fastForward === true, "after merging by hand: a fast-forward (from the page's own session too)", merged);
  ok("the API: branches, merges (a merge commit, a conflict refused, a fast-forward), admins only, from this site only");

  // ---- The GitHub mirror -------------------------------------------------------------------------
  const github = `http://x:erga-dev-github-token@127.0.0.1:${host.port}/__github/koomen/erga.git`;
  await until(async () => must(b, "ls-remote", github, "main").split("\t")[0] == must(b, "ls-remote", "origin", "main").split("\t")[0], 10_000, "GitHub's main follows Erga's");
  view = await (await api("/api/source/branches")).json();
  expect(view.mirror.error == null && view.mirror.lastPushAt, "the mirror is up to date", view.mirror);
  ok("the mirror pushes each move to (a pretend) GitHub");

  // ---- The Source page ------------------------------------------------------------------------------
  expect((await get("/source?user=Bo")).status == 404, "the Source page is for admins only");
  browser = await Browser.launch();
  const p: Page = await browser.page(await browser.context());
  const lanes = () => p.eval<{ staging: string[]; main: string[]; ahead: string; merge: boolean; mirror: string; title: string }>(`({
    staging: [...document.querySelectorAll('.card[data-branch=staging] li[data-sha] .subj')].map((e) => e.textContent),
    main: [...document.querySelectorAll('.card[data-branch=main] li[data-sha] .subj')].map((e) => e.textContent),
    ahead: document.getElementById("ahead").textContent, merge: !document.getElementById("merge").disabled,
    mirror: document.getElementById("mirror-state").textContent, title: document.title })`);
  await p.open(`${root}/source`, { width: 1280, height: 900, scale: 2, clear: false });
  await until(async () => (await lanes()).main.length > 0, 10_000, "the lanes draw");
  let l = await lanes();
  expect(l.main[0] == "Merge main into staging" && l.title.startsWith("Source") && !l.merge && l.ahead.includes("main has everything"), "both lanes, main's newest first; nothing to merge", l);
  expect(await p.eval(`document.querySelector(".crumbs .brand").textContent == "Erga" && document.querySelector(".crumbs .here").textContent == "Source" && !!document.querySelector("[data-erga-account]")`), "breadcrumbs (Erga › Source) and the avatar");
  // Someone pushes to staging: the page shows it without a reload.
  must(b, "checkout", "-q", "staging");
  commit(b, "app.ts", "export const x = 4;\n", "Staging only, live");
  must(b, "push", "-q", "origin", "staging");
  await until(async () => (await lanes()).staging[0] == "Staging only, live", 10_000, "the push shows up by itself", lanes);
  l = await lanes();
  expect(l.merge && l.ahead.startsWith("1 commit"), "and Merge lights up", l);
  expect(await p.eval(`!document.querySelector('.card[data-branch=staging] li[data-sha]').classList.contains("in-main") && document.querySelectorAll('.card[data-branch=staging] li.in-main').length > 0`), "staging's new commit is marked as only on staging; the rest as on main");
  await p.screenshot(join(SHOTS, "source-light.png"));
  // Merge from the page.
  const at = await p.eval<{ x: number; y: number }>(`(() => { const r = document.getElementById("merge").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await p.click(at.x, at.y);
  await until(async () => (await lanes()).main[0] == "Staging only, live", 10_000, "Merge brings staging into main", lanes);
  expect((await p.eval<string>(`document.getElementById("merge-hint").textContent`)).includes("Merged: main is now"), "and says so");
  await until(async () => (await lanes()).mirror.includes("Up to date"), 10_000, "the mirror catches up", lanes);
  await p.open(`${root}/source`, { width: 1280, height: 900, scale: 2, clear: false, dark: true });
  await until(async () => (await lanes()).main.length > 0, 10_000, "the lanes draw (dark)");
  const bg = await p.eval<string>(`getComputedStyle(document.body).backgroundColor`);
  expect(bg != "rgb(255, 255, 255)", "dark follows the system", bg);
  await p.screenshot(join(SHOTS, "source-dark.png"));
  await p.open(`${root}/source`, { width: 390, height: 844, scale: 2, clear: false });
  await until(async () => (await lanes()).main.length > 0, 10_000, "the lanes draw (phone)");
  expect(await p.eval(`document.documentElement.scrollWidth <= innerWidth`), "no sideways scrolling on a phone", await p.eval(`[...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map((e) => e.tagName + "." + e.className + " " + e.id)`));
  await p.screenshot(join(SHOTS, "source-phone.png"));
  expect(!p.errors.length, "no errors on the page", p.errors);
  ok(`the Source page: lanes, live updates, Merge, light, dark and a phone (screenshots in ${SHOTS})`);
} finally {
  browser?.close();
  if (keep) console.log(`kept: ${root}/source (Ctrl-C to stop)`);
  else await host.dispose();
}
if (keep) await new Promise(() => {});
