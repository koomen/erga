// The builder: the build container's server and client, the release cache
// that production's build of a staging commit reuses, and a commit fetched
// alone.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { targetOf } from "../control/deploys/branches";
import { unpackRelease } from "../control/deploys/bundle";
import { fromBase64 } from "../shared/bytes";
import { packRelease } from "../control/builder/build";
import { handle as builderServer } from "../control/builder/server";
import { containerBuilder, ndjsonLines } from "../control/builder/client";
import { CACHE_KEEP, CHUNK, cachedBuild, releaseKey, storageStore, toolchainKey } from "../control/builder/cache";
import { mockCloudflare, PROD_DB } from "../dev/mock-cloudflare";
import { TARGETS } from "../deploy/targets";
import { prepareRelease, release, SHA2, SHA3, env, stagingSecrets, staging, deployTo, bindingsOf, ROOT } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

beforeAll(prepareRelease, 120_000);

describe("the builder", () => {
  test("the container's server streams the build and hands back the release; the pipeline's client reads it", async () => {
    const bundle = packRelease(join(ROOT, ".build/release"));
    const fake = async (o: { log: (l: string) => void; commit: string }) => { o.log(`$ bun install (${o.commit.slice(0, 7)})`); o.log("$ bun run build"); return bundle; };
    const fetcher = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => builderServer(new Request(new URL(String(input)), init), fake as never)) as typeof fetch };
    const lines: string[] = [];
    const built = await containerBuilder(fetcher).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "https://artifacts.mock/git/erga/erga.git", token: "t" } }, (l) => lines.push(l));
    expect(lines).toEqual(["$ bun install (2222222)", "$ bun run build"]);
    expect(built.version).toBe(SHA2.slice(0, 12));
    expect(Object.keys(built.modules).sort()).toEqual(Object.keys(release.modules).sort());
    expect(Object.keys(built.assets).sort()).toEqual(Object.keys(release.assets).sort());
    expect((await unpackRelease(bundle)).migrations).toEqual(release.migrations);
    // A failed build says why.
    const failing = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => builderServer(new Request(new URL(String(input)), init), (async () => { throw new Error("bun install failed (exit 1)"); }) as never)) as typeof fetch };
    await expect(containerBuilder(failing).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "x", token: "t" } }, () => {})).rejects.toThrow(/The build failed: bun install failed/);
  });

  test("the release, one line of ~15 MB in small chunks, is read in one pass (it reset the Pipeline object on 2026-10-05)", async () => {
    const bundle = packRelease(join(ROOT, ".build/release"));
    const text = `${JSON.stringify({ log: "é and ✓" })}\n${JSON.stringify({ bundle: new TextDecoder().decode(bundle) })}\n`;
    const bytes = new TextEncoder().encode(text);
    // 1 KB chunks, so a character's bytes and the newlines fall across them.
    const chunks = async function* () { for (let i = 0; i < bytes.length; i += 1021) yield bytes.subarray(i, i + 1021); };
    const t = performance.now();
    const lines: string[] = [];
    for await (const l of ndjsonLines(chunks())) lines.push(l);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).log).toBe("é and ✓");
    expect(JSON.parse(lines[1]).bundle.length).toBe(new TextDecoder().decode(bundle).length);
    // Before, each chunk joined and split the whole line so far: quadratic (seconds for this, and much more on a Worker).
    expect(performance.now() - t).toBeLessThan(2000);
    const fetcher = { fetch: (async () => new Response(new ReadableStream({ async start(c) { for await (const x of chunks()) c.enqueue(x.slice()); c.close(); } }))) as unknown as typeof fetch };
    const built = await containerBuilder(fetcher).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "x", token: "t" } }, () => {});
    for (const [n, b] of Object.entries(release.modules)) expect(built.modules[n]).toEqual(b);
    for (const [p, b] of Object.entries(release.assets)) expect(built.assets[p]).toEqual(b);
    // A last line with no newline is read too; base64 decodes the same on every path.
    const tail: string[] = [];
    for await (const l of ndjsonLines((async function* () { yield new TextEncoder().encode('{"a":1}\n{"b"'); yield new TextEncoder().encode(":2}"); })())) tail.push(l);
    expect(tail).toEqual(['{"a":1}', '{"b":2}']);
    const raw = crypto.getRandomValues(new Uint8Array(1000));
    expect(fromBase64(Buffer.from(raw).toString("base64"))).toEqual(raw);
  });

  test("a cancelled deploy stops its build: the client asks the container to cancel, and the build's commands are killed", async () => {
    let stopped = false;
    const slow = async (o: { log: (l: string) => void; signal?: AbortSignal }) => {
      o.log("$ bun install");
      await new Promise<void>((_, no) => o.signal!.addEventListener("abort", () => { stopped = true; no(o.signal!.reason); }));
      return new Uint8Array();
    };
    const fetcher = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => builderServer(new Request(new URL(String(input)), init), slow as never)) as typeof fetch };
    const abort = new AbortController();
    const lines: string[] = [];
    const build = containerBuilder(fetcher).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "x", token: "t" } }, (l) => { lines.push(l); abort.abort(new Error("superseded")); }, abort.signal);
    await expect(build).rejects.toThrow("superseded");
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(true);
    expect(lines).toEqual(["$ bun install"]);
    // The container is free again; a cancel with nothing running stops nothing.
    expect(await (await builderServer(new Request("http://builder/cancel", { method: "POST", body: "{}" }))).json()).toEqual({ stopped: false });
    // The real runner kills the command it's running.
    const { spawnRunner } = await import("../control/builder/build");
    const kill = new AbortController();
    const started = Date.now();
    setTimeout(() => kill.abort(new Error("cancelled")), 50);
    await expect(spawnRunner(["sleep", "5"], { cwd: ROOT, log: () => {}, signal: kill.signal })).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("two builds at once each get a container of their own, and both succeed; a 503 (no container free) is waited out (it failed staging's deploy on 2026-10-05)", async () => {
    const bundle = new TextDecoder().decode(packRelease(join(ROOT, ".build/release")));
    // The Worker in front, as a mock: one container per build id (each busy with one build), and the first start of one build finds none free.
    const busy = new Set<string>(), ids: string[] = [], cancels: string[] = [];
    let refused = 0, inFlight = 0, most = 0;
    const fetcher = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)), id = url.searchParams.get("id")!;
      if (url.pathname == "/cancel") { cancels.push(id); return Response.json({ stopped: busy.has(id) }); }
      ids.push(id);
      if (refused++ == 0) return Response.json({ error: "The build container didn't start." }, { status: 503 });
      if (busy.has(id)) return Response.json({ error: "A build is already running." }, { status: 409 });
      busy.add(id); most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      busy.delete(id); inFlight--;
      return new Response(`${JSON.stringify({ log: `built ${id.slice(0, 4)}` })}\n${JSON.stringify({ bundle })}\n`);
    }) as typeof fetch };
    const slept: number[] = [];
    const builder = containerBuilder(fetcher, { sleep: async (ms) => { slept.push(ms); } });
    const lines: string[][] = [[], []];
    const [a, b] = await Promise.all([0, 1].map((n) => builder.build({ commit: SHA2, branch: n ? "main" : "staging", source: { cloneUrl: "x", token: "t" } }, (l) => lines[n].push(l))));
    expect(a.version).toBe(SHA2.slice(0, 12));
    expect(b.version).toBe(SHA2.slice(0, 12));
    expect(most).toBe(2);
    expect(new Set(ids).size).toBe(2);
    expect(slept).toEqual([5000]);
    expect(lines.flat().filter((l) => l.startsWith("waiting for the builder"))).toHaveLength(1);
    // A 503 that doesn't clear gives up after ~5 minutes, with backoff, and says why.
    const down = { fetch: (async () => Response.json({ error: "The build container didn't start." }, { status: 503 })) as unknown as typeof fetch };
    const waits: number[] = [];
    await expect(containerBuilder(down, { sleep: async (ms) => { waits.push(ms); } }).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "x", token: "t" } }, () => {})).rejects.toThrow(/answered 503: .*didn't start/);
    expect(waits.slice(0, 4)).toEqual([5000, 10000, 20000, 30000]);
    expect(waits.reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(300_000);
    // A cancel reaches the build's own container.
    const abort = new AbortController();
    const hang = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname == "/cancel") { cancels.push(url.searchParams.get("id")!); return Response.json({ stopped: true }); }
      ids.push(url.searchParams.get("id")!);
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`${JSON.stringify({ log: "go" })}\n`)); } }));
    }) as typeof fetch };
    await expect(containerBuilder(hang).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "x", token: "t" } }, () => abort.abort(new Error("superseded")), abort.signal)).rejects.toThrow("superseded");
    expect(cancels).toEqual([ids.at(-1)!]);
  });
});

describe("the release cache", () => {
  const memStore = () => {
    const m = new Map<string, { line: string; at: number; branch?: string }>();
    return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, line: string, meta: { at: number; branch?: string }) => { m.set(k, { line, ...meta }); } };
  };
  const body = (commit: string, branch: string) => JSON.stringify({ source: { cloneUrl: "x", token: "t" }, commit, branch });
  const src = { cloneUrl: "x", token: "t" };

  test("a commit built for staging is reused by production's build of it: no second build, the same release; a new toolchain builds again", async () => {
    const bundle = packRelease(join(ROOT, ".build/release"));
    let builds = 0;
    const fake = async (o: { log: (l: string) => void }) => { builds++; o.log("$ bun install"); return bundle; };
    const store = memStore();
    const toolchain = await toolchainKey({ bun: "1.4.2", builderVersion: "v-1" });
    const kept: Promise<unknown>[] = [];
    // The builder Worker, as worker.ts has it: the cache in front of the container's server.
    const worker = (tc: string | null) => ({ fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(new URL(String(input)), init);
      if (new URL(req.url).pathname != "/build") return builderServer(req, fake as never);
      return cachedBuild(await req.text(), { store, toolchain: tc, keep: (p) => kept.push(p), build: (b) => builderServer(new Request(req.url, { method: "POST", body: b }), fake as never) });
    }) as typeof fetch });
    const first = await containerBuilder(worker(toolchain)).build({ commit: SHA2, branch: "staging", source: src }, () => {});
    await Promise.all(kept);
    expect(builds).toBe(1);
    expect([...store.m.values()].map((v) => v.branch)).toEqual(["staging"]);
    const again: string[] = [];
    const second = await containerBuilder(worker(toolchain)).build({ commit: SHA2, branch: "main", source: src }, (l) => again.push(l));
    expect(builds).toBe(1);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatch(/^release cache: 222222222222 was built at .* \(for staging\) by this builder: that release is reused/);
    expect(second.version).toBe(first.version);
    expect(second.worker).toEqual(first.worker);
    for (const [n, b] of Object.entries(first.modules)) expect(second.modules[n]).toEqual(b);
    for (const [p, b] of Object.entries(first.assets)) expect(second.assets[p]).toEqual(b);

    // A new toolchain (the builder deployed again: a new image; a new Bun): a miss, and a build.
    const other = await toolchainKey({ bun: "1.4.2", builderVersion: "v-2" });
    expect(other).not.toBe(toolchain);
    expect(await toolchainKey({ bun: "1.5.0", builderVersion: "v-1" })).not.toBe(toolchain);
    await containerBuilder(worker(other)).build({ commit: SHA2, branch: "main", source: src }, () => {});
    await Promise.all(kept);
    expect(builds).toBe(2);
    expect(store.m.size).toBe(2);
    // No builder version (so no toolchain), or a short commit id: nothing kept or reused.
    expect(await toolchainKey({ bun: "1.4.2", builderVersion: undefined })).toBeNull();
    expect(releaseKey(SHA2.slice(0, 12), toolchain)).toBeNull();
    expect(releaseKey(SHA2, null)).toBeNull();
    await containerBuilder(worker(null)).build({ commit: SHA2, branch: "main", source: src }, () => {});
    await containerBuilder(worker(toolchain)).build({ commit: SHA2.slice(0, 12), branch: "main", source: src }, () => {});
    await Promise.all(kept);
    expect(builds).toBe(4);
    expect(store.m.size).toBe(2);
  });

  test("only a release the build ended with is kept: not a failed build, a log line, or a cancelled build", async () => {
    const store = memStore();
    const toolchain = await toolchainKey({ bun: "1.4.2", builderVersion: "v-1" });
    const kept: Promise<unknown>[] = [];
    const o = (build: () => Promise<Response>) => ({ store, toolchain, keep: (p: Promise<unknown>) => kept.push(p), build });
    await (await cachedBuild(body(SHA3, "staging"), o(async () => new Response(`${JSON.stringify({ log: "x" })}\n${JSON.stringify({ error: "bun install failed" })}\n`)))).text();
    await (await cachedBuild(body(SHA3, "staging"), o(async () => new Response(`${JSON.stringify({ log: '{"bundle":"no"}' })}\n`)))).text();
    const cancelled = await cachedBuild(body(SHA3, "staging"), o(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`${JSON.stringify({ bundle: "{}" })}\n`)); } }))));
    const reader = cancelled.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.all(kept);
    expect(store.m.size).toBe(0);
    // A refused build (409, 503) is passed on as it is.
    expect((await cachedBuild(body(SHA3, "staging"), o(async () => Response.json({ error: "busy" }, { status: 409 })))).status).toBe(409);
  });

  test("the same kept release on two targets: each gets its own settings, names, database and secrets at the upload", async () => {
    const store = memStore();
    const toolchain = await toolchainKey({ bun: "1.4.2", builderVersion: "v-1" });
    const bundle = new TextDecoder().decode(packRelease(join(ROOT, ".build/release")));
    const kept: Promise<unknown>[] = [];
    await (await cachedBuild(body(SHA2, "staging"), { store, toolchain, keep: (p) => kept.push(p), build: async () => new Response(`${JSON.stringify({ bundle })}\n`) })).text();
    await Promise.all(kept);
    const hit = await cachedBuild(body(SHA2, "main"), { store, toolchain, build: async () => { throw new Error("no build on a hit"); } });
    const line = (await hit.text()).trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.bundle)!;
    expect(line.bundle).toBe(bundle);
    const reused = await unpackRelease(line.bundle, SHA2.slice(0, 12));
    const mock = mockCloudflare({ fleet: true });
    await deployTo(staging({ secrets: stagingSecrets }), mock, reused);
    await deployTo(targetOf(TARGETS.production, env()), mock, await unpackRelease(line.bundle, SHA2.slice(0, 12)));
    const s = bindingsOf(mock.state, "erga-staging"), p = bindingsOf(mock.state, "erga");
    expect([s.DEPLOY_TARGET.text, p.DEPLOY_TARGET.text]).toEqual(["staging", "production"]);
    expect([s.SNAPSHOT_IMPORT.text, p.SNAPSHOT_IMPORT.text]).toEqual(["1", ""]);
    expect([s.PAGES_DOMAIN.text, p.PAGES_DOMAIN.text]).toEqual(["erga-pages-staging.dev", "erga-pages.dev"]);
    expect(p.DB.database_id).toBe(PROD_DB);
    expect(s.DB.database_id).not.toBe(PROD_DB);
    expect(s.GITHUB_CLIENT_ID.text).toBe(TARGETS.staging.vars.GITHUB_CLIENT_ID);
    expect(p.GITHUB_CLIENT_ID.text).toBe(TARGETS.production.vars.GITHUB_CLIENT_ID);
    expect(mock.state.secrets["erga-staging"].SESSION_SECRET).not.toBe(mock.state.secrets.erga.SESSION_SECRET);
    expect([s.ERGA_VERSION.text, p.ERGA_VERSION.text]).toEqual([SHA2.slice(0, 12), SHA2.slice(0, 12)]);
    expect(mock.state.domains.filter((d) => d.service == "erga-staging").map((d) => d.hostname)).toEqual(["staging.erga.dev"]);
  });

  test("kept in a Durable Object's storage in parts, the newest CACHE_KEEP only; a release with a part missing is a miss", async () => {
    const m = new Map<string, unknown>();
    const store = storageStore({
      get: (async (k: string | string[]) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k))) as never,
      put: async (e: Record<string, unknown>) => { for (const [k, v] of Object.entries(e)) m.set(k, v); },
      delete: async (ks: string[]) => ks.filter((k) => m.delete(k)).length,
    });
    const big = "x".repeat(CHUNK * 2 + 10);
    await store.put("a", big, { at: 1, branch: "staging" });
    expect([...m.keys()].filter((k) => k.startsWith("release:a:"))).toHaveLength(3);
    expect(await store.get("a")).toEqual({ line: big, at: 1, branch: "staging" });
    expect(await store.get("b")).toBeNull();
    for (let i = 0; i < CACHE_KEEP; i++) await store.put(`k${i}`, `line ${i}`, { at: 2 + i });
    expect(await store.get("a")).toBeNull();
    expect([...m.keys()].some((k) => k.startsWith("release:a"))).toBe(false);
    expect(await store.get("k0")).toMatchObject({ line: "line 0" });
    m.delete("release:k1:0");
    expect(await store.get("k1")).toBeNull();
  });

  test("the Bun in the cache's key is the image's, and the builder knows its own version", () => {
    const docker = readFileSync(join(ROOT, "control/builder/Dockerfile"), "utf8").match(/^FROM oven\/bun:([\d.]+)/m)?.[1];
    const worker = readFileSync(join(ROOT, "control/builder/worker.ts"), "utf8").match(/BUILDER_BUN = "([\d.]+)"/)?.[1];
    expect(worker).toBe(docker!);
    expect(readFileSync(join(ROOT, "control/wrangler.jsonc"), "utf8")).toContain('"version_metadata": { "binding": "CF_VERSION_METADATA" }');
  });
});

describe("the builder fetches only the commit", () => {
  const sh = (cwd: string, ...cmd: string[]) => {
    const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.exitCode != 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };

  test("depth 1: by its id, else the branch's head; the branch's history only when the commit is further back", async () => {
    const { buildCommit, spawnRunner } = await import("../control/builder/build");
    const tmp = mkdtempSync(join(tmpdir(), "erga-fetch-"));
    try {
      const repo = join(tmp, "repo");
      sh(tmp, "git", "init", "-q", "-b", "staging", repo);
      const commits: string[] = [];
      for (const n of [1, 2, 3]) { writeFileSync(join(repo, "f.txt"), `${n}\n`); sh(repo, "git", "add", "."); sh(repo, "git", "commit", "-qm", `c${n}`); commits.push(sh(repo, "git", "rev-parse", "HEAD")); }
      const url = `file://${repo}`;
      const build = async (commit: string, o: { byId?: boolean } = {}) => {
        const dir = join(tmp, `w-${commit.slice(0, 7)}-${o.byId === false ? "branch" : "id"}`), cmds: string[] = [], log: string[] = [];
        // Real git (a server that won't fetch by id refuses it here); the build's other steps are stubbed.
        const run = async (cmd: string[], x: Parameters<typeof spawnRunner>[1]) => {
          cmds.push(cmd.join(" "));
          if (cmd[0] == "git") {
            if (o.byId === false && cmd[1] == "fetch" && cmd.at(-1) == commit) throw new Error("not our ref");
            return spawnRunner(cmd, x);
          }
          if (cmd.join(" ") == "bun run release") { mkdirSync(join(dir, ".build/release"), { recursive: true }); writeFileSync(join(dir, ".build/release/release.json"), "{}"); }
        };
        await buildCommit({ source: { cloneUrl: url }, commit, branch: "staging", dir, log: (l) => log.push(l), run });
        return { dir, cmds, log, depth: Number(sh(dir, "git", "rev-list", "--count", "HEAD")), head: sh(dir, "git", "rev-parse", "HEAD") };
      };
      // The head, by its id: one commit of history.
      const head = await build(commits[2]);
      expect(head.head).toBe(commits[2]);
      expect(head.depth).toBe(1);
      expect(head.cmds.filter((c) => c.startsWith("git fetch"))).toEqual([`git fetch -q --no-tags --depth 1 ${url} ${commits[2]}`]);
      expect(sh(head.dir, "git", "rev-parse", "--is-shallow-repository")).toBe("true");
      expect(head.cmds.slice(-3)).toEqual(["bun install --frozen-lockfile", "bun run build", "bun run release"]);
      // A server that won't fetch by id: the branch's head, depth 1.
      const byBranch = await build(commits[2], { byId: false });
      expect(byBranch.head).toBe(commits[2]);
      expect(byBranch.depth).toBe(1);
      expect(byBranch.log).toContain("the source doesn't serve a commit by its id: fetching staging's head");
      // The branch moved on since: its history, and the commit checked out.
      const older = await build(commits[0], { byId: false });
      expect(older.head).toBe(commits[0]);
      expect(older.log).toContain(`staging has moved on from ${commits[0].slice(0, 12)}: fetching its history`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
