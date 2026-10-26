// Erga's source for anyone (control/routes.ts, control/source/public.ts): a clone and a fetch with no
// credentials, the read-only page with no sign-in, and what stays shut: a push without an admin's token,
// the Ops page and its APIs, /install, and all of it on staging (admins only). Real git, in front of
// pretend Artifacts (tests/helpers/source-fixture.ts), through the control Worker's routes.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlRoutes, isControlPath, type Control } from "../control/routes";
import { localToken } from "../dev/git-server.ts";
import { adminsOnlyGate } from "../server/identity/admins-only.ts";
import type { Platform } from "../server/platform";
import type { SourceService } from "../control/source/index.ts";
import { git, must, startFixture, type Fixture } from "./helpers/source-fixture.ts";

setDefaultTimeout(30_000);

const APP = "https://erga.test";
let fx: Fixture, server: ReturnType<typeof Bun.serve>, origin = "", main = "";

beforeAll(async () => {
  fx = startFixture();
  const d = mkdtempSync(join(tmpdir(), "erga-public-"));
  await must(d, "init", "-q", "-b", "main");
  mkdirSync(join(d, "src/page"), { recursive: true });
  writeFileSync(join(d, "README.md"), "# Erga\n\nHow Erga is built.\n");
  writeFileSync(join(d, "src/page/main.ts"), "export const greeting = '<b>hello</b>';\n");
  writeFileSync(join(d, "logo.png"), new Uint8Array([137, 80, 78, 71, 0, 0, 1, 2]));
  await must(d, "add", "."); await must(d, "commit", "-qm", "First commit");
  await must(d, "push", "-q", fx.artifacts, "main:main");
  writeFileSync(join(d, "NEXT.md"), "Only on staging.\n");
  await must(d, "add", "."); await must(d, "commit", "-qm", "A change for staging");
  await must(d, "push", "-q", fx.artifacts, "main:staging");
  main = await must(d, "rev-parse", "main~1");

  // The repository's object, as SourceHost serves it, on the fixture's SourceRepo.
  const read = { url: `${fx.url}/__artifacts/git/erga/erga.git`, headers: { Authorization: `Bearer ${localToken("test-secret", "erga/erga", "read")}` } };
  const source = {
    object: {
      advertise: () => fx.repo.advertise(),
      branches: async () => { const b = await fx.repo.branches(); return { branches: b.branches, github: b.github, conflict: b.conflict }; },
      read: (_: string, q: never) => fx.repo.read(q).catch((e: Error) => ({ error: e.message })),
      fetch: async (r: Request) => new Response(await fx.repo.receive(new Uint8Array(await r.arrayBuffer()), JSON.parse(r.headers.get("x-erga-actor")!)) as BodyInit),
    },
    remote: async () => ({ ...read, token: "t", expiresAt: "" }),
  } as unknown as SourceService;
  const platform = {
    source,
    sessionOf: async () => null,
    tokens: { verify: async (s: string) => (s == "admin-token" ? { scope: "admin", login: "ada", name: "Ada", label: "laptop" } : s == "docs-token" ? { scope: "documents", login: "ada", name: "Ada", label: "x" } : null) },
    directory: { users: { allowed: async () => true, isAdmin: async (w: { login: string }) => w.login == "ada", actsAsAdmin: async () => true } },
  } as unknown as Platform;
  const c: Control = {
    platform, app: APP, version: "v1", deploys: {} as never, oauth: {} as never,
    layout: () => new Response("the admin layout", { headers: { "Content-Type": "text/html" } }),
  };
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => controlRoutes(r, c) });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(() => { server?.stop(true); fx?.stop(); });

const page = (path: string) => fetch(`${origin}${path}`, { headers: { accept: "text/html" }, redirect: "manual" });

describe("Git, with no credentials", () => {
  test("a clone and a fetch work", async () => {
    const d = mkdtempSync(join(tmpdir(), "erga-clone-"));
    const r = await git(d, "clone", "-q", `${origin}/git/erga.git`, "erga");
    expect(r.err).toBe("");
    expect(r.ok).toBe(true);
    expect(await must(join(d, "erga"), "rev-parse", "origin/main")).toBe(main);
    expect(await must(join(d, "erga"), "log", "-1", "--format=%s", "origin/staging")).toBe("A change for staging");
    expect((await git(join(d, "erga"), "fetch", "-q", "origin")).ok).toBe(true);
  });

  test("a push is refused without an admin's token, and lands with one", async () => {
    const d = mkdtempSync(join(tmpdir(), "erga-push-"));
    await must(d, "clone", "-q", "-b", "staging", `${origin}/git/erga.git`, "erga");
    const w = join(d, "erga");
    writeFileSync(join(w, "README.md"), "# Erga, changed\n");
    await must(w, "commit", "-qam", "A change");
    const anonymous = await git(w, "push", `${origin}/git/erga.git`, "HEAD:staging");
    expect(anonymous.ok).toBe(false);
    const refs = await fetch(`${origin}/git/erga.git/info/refs?service=git-receive-pack`);
    expect(refs.status).toBe(401);
    expect(await refs.text()).toContain("needs an admin token");
    const docs = await git(w, "push", `http://x:docs-token@127.0.0.1:${server.port}/git/erga.git`, "HEAD:staging");
    expect(docs.ok).toBe(false);
    expect(docs.err).toContain("pushing needs a token with the admin scope");
    const admin = await git(w, "push", `http://x:admin-token@127.0.0.1:${server.port}/git/erga.git`, "HEAD:staging");
    expect(admin.err).not.toContain("fatal");
    expect(admin.ok).toBe(true);
  });
});

describe("the page, with no sign-in", () => {
  test("/git: the clone command, the branches, the recent commits and main's files", async () => {
    const r = await page("/git");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(`git clone ${APP}/git/erga.git`);
    expect(html).toContain(`href="/git/tree/main" aria-current="page"`);
    expect(html).toContain(`href="/git/tree/staging"`);
    expect(html).toContain("First commit");
    expect(html).toContain(`href="/git/tree/main/README.md"`);
    expect(html).toContain(`href="/git/tree/main/src"`);
    expect(html).not.toContain("NEXT.md"); // only on staging
    for (const word of ["Merge", "Deploy", "Roll back", "mirror", "Mirror", "Redeploy", "token", "/api/", "__artifacts", "/install"]) expect(`${word}: ${html.includes(word)}`).toBe(`${word}: false`);
  });

  test("the app hands every page path to the control Worker, with or without a slash at the end", async () => {
    for (const p of ["/git", "/git/", "/git/erga.git", "/git/erga.git/", "/git/tree/main", "/git/tree/main/", "/git/tree/main/src/page/main.ts"]) expect(`${p}: ${isControlPath(p)}`).toBe(`${p}: true`);
    for (const p of ["/git/", "/git/tree/main/"]) expect(`${p}: ${(await page(p)).status}`).toBe(`${p}: 200`);
  });

  test("a browser at /git/erga.git sees it too", async () => {
    const r = await page("/git/erga.git");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(`git clone ${APP}/git/erga.git`);
  });

  test("a folder, a file (its text escaped), a binary file, staging's files, and a path that isn't there", async () => {
    expect(await (await page("/git/tree/main/src")).text()).toContain(`href="/git/tree/main/src/page"`);
    const file = await (await page("/git/tree/main/src/page/main.ts")).text();
    expect(file).toContain("export const greeting = &#39;&lt;b&gt;hello&lt;/b&gt;&#39;;");
    expect(file).not.toContain("<b>hello</b>");
    expect(await (await page("/git/tree/main/logo.png")).text()).toContain("A binary file");
    const staging = await (await page("/git/tree/staging")).text();
    expect(staging).toContain(`href="/git/tree/staging/NEXT.md"`);
    expect(staging).toContain("A change for staging");
    const missing = await page("/git/tree/main/nothing.ts");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("There&#39;s no file or folder nothing.ts.");
    expect((await page("/git/tree/main/..%2F..%2Fetc")).status).toBe(404);
  });
});

describe("what stays shut", () => {
  test("the Ops page, its APIs and /install ask for an admin", async () => {
    for (const p of ["/", "/admin/ops", "/install"]) {
      const r = await page(p);
      expect(`${p}: ${r.status}`).toBe(`${p}: 302`);
      expect(r.headers.get("location")).toStartWith("/auth/github?next=");
    }
    for (const p of ["/api/source/branches", "/api/deploys", "/api/install"]) expect(`${p}: ${(await fetch(`${origin}${p}`)).status}`).toBe(`${p}: 401`);
    const merge = await fetch(`${origin}/api/source/merge`, { method: "POST", headers: { origin } });
    expect(merge.status).toBe(401);
  });

  test("on staging (admins only), the page and Git need an admin too", async () => {
    const staging = { adminsOnly: true, sessionOf: async () => null, pagesDomain: () => "", directory: { users: {} } } as unknown as Platform;
    for (const p of ["/git", "/git/erga.git", "/git/tree/main/README.md", "/git/erga.git/info/refs?service=git-upload-pack"]) {
      const url = new URL(`https://staging.erga.test${p}`);
      const refused = await adminsOnlyGate(new Request(url, { headers: { accept: "text/html" } }), staging, url);
      expect(`${p}: ${refused?.status}`).toMatch(new RegExp(`^${p.replace(/[?]/g, "\\?")}: 40[13]$`));
    }
  });
});
