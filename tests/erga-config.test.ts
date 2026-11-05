// .erga/config.json (deploy/cli/config.ts): the instances `bun erga register` adds, read and written with their schema,
// a staging instance's link to its primary, and the file's place in the main clone, also from a worktree.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, type Entry, ergaDir, originOf, readConfig, stagingRefusal, withEntry, writeConfig } from "../deploy/cli/config";

const entry = (host: string, over: Partial<Entry> = {}): Entry => ({
  host,
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
  test("no file: no instances; written, it reads back the same, with a staging instance's primary; mode 600", () => {
    const dir = join(tmp(), ".erga");
    try {
      expect(readConfig(dir)).toEqual({ instances: [] });
      const config = withEntry(
        withEntry(readConfig(dir), entry("example.com")),
        entry("staging.example.com", { stagingOf: "example.com" })
      );
      writeConfig(dir, config);
      expect(readConfig(dir)).toEqual(config);
      expect(readConfig(dir).instances[1].stagingOf).toBe("example.com");
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

  test("a staging instance needs a registered primary that is not itself a staging instance", () => {
    const config = withEntry(withEntry({ instances: [] }, entry("a.com")), entry("staging.a.com", { stagingOf: "a.com" }));
    expect(stagingRefusal(config, "staging.a.com", "a.com")).toBeNull();
    expect(stagingRefusal(config, "x.b.com", "b.com")).toContain("b.com has no entry in .erga/config.json");
    expect(stagingRefusal(config, "x.a.com", "staging.a.com")).toContain("not a primary");
    expect(stagingRefusal(config, "a.com", "a.com")).toContain("its own staging instance");
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
