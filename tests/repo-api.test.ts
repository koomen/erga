// Erga's repository as a read-only JSON API (server/repo-api.ts): the summary and the tree for anyone while
// public_source is on, a 404 for all but admins while it's off, no method that writes, and the staging guard's
// exemption. The repository is a stand-in (Repository); the last tests read GitHub's answers (server/repo-github.ts).

import { describe, expect, test } from "bun:test";
import { repoApi, type Repository } from "../server/repo-api.ts";
import { githubRepository } from "../server/repo-github.ts";
import { adminsOnlyGate } from "../server/identity/admins-only.ts";
import { respond, runOn } from "../server/http.ts";
import type { Platform } from "../server/platform";
import { TARGETS } from "../deploy/targets";

const APP = "https://erga.test";
const mainHead = "a".repeat(40),
  stagingHead = "b".repeat(40);
let reads = 0;
const settings = { public_source: true };

/** The files of each branch: a path's text, or null for a binary file. */
const FILES: Record<string, Record<string, string | null>> = {
  main: { "README.md": "# Erga\n\nHow Erga is built.\n", "src/main.ts": "export const a = 1;\n", "logo.png": null },
};
FILES.staging = { ...FILES.main, "NEXT.md": "Only on staging.\n" };
const HEADS: Record<string, string> = { main: mainHead, staging: stagingHead };

const repo: Repository = {
  clone: "https://github.com/koomen/erga.git",
  branches: async () => ({
    branches: [
      { name: "main", commit: mainHead, commits: [{ sha: mainHead, subject: "First commit", author: "Ada", at: 1_700_000_000_000 }] },
      {
        name: "staging",
        commit: stagingHead,
        commits: [{ sha: stagingHead, subject: "A change for staging", author: "Ada", at: 1_700_000_100_000 }],
      },
      { name: "wip-feature", commit: stagingHead, commits: [] },
    ],
    tags: [],
  }),
  read: async (q) => {
    reads++;
    const files = FILES[q.ref];
    if (!files) return { error: `There's no branch ${q.ref}.` };
    const path = q.path.replace(/^\/+|\/+$/g, "");
    if (path.includes("..")) return { error: "A path can't go up (..)." };
    if (path in files) {
      const text = files[path];
      return { commit: HEADS[q.ref], view: { kind: "file", path, size: text == null ? 8 : new TextEncoder().encode(text).length, text } };
    }
    const prefix = path ? `${path}/` : "";
    const under = Object.keys(files).filter((p) => p.startsWith(prefix));
    if (!under.length) return { error: `There's no file or folder ${path}.` };
    const folders = [
      ...new Set(
        under
          .map((p) => p.slice(prefix.length))
          .filter((r) => r.includes("/"))
          .map((r) => r.split("/")[0])
      ),
    ].sort();
    const own = under.filter((p) => !p.slice(prefix.length).includes("/")).sort();
    return {
      commit: HEADS[q.ref],
      view: {
        kind: "folder",
        path,
        entries: [
          ...folders.map((name) => ({ name, folder: true, size: 0 })),
          ...own.map((p) => ({
            name: p.slice(prefix.length),
            folder: false,
            size: new TextEncoder().encode(files[p] ?? "12345678").length,
          })),
        ],
      },
    };
  },
};

const base = {
  repo,
  sessionOf: async (r: Request) =>
    r.headers.get("cookie") == "admin" ? { login: "ada" } : r.headers.get("cookie") == "bo" ? { login: "bo" } : null,
  directory: {
    config: { get: async (k: keyof typeof settings) => settings[k] },
    users: { isAdmin: async (w: { login: string }) => w.login == "ada" },
  },
  edge: { cache: null, background: () => {} },
} as unknown as Platform;

const api = (path: string, init: RequestInit = {}, p = base) => respond(repoApi, new Request(`${APP}${path}`, init), p);

describe("public_source on (the default)", () => {
  test("the summary: the clone address, main and staging with their commits, and no feature branch", async () => {
    const r = await api("/api/repo");
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await r.json();
    expect(body.clone).toBe("https://github.com/koomen/erga.git");
    expect(body.branches.map((b: { name: string }) => b.name).sort()).toEqual(["main", "staging"]);
    const main = body.branches.find((b: { name: string }) => b.name == "main");
    expect(main.commit).toBe(mainHead);
    expect(main.commits[0]).toEqual({ sha: mainHead, subject: "First commit", author: "Ada", at: 1_700_000_000_000 });
    expect(body.updated).toBe(main.updated);
    expect(JSON.stringify(body)).not.toContain("wip-feature");
    expect(JSON.stringify(body)).not.toContain("@"); // no author's email
  });

  test("a folder, a file, a binary file, staging's files, and what isn't there", async () => {
    const root = await (await api("/api/repo/tree/main")).json();
    expect(root).toMatchObject({ ref: "main", commit: mainHead, path: "", kind: "folder" });
    expect(root.entries).toEqual([
      { name: "src", kind: "folder" },
      { name: "README.md", kind: "file", size: 27 },
      { name: "logo.png", kind: "file", size: 8 },
    ]);
    expect(await (await api("/api/repo/tree/main/README.md")).json()).toMatchObject({
      kind: "file",
      path: "README.md",
      text: "# Erga\n\nHow Erga is built.\n",
    });
    expect(await (await api("/api/repo/tree/main/logo.png")).json()).toMatchObject({ kind: "file", text: null, size: 8 });
    const staging = await (await api("/api/repo/tree/staging/")).json();
    expect(staging.entries.map((e: { name: string }) => e.name)).toContain("NEXT.md");
    for (const p of ["/api/repo/tree/main/nothing.ts", "/api/repo/tree/main/..%2F..%2Fetc", "/api/repo/tree/wip-feature", "/api/repo/log"])
      expect(`${p}: ${(await api(p)).status}`).toBe(`${p}: 404`);
  });

  test("it only reads: a write is refused, and never reaches the repository", async () => {
    const before = reads;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await api("/api/repo/tree/main/README.md", { method, body: "x" });
      expect(`${method}: ${r.status}`).toBe(`${method}: 405`);
    }
    expect(reads).toBe(before);
  });

  test("a second read of the same address comes from the edge's cache", async () => {
    const kept = new Map<string, Response>();
    const cached = {
      ...base,
      edge: {
        cache: {
          match: async (k: string) => kept.get(k)?.clone(),
          put: async (k: string, r: Response) => void kept.set(k, r),
          delete: async () => true,
        },
        background: (w: Promise<unknown>) => void w,
      },
    } as unknown as Platform;
    await api("/api/repo/tree/main/src", {}, cached);
    const before = reads;
    const r = await api("/api/repo/tree/main/src", {}, cached);
    expect(r.status).toBe(200);
    expect((await r.json()).entries).toEqual([{ name: "main.ts", kind: "file", size: 20 }]);
    expect(reads).toBe(before);
  });
});

describe("public_source off", () => {
  test("anyone but an admin gets a 404; an admin reads, with no cache and no CORS", async () => {
    settings.public_source = false;
    try {
      for (const cookie of ["", "bo"]) {
        const r = await api("/api/repo/tree/main/README.md", { headers: { cookie } });
        expect(`${cookie}: ${r.status}`).toBe(`${cookie}: 404`);
        expect(r.headers.get("access-control-allow-origin")).toBeNull();
      }
      const admin = await api("/api/repo", { headers: { cookie: "admin" } });
      expect(admin.status).toBe(200);
      expect(admin.headers.get("cache-control")).toBe("private, no-store");
      expect(admin.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      settings.public_source = true;
    }
  });
});

test("on staging (admins only), the guard lets the API's reads through, and only its reads", async () => {
  const staging = {
    adminsOnly: true,
    sessionOf: async () => null,
    pagesDomain: () => "",
    directory: { users: {} },
    deploy: { targets: TARGETS },
  } as unknown as Platform;
  const gate = (path: string, method = "GET") =>
    runOn(adminsOnlyGate, new Request(`https://staging.erga.test${path}`, { method }), staging);
  expect(await gate("/api/repo")).toBeNull();
  expect(await gate("/api/repo/tree/main/README.md")).toBeNull();
  expect((await gate("/api/repo", "POST"))?.status).toBe(403);
});

test("a server with no repository (a fork's, local development) says so", async () => {
  const r = await respond(repoApi, new Request(`${APP}/api/repo`), { ...base, repo: undefined } as unknown as Platform);
  expect(r.status).toBe(404);
  expect((await r.json()).error).toBe("This server has no repository.");
});

describe("the repository on GitHub (githubRepository)", () => {
  const asked: { url: string; auth: string | null }[] = [];
  const commit = (sha: string, message: string, date: string) => ({
    sha,
    commit: { message, author: { name: "Ada", date }, committer: { date } },
  });
  const ANSWERS: Record<string, unknown> = {
    "/commits?sha=main&per_page=30": [commit(mainHead, "First commit\n\nThe body.", "2024-01-01T00:00:00Z")],
    "/commits?sha=staging&per_page=30": [commit(stagingHead, "A change", "2024-01-02T00:00:00Z")],
    "/tags?per_page=10": [{ name: "v0.1.0", commit: { sha: mainHead } }],
    "/commits/main": { sha: mainHead },
    "/contents/?ref=main": [
      { type: "dir", name: "src", path: "src", size: 0 },
      { type: "file", name: "README.md", path: "README.md", size: 7 },
    ],
    "/contents/README.md?ref=main": {
      type: "file",
      name: "README.md",
      path: "README.md",
      size: 7,
      encoding: "base64",
      content: btoa("# Erga\n"),
    },
    "/contents/logo.png?ref=main": {
      type: "file",
      name: "logo.png",
      path: "logo.png",
      size: 3,
      encoding: "base64",
      content: btoa("\x89\x00P"),
    },
  };
  const github = async (url: string, init?: RequestInit) => {
    asked.push({ url, auth: new Headers(init?.headers).get("authorization") });
    const path = url.replace("https://api.github.com/repos/koomen/erga", "");
    return path in ANSWERS ? Response.json(ANSWERS[path]) : new Response("{}", { status: 404 });
  };
  const gh = githubRepository("koomen/erga", { clientId: "id", secret: "s" }, github);

  test("the branches, their commits' first lines and the tags, with the sign-in app's credentials", async () => {
    const got = await gh.branches();
    expect(got.branches.map((b) => [b.name, b.commit])).toEqual([
      ["main", mainHead],
      ["staging", stagingHead],
    ]);
    expect(got.branches[0].commits[0]).toEqual({
      sha: mainHead,
      subject: "First commit",
      author: "Ada",
      at: Date.parse("2024-01-01T00:00:00Z"),
    });
    expect(got.tags).toEqual([{ name: "v0.1.0", commit: mainHead, at: 0 }]);
    expect(asked[0].auth).toBe(`Basic ${btoa("id:s")}`);
    expect(gh.clone).toBe("https://github.com/koomen/erga.git");
  });

  test("a folder, a text file, a binary file, and what isn't there", async () => {
    expect(await gh.read({ ref: "main", path: "" })).toEqual({
      commit: mainHead,
      view: {
        kind: "folder",
        path: "",
        entries: [
          { name: "src", folder: true, size: 0 },
          { name: "README.md", folder: false, size: 7 },
        ],
      },
    });
    expect(await gh.read({ ref: "main", path: "README.md" })).toEqual({
      commit: mainHead,
      view: { kind: "file", path: "README.md", size: 7, text: "# Erga\n" },
    });
    expect(await gh.read({ ref: "main", path: "logo.png" })).toMatchObject({ view: { kind: "file", text: null } });
    expect(await gh.read({ ref: "main", path: "nothing.ts" })).toEqual({ error: "There's no file or folder nothing.ts." });
    expect(await gh.read({ ref: "main", path: "../x" })).toEqual({ error: "A path can't go up (..)." });
  });
});
