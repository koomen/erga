// .erga/config.json (deploy/cli/config.ts): the instances `bun erga register` adds, read and written with their schema,
// the repository and branch that each tracks, the source of a copy's data, the move of a file from before those fields
// (old-config.ts), and the file's place in the main clone, also from a worktree.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPath,
  copyRefusal,
  type Entry,
  ergaDir,
  originOf,
  readConfig,
  remoteOf,
  repoName,
  repoUrl,
  withEntry,
  writeConfig,
} from "../deploy/cli/config";
import { movedConfig, moveOldConfig } from "../deploy/cli/old-config";

const entry = (host: string, over: Partial<Entry> = {}): Entry => ({
  host,
  repo: "github.com/koomen/erga",
  branch: "main",
  account: "acc",
  worker: host.split(".")[0],
  database: host.split(".")[0],
  app: { kind: "domain", zoneName: "example.com", hostname: host },
  pages: { kind: "zone", zoneName: "example-pages.com", domain: "example-pages.com" },
  vars: { GITHUB_CLIENT_ID: "Ov23abc", SERVER_DEFAULTS: "{}" },
  token: `erga_${host}`,
  ...over,
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "erga-config-")));
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode != 0) throw new Error(r.stderr.toString());
};

describe(".erga/config.json", () => {
  test("no file: no instances; written, it reads back the same, with what each tracks and a copy's source; mode 600", () => {
    const dir = join(tmp(), ".erga");
    try {
      expect(readConfig(dir)).toEqual({ instances: [] });
      const config = withEntry(
        withEntry(readConfig(dir), entry("example.com")),
        entry("staging.example.com", { branch: "staging", copyOf: "example.com" })
      );
      writeConfig(dir, config);
      expect(readConfig(dir)).toEqual(config);
      expect(readConfig(dir).instances.map((e) => [e.repo, e.branch, e.copyOf])).toEqual([
        ["github.com/koomen/erga", "main", undefined],
        ["github.com/koomen/erga", "staging", "example.com"],
      ]);
      expect(statSync(configPath(dir)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("register again replaces the host's entry in its place", () => {
    const config = withEntry(withEntry({ instances: [] }, entry("a.com")), entry("b.com"));
    const again = withEntry(config, entry("a.com", { token: "erga_new" }));
    expect(again.instances.map((e) => [e.host, e.token])).toEqual([
      ["a.com", "erga_new"],
      ["b.com", "erga_b.com"],
    ]);
  });

  test("a file that doesn't fit the schema: an error that names the file", () => {
    const dir = tmp();
    try {
      writeFileSync(configPath(dir), JSON.stringify({ instances: [{ host: "a.com" }] }));
      expect(() => readConfig(dir)).toThrow(`${configPath(dir)} is not a config file this CLI reads`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a copy's source is a registered instance that runs on its own data", () => {
    const config = withEntry(withEntry({ instances: [] }, entry("a.com")), entry("staging.a.com", { copyOf: "a.com" }));
    expect(copyRefusal(config, "staging.a.com", "a.com")).toBeNull();
    expect(copyRefusal(config, "x.b.com", "b.com")).toContain("b.com has no entry in .erga/config.json");
    expect(copyRefusal(config, "x.a.com", "staging.a.com")).toContain("runs on a copy of a.com's data itself: name a.com");
    expect(copyRefusal(config, "a.com", "a.com")).toContain("a copy of its own data");
  });

  test("a repository's name from each form of its address; the short form is fetched over https; origin is used by its name", () => {
    for (const url of [
      "github.com/koomen/erga",
      "https://github.com/koomen/erga.git",
      "git@github.com:koomen/erga.git",
      "ssh://git@github.com/koomen/erga",
    ])
      expect(repoName(url)).toBe("github.com/koomen/erga");
    expect(repoName("/tmp/origin.git")).toBe("/tmp/origin");
    expect(repoUrl("github.com/koomen/erga")).toBe("https://github.com/koomen/erga");
    expect(repoUrl("/tmp/origin.git")).toBe("/tmp/origin.git");
    expect(repoUrl("git@example.com:team/erga.git")).toBe("git@example.com:team/erga.git");
    const root = tmp();
    try {
      git(root, "init", "--quiet");
      git(root, "remote", "add", "origin", "git@example.com:team/erga.git");
      expect(remoteOf(root, "example.com/team/erga")).toBe("origin");
      expect(remoteOf(root, "github.com/koomen/erga")).toBe("https://github.com/koomen/erga");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a file from before an instance tracked a branch moves, one time: origin's repository, staging for a copy, main for the others", () => {
    const { repo: _r, branch: _b, ...plain } = entry("a.com");
    const copy = { ...plain, host: "staging.a.com", stagingOf: "a.com", token: "erga_staging" };
    const moved = movedConfig({ instances: [plain, copy] }, "example.com/team/erga")!;
    expect(moved.instances.map((e) => [e.host, e.repo, e.branch, e.copyOf, "stagingOf" in e])).toEqual([
      ["a.com", "example.com/team/erga", "main", undefined, false],
      ["staging.a.com", "example.com/team/erga", "staging", "a.com", false],
    ]);
    // Nothing else changes, and a moved file is not moved again.
    expect(moved.instances[1]).toMatchObject({ token: "erga_staging", account: "acc", vars: plain.vars });
    expect(movedConfig(moved, "x")).toBeNull();
    // An entry that a command of the older code wrote back, without the fields it did not know: its vars name its source.
    const stripped = { ...plain, host: "staging.a.com", vars: { ...plain.vars, SNAPSHOT_FROM: "https://a.com" } };
    expect(movedConfig({ instances: [stripped] }, "x")!.instances[0]).toMatchObject({ branch: "staging", copyOf: "a.com" });

    const root = tmp();
    try {
      git(root, "init", "--quiet");
      git(root, "remote", "add", "origin", "https://example.com/team/erga.git");
      const dir = join(root, ".erga");
      writeConfig(dir, { instances: [plain, copy] } as never);
      expect(() => readConfig(dir)).toThrow("is not a config file this CLI reads");
      const said: string[] = [];
      moveOldConfig(dir, (l) => said.push(l));
      expect(readConfig(dir).instances.map((e) => [e.host, e.repo, e.branch, e.copyOf])).toEqual([
        ["a.com", "example.com/team/erga", "main", undefined],
        ["staging.a.com", "example.com/team/erga", "staging", "a.com"],
      ]);
      expect(statSync(configPath(dir)).mode & 0o777).toBe(0o600);
      expect(said.join("\n")).toContain("staging.a.com tracks example.com/team/erga staging now, on a copy of a.com's data");
      const before = statSync(configPath(dir)).mtimeMs;
      moveOldConfig(dir, (l) => said.push(l));
      expect(statSync(configPath(dir)).mtimeMs).toBe(before);
      expect(said.length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the main clone's .erga/, from the clone and from a worktree of it", () => {
    const root = tmp();
    try {
      git(root, "init", "--quiet", "-b", "main");
      git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "start");
      git(root, "worktree", "add", "--quiet", join(root, "wt"));
      expect(ergaDir(root)).toBe(join(root, ".erga"));
      expect(ergaDir(join(root, "wt"))).toBe(join(root, ".erga"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an instance's address: https for a host, http for a local server, a URL as it is", () => {
    expect(originOf("erga.dev")).toBe("https://erga.dev");
    expect(originOf("localhost:4712")).toBe("http://localhost:4712");
    expect(originOf("http://127.0.0.1:9/x")).toBe("http://127.0.0.1:9");
  });
});
