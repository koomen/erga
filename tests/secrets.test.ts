// The fixes from the audit of how secrets are stored and handled (docs/secrets.md): each test
// stands for one way a secret could leak or be used where it shouldn't.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Directory, type Param, type Sql } from "../directory";
import { Tokens } from "../tokens";

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;

function memory(): Sql {
  const db = new Database(":memory:", { strict: true });
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  return {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
}

test("an agent token works only on the server whose secret made it, not on a copy of its database (staging's)", async () => {
  const sql = memory();
  const dir = new Directory(sql);
  const production = new Tokens(sql, "production-secret-".repeat(3), dir), staging = new Tokens(sql, "staging-secret-".repeat(3), dir);
  const { token } = await production.mint({ login: "ada", name: "Ada" }, "Claude Code", { scope: "documents" });
  expect((await production.verify(token))?.login).toBe("ada");
  // Staging holds the same rows (its database is a copy of production's), but not production's secret.
  expect(await staging.verify(token)).toBeNull();
  // Its own tokens still work there.
  const own = await staging.mint({ login: "ada", name: "Ada" }, "Claude Code", { scope: "documents" });
  expect((await staging.verify(own.token))?.login).toBe("ada");
  expect(await production.verify(own.token)).toBeNull();
});

test("text from a factory VM keeps no token: the board and outside agents with admin tokens read it", async () => {
  const { hideTokens } = await import("../factory/prompt");
  const claude = "sk-ant-oat01-" + "Ab3_-x".repeat(12), task = "fct.12.1790000000." + "0f".repeat(32), git = "fgt.eyJzY29wZSI6InRhc2sifQ." + "a1".repeat(32);
  const said = hideTokens(`debug: ${claude} then ${task}, ${git}; erga_${"k".repeat(43)} erga_admin_${"q".repeat(40)} erga_factory_0123_${"z".repeat(32)}`);
  for (const secret of [claude, task, git, "k".repeat(43), "q".repeat(40), "z".repeat(32)]) expect(said).not.toContain(secret);
  expect(said).toContain("[a Claude token]");
  // Ordinary text, and the names of things, stay.
  const plain = "Run `claude setup-token` and paste the token it prints (sk-ant-…). See erga_session and fct.ts.";
  expect(hideTokens(plain)).toBe(plain);
});

test("a build's failed fetch never puts the source token in its error, or the deploy log", async () => {
  const { buildCommit } = await import("../deploy/builder/build");
  const token = "art_" + "s3cr3t".repeat(6), lines: string[] = [];
  const dir = `${process.env.TMPDIR ?? "/tmp"}/erga-secrets-${process.pid}`;
  // Nothing listens on port 9: git fails at once.
  const err = await buildCommit({ source: { cloneUrl: "http://127.0.0.1:9/erga.git", token }, commit: "0123456789abcdef0123456789abcdef01234567", branch: "staging", dir, log: (l) => lines.push(l) }).catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  const said = `${(err as Error).message}\n${lines.join("\n")}`;
  expect(said).toContain("git fetch");
  expect(said).not.toContain(token);
  expect(said).not.toContain(btoa(`x:${token}`));
  (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
});

test("a document's pages token is checked whole (its MAC compared in constant time): a changed one opens nothing", async () => {
  const { pagesToken, readPagesToken } = await import("../front");
  const token = await pagesToken("pages-secret", "ada", "abcd1234", "https://erga.dev");
  expect(await readPagesToken("pages-secret", token, "ada", "abcd1234")).toBe("https://erga.dev");
  const flip = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  for (const bad of [flip, token.slice(0, -1), `${token}x`, token.split(".")[0] + "."]) expect(await readPagesToken("pages-secret", bad, "ada", "abcd1234")).toBeNull();
  expect(await readPagesToken("another-secret", token, "ada", "abcd1234")).toBeNull();
});
