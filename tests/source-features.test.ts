// Feature branches (control/source/features.ts): a push makes, moves and deletes one, and it never deploys; the
// Ops page's list says how far it is from staging and whether it merges cleanly; Merge adds ONE commit on staging
// with all the branch's changes (a squash) and deletes the branch; a branch that conflicts is refused; Delete drops
// one. Each Merge and Delete is kept for the Ops page: running, then done or failed. Real git against Erga's endpoint, in front of pretend Artifacts.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, must, startFixture, type Fixture } from "./helpers/source-fixture.ts";

setDefaultTimeout(30_000);
const ada = { login: "ada", name: "Ada" };

describe("feature branches", () => {
  let f: Fixture, w: string;
  const file = (name: string, content: string) => writeFileSync(join(w, name), content);
  const commit = async (message: string) => {
    await must(w, "add", ".");
    await must(w, "commit", "-qm", message);
    return must(w, "rev-parse", "HEAD");
  };
  const head = async (branch: string) => (await must(w, "ls-remote", f.erga, `refs/heads/${branch}`)).split("\t")[0] ?? "";
  /** branches' feature branches, once each check is done. */
  const features = async () => {
    await f.repo.branches();
    await f.settle();
    return (await f.repo.branches()).features;
  };

  beforeAll(async () => {
    f = startFixture();
    w = mkdtempSync(join(tmpdir(), "erga-feature-"));
    await must(w, "init", "-q", "-b", "main");
    file("a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    await commit("First");
    await must(w, "remote", "add", "erga", f.erga);
    await must(w, "push", "-q", "erga", "main:main", "main:staging");
  });
  afterAll(() => f.stop());

  test("a push makes a feature branch: it doesn't deploy, and the list shows it merges cleanly", async () => {
    await must(w, "checkout", "-q", "-b", "big-change");
    file("b.txt", "bee\n");
    await commit("Add b");
    file("a.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    const tip = await commit("Change a's first line");
    const moves = f.moves.length;
    const pushed = await git(w, "push", "erga", "HEAD:big-change");
    expect(pushed.ok).toBe(true);
    expect(pushed.err).toContain("the feature branch big-change is now");
    expect(f.moves.length).toBe(moves);
    expect(await head("big-change")).toBe(tip);
    // Staging moves on beside it, in another file: still clean, one commit behind.
    await must(w, "checkout", "-q", "main");
    file("c.txt", "sea\n");
    await commit("Add c on staging");
    await must(w, "push", "-q", "erga", "main:staging");
    const [b] = await features();
    expect(b).toMatchObject({
      name: "big-change",
      commit: tip,
      ahead: 2,
      behind: 1,
      last: { subject: "Change a's first line", author: "Ada" },
      merge: { state: "clean" },
    });
    expect(b.message).toBe("Change a's first line\n\nThe branch big-change, 2 commits:\n- Change a's first line\n- Add b");
  });

  test("Erga's own branches stay refused", async () => {
    const r = await git(w, "push", "erga", "HEAD:refs/heads/erga-upstream/main", "HEAD:refs/heads/upstream-merge/v9");
    expect(r.ok).toBe(false);
    expect(r.err).toContain("that branch is Erga's own");
  });

  test("Merge: one commit on staging with all the branch's changes, by the admin, with the message given; the branch goes", async () => {
    const staging = await head("staging");
    const r = await f.repo.mergeFeature(ada, "big-change", "Big change\n\nAll of it.");
    expect(r).toMatchObject({ branch: "big-change", commits: 2 });
    expect(await head("staging")).toBe(r.commit);
    expect(await head("big-change")).toBe("");
    expect(f.moves[f.moves.length - 1]).toMatchObject({ branch: "staging", old: staging, new: r.commit, how: "merge", by: "ada" });
    await must(w, "fetch", "-q", "erga");
    expect(await must(w, "log", "-1", "--format=%P", "erga/staging")).toBe(staging);
    expect(await must(w, "log", "-1", "--format=%B", "erga/staging")).toBe("Big change\n\nAll of it.");
    expect(await must(w, "log", "-1", "--format=%an", "erga/staging")).toBe("Ada");
    await must(w, "checkout", "-q", "erga/staging");
    expect(readFileSync(join(w, "a.txt"), "utf8")).toStartWith("ONE\n");
    expect(readFileSync(join(w, "b.txt"), "utf8")).toBe("bee\n");
    expect(readFileSync(join(w, "c.txt"), "utf8")).toBe("sea\n");
    expect(await features()).toEqual([]);
  });

  test("a branch that conflicts with staging: the list names the files, Merge is refused, staging stays", async () => {
    await must(w, "checkout", "-q", "-b", "clash", "erga/staging");
    file("a.txt", "UNO\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    await commit("Spanish first line");
    await must(w, "push", "-q", "erga", "HEAD:clash");
    await must(w, "checkout", "-q", "-b", "other", "erga/staging");
    file("a.txt", "EINS\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    await commit("German first line, on staging");
    await must(w, "push", "-q", "erga", "HEAD:staging");
    const [c] = await features();
    expect(c).toMatchObject({
      name: "clash",
      ahead: 1,
      behind: 1,
      merge: { state: "conflicts", files: [{ path: "a.txt", kind: "content" }] },
    });
    const staging = await head("staging");
    await expect(f.repo.mergeFeature(ada, "clash")).rejects.toThrow("clash conflicts with staging in 1 file (a.txt)");
    expect(await head("staging")).toBe(staging);
    // The Ops page shows why in the branch's row.
    expect((await f.repo.branches()).featureActions.find((a) => a.branch == "clash")).toMatchObject({
      action: "merge",
      state: "failed",
      by: "ada",
      error: expect.stringContaining("clash conflicts with staging"),
    });
  });

  test("a force push moves a feature branch; Delete drops it; staging and main can't be deleted that way", async () => {
    await must(w, "checkout", "-q", "-b", "redo", "erga/staging");
    file("d.txt", "dee\n");
    const tip = await commit("Add d");
    expect((await git(w, "push", "--force", "erga", "HEAD:clash")).ok).toBe(true);
    expect((await features()).find((x) => x.name == "clash")).toMatchObject({
      commit: tip,
      ahead: 1,
      behind: 0,
      merge: { state: "clean" },
    });
    // The Delete shows as running at once, before it has the repository's lock; then as done, with the head it took.
    const deleting = f.repo.deleteFeature("clash", ada);
    expect(f.repo.features.recent().find((a) => a.branch == "clash")).toMatchObject({ action: "delete", state: "running" });
    expect(await deleting).toEqual({ branch: "clash", commit: tip });
    expect(f.repo.features.recent().find((a) => a.branch == "clash")).toMatchObject({
      action: "delete",
      state: "done",
      commit: tip,
      head: tip,
    });
    expect(await head("clash")).toBe("");
    await expect(f.repo.deleteFeature("staging", ada)).rejects.toThrow("isn't a feature branch");
    await expect(f.repo.mergeFeature(ada, "nothing-here")).rejects.toThrow('There\'s no feature branch "nothing-here"');
  });

  test("git push --delete drops a feature branch too", async () => {
    await must(w, "push", "-q", "erga", "HEAD:short-lived");
    const r = await git(w, "push", "erga", "--delete", "short-lived");
    expect(r.ok).toBe(true);
    expect(r.err).toContain("the feature branch short-lived is deleted");
    expect(await head("short-lived")).toBe("");
  });
  test("a check that Artifacts answers busy is tried again; one still busy says it failed, and Check again checks it again", async () => {
    const busy = (n: number) => writeFileSync(join(f.dir, "artifacts", "busy"), String(n));
    const scratch = async () => (await must(w, "ls-remote", f.artifacts, "refs/heads/erga-merge/*")).trim();
    await must(w, "checkout", "-q", "-b", "busy-work", "erga/staging");
    file("e.txt", "ee\n");
    await commit("Add e");
    // Busy once: the check is tried again, and it's clean.
    busy(1);
    await must(w, "push", "-q", "erga", "HEAD:busy-work");
    expect((await features()).find((x) => x.name == "busy-work")?.merge).toEqual({ state: "clean" });
    // Busy for the check and its 3 tries again: it failed, and says why.
    file("e.txt", "eee\n");
    await commit("More e");
    busy(4);
    await must(w, "push", "-q", "erga", "HEAD:busy-work");
    expect((await features()).find((x) => x.name == "busy-work")?.merge).toEqual({
      state: "failed",
      error: expect.stringContaining("artifacts_git_receive_pack_busy"),
    });
    expect(await f.repo.checkFeature("busy-work")).toMatchObject({ branch: "busy-work", merge: { state: "clean" } });
    expect((await features()).find((x) => x.name == "busy-work")?.merge).toEqual({ state: "clean" });
    expect(await scratch()).toBe("");
  });

  test("a scratch ref a merge left behind is deleted, and never shows as a feature branch", async () => {
    const tip = await must(w, "rev-parse", "HEAD");
    await must(w, "push", "-q", f.artifacts, `${tip}:refs/heads/erga-merge/055f09ed`);
    expect((await features()).map((x) => x.name)).not.toContain("erga-merge/055f09ed");
    await f.settle();
    expect(await must(w, "ls-remote", f.artifacts, "refs/heads/erga-merge/*")).toBe("");
  });
});
