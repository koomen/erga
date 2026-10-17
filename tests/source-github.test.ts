// The sync with GitHub (server/source/repo.ts syncGithub), with the real git CLI against Erga's endpoint and the
// pretend GitHub (dev/github-mock.ts, its Git host and its webhook): Connect pushes everything there; a push on
// GitHub's staging comes back through the webhook (a fast-forward); both moved: a merge commit here, pushed back;
// conflicts: the merge waits on github-merge/<commit>, the agent resolves and finishes it; GitHub's main follows only
// to a commit of staging; Disconnect forgets the link and uninstalls the App.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlRoutes, type Control } from "../control/routes";
import type { Platform } from "../server/platform";
import type { PushEvent } from "../server/source/github";
import { git, must, startFixture, TEST_APP, type Fixture } from "./source-fixture";

setDefaultTimeout(30_000);
const scratch = () => mkdtempSync(join(tmpdir(), "erga-gh-"));
const ada = { login: "ada", name: "Ada" };

describe("the sync with GitHub", () => {
  let f: Fixture, src: string, github: string;
  const background: Promise<unknown>[] = [];
  let hooks = true;
  // erga.dev's control Worker, as far as the webhook goes: the signature checked, the push handed to the repository.
  const c: Control = {
    platform: { source: { object: { githubPushed: async (_o: string, ev: PushEvent) => f.repo.githubPushed(ev) }, remote: async () => null } } as unknown as Platform,
    github: { appId: "1", ...TEST_APP, www: "", api: "" }, background: (w) => background.push(w),
    app: "https://erga.test", version: "v1", layout: (o) => new Response(o.body), deploys: {} as never,
    oauth: { clientId: "erga-client", accountId: "0".repeat(32), worker: "erga-control", net: fetch },
  };
  const settle = async () => { for (let i = 0; i < 20; i++) { await f.settle(); while (background.length) await Promise.allSettled(background.splice(0)); if (!background.length) break; } await f.settle(); };
  const file = (dir: string, name: string, content: string) => writeFileSync(join(dir, name), content);
  const commit = async (dir: string, message: string) => { await must(dir, "add", "."); await must(dir, "commit", "-qm", message); return must(dir, "rev-parse", "HEAD"); };
  const head = async (remote: string, branch: string) => (await must(src, "ls-remote", remote, `refs/heads/${branch}`)).split("\t")[0];

  beforeAll(async () => {
    f = startFixture({ repos: ["ada/erga"], webhook: (request) => (hooks ? controlRoutes(request, c) : Promise.resolve(new Response("off", { status: 503 }))) });
    github = f.githubRepo("ada/erga");
    src = scratch();
    await must(src, "init", "-q", "-b", "main");
    file(src, "a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    file(src, "README.md", "# Erga\n");
    await commit(src, "First");
    file(src, "b.txt", "bee\n");
    await commit(src, "Second");
    await must(src, "remote", "add", "erga", f.erga);
    await must(src, "push", "-q", "erga", "main:main", "main:staging");
    await f.settle();
  });
  afterAll(() => f.stop());

  test("Connect: the link kept, and the first sync puts staging and main on GitHub", async () => {
    expect(f.repo.githubStatus()).toMatchObject({ connected: false, state: "off", link: null });
    const link = await f.connectGithub("ada/erga");
    await settle();
    const status = f.repo.githubStatus();
    expect(status).toMatchObject({ connected: true, state: "idle", error: null, lastSyncBy: "ada", link: { repo: { fullName: "ada/erga" }, by: "ada" } });
    expect(status.lastSyncAt).toBeGreaterThan(0);
    expect(status.refs).toEqual({ main: await head(f.erga, "main"), staging: await head(f.erga, "staging") });
    expect(await head(github, "staging")).toBe(await head(f.erga, "staging"));
    expect(await head(github, "main")).toBe(await head(f.erga, "main"));
    expect(link.installationId).toBeGreaterThan(0);
    // The token the sync pushed with came from the App (a JWT the pretend GitHub checked).
    expect(f.mock.state.tokens.filter((t) => t.kind == "installation")).toHaveLength(1);
    expect(f.mock.state.badJwts).toBe(0);
  });

  test("a push on GitHub's staging comes back through the webhook: staging fast-forwards, the move says who pushed", async () => {
    const c = scratch();
    await must(c, "clone", "-q", github, "gh");
    const w = join(c, "gh");
    await must(w, "checkout", "-q", "-b", "staging", "origin/staging");
    file(w, "c.txt", "from GitHub\n");
    const sha = await commit(w, "Third, on GitHub");
    await must(w, "push", "-q", "origin", "staging:staging");
    await settle();
    expect(f.mock.state.deliveries.map((d) => `${d.ref}:${d.status}`)).toContain(`refs/heads/staging:202`);
    expect(await head(f.erga, "staging")).toBe(sha);
    const move = f.moves[f.moves.length - 1];
    expect(move).toMatchObject({ branch: "staging", new: sha, how: "github", by: "ada", via: "a push on GitHub" });
    expect(f.repo.githubStatus()).toMatchObject({ error: null, lastSyncBy: "ada, via a push on GitHub" });
  });

  test("both moved: a merge commit here, with both sides, pushed back to GitHub", async () => {
    hooks = false;
    const c = scratch();
    await must(c, "clone", "-q", github, "gh");
    const w = join(c, "gh");
    await must(w, "checkout", "-q", "-b", "staging", "origin/staging");
    file(w, "d.txt", "on GitHub\n");
    const theirs = await commit(w, "Fourth, on GitHub");
    await must(w, "push", "-q", "origin", "staging:staging");
    await f.settle();
    hooks = true;
    // Meanwhile a push here: the sync it starts finds GitHub ahead too.
    await must(src, "fetch", "-q", "erga");
    await must(src, "checkout", "-q", "-B", "staging", "erga/staging");
    file(src, "e.txt", "here\n");
    const ours = await commit(src, "Fifth, here");
    await must(src, "push", "-q", "erga", "staging:staging");
    await settle();
    const merged = await head(f.erga, "staging");
    expect(merged).not.toBe(ours);
    await must(src, "fetch", "-q", "erga");
    expect((await must(src, "log", "-1", "--format=%P", merged)).split(" ").sort()).toEqual([ours, theirs].sort());
    expect(await must(src, "log", "-1", "--format=%s", merged)).toMatch(/^Merge GitHub's staging \([0-9a-f]{7}\)$/);
    expect(await must(src, "ls-tree", "--name-only", merged)).toContain("d.txt");
    expect(await must(src, "ls-tree", "--name-only", merged)).toContain("e.txt");
    expect(await head(github, "staging")).toBe(merged);
    expect(f.repo.githubStatus().error).toBeNull();
    expect(f.moves[f.moves.length - 1]).toMatchObject({ branch: "staging", new: merged, how: "github" });
  });

  test("conflicts: staging stays, the merge waits on github-merge/<commit>; the agent resolves and finishes it, and GitHub gets it", async () => {
    hooks = false;
    const c = scratch();
    await must(c, "clone", "-q", github, "gh");
    const w = join(c, "gh");
    await must(w, "checkout", "-q", "-b", "staging", "origin/staging");
    file(w, "a.txt", "GITHUB\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    const theirs = await commit(w, "Sixth, on GitHub, conflicting");
    await must(w, "push", "-q", "origin", "staging:staging");
    await f.settle();
    hooks = true;
    await must(src, "fetch", "-q", "erga");
    await must(src, "checkout", "-q", "-B", "staging", "erga/staging");
    file(src, "a.txt", "HERE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    const ours = await commit(src, "Seventh, here, conflicting");
    await must(src, "push", "-q", "erga", "staging:staging");
    await settle();
    // Staging is as it was; the conflict waits, and the status says so.
    expect(await head(f.erga, "staging")).toBe(ours);
    expect(await head(github, "staging")).toBe(theirs);
    const status = f.repo.githubStatus();
    expect(status.error).toMatch(/GitHub's staging \([0-9a-f]{7}\) conflicts with staging here in 1 file: the merge waits on github-merge\/[0-9a-f]{12}\./);
    const view = await f.repo.branches();
    expect(view.conflict).toMatchObject({ kind: "github", branch: `github-merge/${theirs.slice(0, 12)}`, target: theirs, ours, files: [{ path: "a.txt", kind: "content" }] });
    expect(await must(src, "ls-remote", f.erga, `github-merge/${theirs.slice(0, 12)}`)).toContain("github-merge");
    // The branch carries the markers; a sync now runs into the same conflict and makes no second branch.
    await f.repo.syncGithub("ada");
    expect((await f.repo.branches()).conflict).toMatchObject({ branch: `github-merge/${theirs.slice(0, 12)}` });
    // The agent resolves the file and finishes: a merge commit moves staging, the branch goes, GitHub gets it.
    const r = await f.repo.resolveUpdate(ada, "a.txt", "BOTH\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    expect(r.remaining).toEqual([]);
    const done = await f.repo.finishUpdate(ada);
    expect(done.version).toBe(theirs.slice(0, 12));
    await settle();
    expect(await head(f.erga, "staging")).toBe(done.commit);
    expect(await head(github, "staging")).toBe(done.commit);
    await must(src, "fetch", "-q", "erga");
    expect((await must(src, "log", "-1", "--format=%P", done.commit)).split(" ").sort()).toEqual([ours, theirs].sort());
    expect(await must(src, "show", `${done.commit}:a.txt`)).toStartWith("BOTH");
    expect((await f.repo.branches()).conflict).toBeNull();
    expect(await must(src, "ls-remote", f.erga)).not.toContain("github-merge");
    expect(f.repo.githubStatus().error).toBeNull();
  });

  test("GitHub's main follows to a commit of staging, and nowhere else", async () => {
    const staging = await head(f.erga, "staging");
    const c = scratch();
    await must(c, "clone", "-q", github, "gh");
    const w = join(c, "gh");
    // main on GitHub moved to staging's head: main here follows (production would deploy it).
    await must(w, "push", "-q", "origin", `${staging}:main`);
    await settle();
    expect(await head(f.erga, "main")).toBe(staging);
    expect(f.moves[f.moves.length - 1]).toMatchObject({ branch: "main", new: staging, how: "github" });
    // main on GitHub moved to a commit staging doesn't have: refused, said, and GitHub's main stays where it put it.
    await must(w, "checkout", "-q", "-B", "gh", "origin/main");
    file(w, "x.txt", "only on GitHub's main\n");
    const stray = await commit(w, "Stray, on GitHub's main");
    await must(w, "push", "-q", "origin", "gh:main");
    await settle();
    expect(await head(f.erga, "main")).toBe(staging);
    expect(await head(github, "main")).toBe(stray);
    expect(f.repo.githubStatus().error).toMatch(/GitHub's main is at [0-9a-f]{7}, which isn't a commit of staging\. main only follows staging/);
    // Moved back on GitHub: the next sync is clean.
    await must(w, "push", "-q", "-f", "origin", `${staging}:main`);
    await settle();
    expect(f.repo.githubStatus().error).toBeNull();
  });

  test("Disconnect: the link goes, the App is uninstalled from the account, nothing syncs", async () => {
    const link = f.repo.githubLink()!;
    expect(f.mock.state.installations.some((i) => i.id == link.installationId)).toBe(true);
    await f.repo.disconnectGithub();
    expect(f.repo.githubLink()).toBeNull();
    expect(f.repo.githubStatus()).toMatchObject({ connected: false, state: "off", error: null, lastSyncAt: null });
    expect(f.mock.state.installations.some((i) => i.id == link.installationId)).toBe(false);
    // A push here now stays here.
    await must(src, "fetch", "-q", "erga");
    await must(src, "checkout", "-q", "-B", "staging", "erga/staging");
    file(src, "f.txt", "after\n");
    const after = await commit(src, "Eighth, after the disconnect");
    expect((await git(src, "push", "-q", "erga", "staging:staging")).ok).toBe(true);
    await settle();
    expect(await head(f.erga, "staging")).toBe(after);
    expect(await head(github, "staging")).not.toBe(after);
  });
});
