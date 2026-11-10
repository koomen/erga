// `bun erga proof` (deploy/cli/proof.ts), on a real clone with a fake `bun run look`: the proof page has the sentence,
// each picture before and after at both widths, the tests' result and the changed files; the ops page serves it and
// links it beside the branch's Merge button (tests/ops-view.test.ts: an old proof, and no proof).

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveOpsPage } from "../deploy/cli/ops-page";
import { type Look, lookArgs, makeProof, proofDir, proofRefusal, readProofs } from "../deploy/cli/proof";

const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode != 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** A clone on the branch `task`, one commit ahead of origin/staging, pushed or not. */
function world(pushed = true) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "erga-proof-test-")));
  const [origin, root] = [join(top, "origin.git"), join(top, "clone")];
  sh(top, "git", "init", "--quiet", "--bare", "-b", "staging", origin);
  sh(top, "git", "clone", "--quiet", origin, root);
  const commit = (file: string, text: string) => {
    writeFileSync(join(root, file), text);
    sh(root, "git", "add", "-A");
    sh(root, "git", "-c", "user.name=Pete", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", text);
    return sh(root, "git", "rev-parse", "HEAD");
  };
  sh(root, "git", "switch", "--quiet", "-c", "staging");
  const base = commit("page.txt", "old page");
  sh(root, "git", "push", "--quiet", "origin", "staging");
  sh(root, "git", "switch", "--quiet", "-c", "task");
  const head = commit("page.txt", "new page");
  if (pushed) sh(root, "git", "push", "--quiet", "origin", "task");
  return { root, dir: join(root, ".erga"), base, head, commit };
}

/** A fake look: its picture is the text of page.txt in the folder it ran in, so before and after differ. */
const looks: string[] = [];
const look: Look = (cwd, args, size, out) => {
  looks.push(`${args.join(" ")} @${size.width}`);
  if (args.includes("--fails")) return "the button is not there";
  writeFileSync(out, readFileSync(join(cwd, "page.txt"), "utf8"));
  return null;
};

test("the refusals, and a look's arguments from one text", () => {
  expect(proofRefusal({ branch: "staging", sentence: "x", looks: 1, noPicture: undefined })).toContain("not a feature branch");
  expect(proofRefusal({ branch: "task", sentence: " ", looks: 1, noPicture: undefined })).toContain("one sentence");
  expect(proofRefusal({ branch: "task", sentence: "x", looks: 0, noPicture: undefined })).toContain("--no-picture");
  expect(proofRefusal({ branch: "task", sentence: "x", looks: 0, noPicture: "tests/a.test.ts" })).toBeNull();
  expect(lookArgs(`--doc empty 'type:- Milk' Enter "type:two words"`)).toEqual([
    "--doc",
    "empty",
    "type:- Milk",
    "Enter",
    "type:two words",
  ]);
});

test("a proof: the sentence, before and after at both widths, the tests' result, the files", () => {
  const w = world();
  looks.length = 0;
  const p = makeProof({
    dir: w.dir,
    root: w.root,
    sentence: "The page says new.",
    looks: ["--path /docs", "--fails"],
    log: () => {},
    look,
  });
  expect([p.branch, p.sha, p.files]).toEqual(["task", w.head, ["page.txt"]]);
  expect(p.tests).toContain("all passing");
  // Before is the commit the branch started from; after is the branch.
  const out = proofDir(w.dir, "task");
  expect(
    ["1-desktop-before.png", "1-desktop-after.png", "1-phone-before.png", "1-phone-after.png"].map((f) =>
      readFileSync(join(out, f), "utf8")
    )
  ).toEqual(["old page", "new page", "old page", "new page"]);
  expect(looks.slice(0, 4)).toEqual(["--path /docs @1280", "--path /docs @1280", "--path /docs @390", "--path /docs @390"]);
  const html = readFileSync(join(out, "index.html"), "utf8");
  for (const text of [
    "The page says new.",
    'src="1-phone-after.png"',
    "No picture: the button is not there",
    "<code>page.txt</code>",
    "all passing",
  ])
    expect(html).toContain(text);
  expect(readProofs(w.dir)).toEqual({ task: { sha: w.head, at: p.at } });
  // The scratch folder of "before" is gone.
  expect(sh(w.root, "git", "worktree", "list").split("\n").length).toBe(1);
});

test("a commit that is not pushed has no test result; no picture at all is an error; a task with nothing to show names its tests", () => {
  const w = world(false);
  expect(makeProof({ dir: w.dir, root: w.root, sentence: "x", looks: ["--path /"], log: () => {}, look }).tests).toContain(
    "not pushed yet"
  );
  expect(() => makeProof({ dir: w.dir, root: w.root, sentence: "x", looks: ["--fails"], log: () => {}, look })).toThrow(
    "No picture of the change"
  );
  const p = makeProof({
    dir: w.dir,
    root: w.root,
    sentence: "The deploy is faster.",
    looks: [],
    noPicture: "tests/deploy.test.ts proves it.",
    log: () => {},
  });
  expect(p.views).toEqual([]);
  expect(readFileSync(join(proofDir(w.dir, "task"), "index.html"), "utf8")).toContain("tests/deploy.test.ts proves it.");
});

test("the ops page links the proof beside Merge, and serves its files and nothing else", async () => {
  const w = world();
  makeProof({ dir: w.dir, root: w.root, sentence: "The page says new.", looks: ["--path /docs"], log: () => {}, look });
  writeFileSync(
    join(w.dir, "config.json"),
    JSON.stringify({
      instances: [
        {
          host: "erga.dev",
          account: "a",
          worker: "w",
          database: "d",
          app: { kind: "workers.dev" },
          pages: { kind: "shared" },
          vars: {},
          token: "t",
        },
      ],
    })
  );
  const page = serveOpsPage({
    dir: w.dir,
    cwd: w.root,
    port: 0,
    ask: async () => ({ version: w.base.slice(0, 12), healthy: true }),
    fetch: async () => null,
  });
  const at = `http://127.0.0.1:${page.server.port}`;
  const view = async () => (await fetch(`${at}/view?hash=erga.dev`)).text();
  const until = async (text: string) => {
    for (let i = 0; i < 200 && !(await view()).includes(text); i++) await Bun.sleep(20);
    return view();
  };
  try {
    expect(await until('data-merge="task"')).toContain('<a class="f-proof" href="/proof/task/" target="_blank"');
    expect(await (await fetch(`${at}/proof/task/`)).text()).toContain("The page says new.");
    expect(await (await fetch(`${at}/proof/task/1-phone-after.png`)).text()).toBe("new page");
    expect((await fetch(`${at}/proof/task/..%2Fconfig.json`)).status).toBe(404);
    expect((await fetch(`${at}/proof/nope/`)).status).toBe(404);
  } finally {
    page.stop();
  }
  expect(existsSync(join(proofDir(w.dir, "task"), "proof.json"))).toBe(true);
});
