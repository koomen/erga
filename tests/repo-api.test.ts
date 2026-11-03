// Erga's repository as a read-only JSON API (control/source/public-api.ts): the summary and the tree for anyone while
// public_source is on, a 404 for all but admins while it's off, no method that writes, and the staging guard's
// exemption. Real git, in front of pretend Artifacts (tests/helpers/source-fixture.ts).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localToken } from "../dev/git-server.ts";
import { repoApi, type SourceService } from "../control/source/index.ts";
import { adminsOnlyGate } from "../server/identity/admins-only.ts";
import { respond, runOn } from "../server/http.ts";
import type { Platform } from "../server/platform";
import { TARGETS } from "../deploy/targets";
import { must, startFixture, type Fixture } from "./helpers/source-fixture.ts";

setDefaultTimeout(30_000);

const APP = "https://erga.test";
let fx: Fixture,
  base: Platform,
  mainHead = "",
  reads = 0;
const settings = { public_source: true };

beforeAll(async () => {
  fx = startFixture();
  const d = mkdtempSync(join(tmpdir(), "erga-repo-api-"));
  await must(d, "init", "-q", "-b", "main");
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "README.md"), "# Erga\n\nHow Erga is built.\n");
  writeFileSync(join(d, "src/main.ts"), "export const a = 1;\n");
  writeFileSync(join(d, "logo.png"), new Uint8Array([137, 80, 78, 71, 0, 0, 1, 2]));
  await must(d, "add", ".");
  await must(d, "commit", "-qm", "First commit");
  await must(d, "push", "-q", fx.artifacts, "main:main");
  mainHead = await must(d, "rev-parse", "main");
  writeFileSync(join(d, "NEXT.md"), "Only on staging.\n");
  await must(d, "add", ".");
  await must(d, "commit", "-qm", "A change for staging");
  await must(d, "push", "-q", fx.artifacts, "main:staging", "main:wip-feature");

  const source = {
    object: {
      branches: async () => fx.repo.branches(),
      read: (_: string, q: never) => {
        reads++;
        return fx.repo.read(q).catch((e: Error) => ({ error: e.message }));
      },
    },
    remote: async () => ({
      url: `${fx.url}/__artifacts/git/erga/erga.git`,
      headers: { Authorization: `Bearer ${localToken("test-secret", "erga/erga", "read")}` },
      token: "t",
      expiresAt: "",
    }),
  } as unknown as SourceService;
  base = {
    source,
    sessionOf: async (r: Request) =>
      r.headers.get("cookie") == "admin" ? { login: "ada" } : r.headers.get("cookie") == "bo" ? { login: "bo" } : null,
    directory: {
      config: { get: async (k: keyof typeof settings) => settings[k] },
      users: { isAdmin: async (w: { login: string }) => w.login == "ada" },
    },
    edge: { cache: null, background: () => {} },
  } as unknown as Platform;
});
afterAll(() => fx?.stop());

const api = (path: string, init: RequestInit = {}, p = base) => respond(repoApi, new Request(`${APP}${path}`, init), p);

describe("public_source on (the default)", () => {
  test("the summary: the clone address, main and staging with their commits, and no feature branch", async () => {
    const r = await api("/api/repo");
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await r.json();
    expect(body.clone).toBe(`${APP}/git/erga.git`);
    expect(body.branches.map((b: { name: string }) => b.name).sort()).toEqual(["main", "staging"]);
    const main = body.branches.find((b: { name: string }) => b.name == "main");
    expect(main.commit).toBe(mainHead);
    expect(main.commits[0]).toEqual({ sha: mainHead, subject: "First commit", author: expect.any(String), at: expect.any(Number) });
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
