// The cutover's export (server/admin/cutover.ts): admins only, one JSON line
// per document with its row, who has it, its files and, when it is fixed at
// another version, the published files.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Directory, type Param, type Sql } from "../server/directory";
import { exportDocuments, decodeFile, type ExportedDocument, type ExportLine } from "../server/admin/cutover";
import type { Platform, Session } from "../server/routes";

const MIGRATIONS = new URL("../server/migrations/", import.meta.url).pathname;
function memory(): Sql {
  const db = new Database(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + f, "utf8"));
  return {
    all: async <T>(sql: string, ...params: Param[]) => db.query(sql).all(...(params as never[])) as T[],
    run: async (sql: string, ...params: Param[]) => { db.query(sql).run(...(params as never[])); },
    batch: async (statements) => { db.transaction(() => { for (const [sql, ...params] of statements) db.query(sql).run(...(params as never[])); })(); },
  };
}

/** A platform with a directory and two documents' hosts: one published as it is typed, one fixed at an older version. */
async function setup() {
  const dir = new Directory(memory(), { admins: ["ada"] });
  const a = (await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Notes", created: 1 })).doc;
  const b = (await dir.add({ id: "bbbbbbbb", owner: "bo", title: "Plan", created: 2 })).doc;
  await dir.share({ login: "bo" }, b.id, "cy", "viewer");
  const png = new Uint8Array([137, 80, 78, 71, 0, 1, 2]);
  const hosts: Record<string, { files: Record<string, string | Uint8Array>; published?: Record<string, string | Uint8Array>; mode: "latest" | "manual" }> = {
    [a.id]: { files: { "index.html": "<h1>Notes</h1>", "logo.png": png }, mode: "latest" },
    [b.id]: { files: { "index.html": "<h1>Plan v2</h1>" }, published: { "index.html": "<h1>Plan v1</h1>" }, mode: "manual" },
  };
  const version = { id: "v1", n: 1, at: 1, by: [], description: "" };
  const sessions: Record<string, Session | null> = {
    admin: { login: "ada", name: "Ada", admin: true },
    "admin-token-no-scope": { login: "ada", name: "Ada" },
    user: { login: "bo", name: "Bo", admin: true },
  };
  const platform = {
    directory: dir,
    sessionOf: async (request: Request) => sessions[request.headers.get("x-test-session") ?? ""] ?? null,
    docs: {
      snapshot: async (doc: { id: string }, opts?: { published?: boolean }) => {
        const h = hosts[doc.id];
        if (!h) return null;
        return { index: "index.html", files: opts?.published && h.published ? h.published : h.files };
      },
      versions: async (doc: { id: string }) => (hosts[doc.id] ? { current: version, published: { mode: hosts[doc.id].mode, version }, versions: [version], total: 1, pending: null } : null),
    },
  } as unknown as Platform;
  return { dir, platform, a, b, png };
}

const ask = (platform: Platform, session: string) => exportDocuments(platform, new Request("http://erga.test/api/admin/documents/export", { headers: session ? { "x-test-session": session } : {} }));
const lines = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as ExportLine);

test("only an admin with admin power gets the export", async () => {
  const { platform } = await setup();
  expect((await ask(platform, "")).status).toBe(401);
  expect((await ask(platform, "admin-token-no-scope")).status).toBe(403);
  expect((await ask(platform, "user")).status).toBe(403);
  expect((await ask(platform, "admin")).status).toBe(200);
});

test("each document is one line: its row, who has it, its files; the published files only when they differ", async () => {
  const { platform, a, b, png } = await setup();
  const res = await ask(platform, "admin");
  expect(res.headers.get("Content-Type")).toContain("x-ndjson");
  const out = await lines(res);
  expect(out.map((l) => l.record.id)).toEqual([a.id, b.id]);
  const first = out[0] as ExportedDocument, second = out[1] as ExportedDocument;
  expect(first.record).toMatchObject({ owner: "ada", slug: "notes", title: "Notes" });
  expect(first.permissions.map((p) => [p.login, p.role])).toEqual([["ada", "owner"]]);
  expect(first.index).toBe("index.html");
  expect(first.published?.mode).toBe("latest");
  expect(Object.keys(first.files)).toEqual(["index.html", "logo.png"]);
  expect(first.files["index.html"]).toEqual({ text: "<h1>Notes</h1>" });
  expect(decodeFile(first.files["logo.png"])).toEqual(png);
  expect(first.publishedFiles).toBeUndefined();
  expect(second.published?.mode).toBe("manual");
  expect(second.publishedFiles?.["index.html"]).toEqual({ text: "<h1>Plan v1</h1>" });
  expect(second.files["index.html"]).toEqual({ text: "<h1>Plan v2</h1>" });
});

test("a document whose host was never made is reported as missing", async () => {
  const { dir, platform } = await setup();
  const c = (await dir.add({ id: "cccccccc", owner: "ada", title: "Empty", created: 3 })).doc;
  const out = await lines(await ask(platform, "admin"));
  expect(out.find((l) => l.record.id == c.id)).toMatchObject({ missing: true });
});
