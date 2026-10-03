// Agent tokens (tokens.ts) on an in-memory SQLite database, with the same
// migrations D1 gets: minting, verifying, revoking, and an agent asking for
// one from the command line.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import type { Param, Sql } from "../directory";
import { normalCode, Tokens } from "../tokens";

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;

function fresh(): { tokens: Tokens; db: Database } {
  const db = new Database(":memory:", { strict: true });
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  const sql: Sql = {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
  return { tokens: new Tokens(sql, "test secret"), db };
}

test("a token stands for its person until it's revoked", async () => {
  const { tokens, db } = fresh();
  const { token, info } = await tokens.mint({ login: "Ada", name: "Ada" }, "  Claude   Code ");
  expect(token.startsWith("erga_")).toBe(true);
  expect(info.login).toBe("ada");
  expect(info.label).toBe("Claude Code");
  // Only its hash is kept.
  expect(JSON.stringify(db.query("SELECT * FROM agent_tokens").all()).includes(token)).toBe(false);
  const seen = await tokens.verify(token);
  expect(seen?.id).toBe(info.id);
  expect(seen?.lastUsed).not.toBeNull();
  expect(await tokens.verify(token + "x")).toBeNull();
  expect(await tokens.verify("nope")).toBeNull();
  const other = await tokens.mint({ login: "bo", name: "Bo" }, "");
  expect(other.info.label).toBe("Agent");
  expect((await tokens.list("ADA")).map((t) => t.id)).toEqual([info.id]);
  // Only its own person can revoke it.
  expect(await tokens.revoke("bo", info.id)).toBe(false);
  expect(await tokens.revoke("ada", info.id)).toBe(true);
  expect(await tokens.verify(token)).toBeNull();
  expect(await tokens.verify(other.token)).not.toBeNull();
});

test("the share button's token is shown again until it's rotated", async () => {
  const { tokens } = fresh();
  const first = await tokens.share({ login: "ada", name: "Ada" }, false);
  expect(first.info.kind).toBe("share");
  expect((await tokens.share({ login: "ada", name: "Ada" }, false)).token).toBe(first.token);
  const next = await tokens.share({ login: "ada", name: "Ada" }, true);
  expect(next.token).not.toBe(first.token);
  expect(await tokens.verify(first.token)).toBeNull();
  expect((await tokens.verify(next.token))?.kind).toBe("share");
  expect((await tokens.list("ada")).length).toBe(1);
  // A test person's token remembers who minted their test token.
  const t = await tokens.share({ login: "test-bo", name: "Bo", testBy: "Koomen" }, false);
  expect((await tokens.verify(t.token))?.testBy).toBe("koomen");
  expect((await tokens.verify(next.token))?.testBy).toBeNull();
});

test("an agent asks for a token, the person approves, the agent collects it once", async () => {
  const { tokens } = fresh();
  const req = await tokens.request("Claude Code on my laptop");
  expect(req.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
  expect(await tokens.collect(req.code)).toEqual({ status: "pending" });
  expect((await tokens.pending(req.userCode.toLowerCase().replace("-", " ")))?.label).toBe("Claude Code on my laptop");
  const approved = await tokens.approve(req.userCode, { login: "ada", name: "Ada" });
  expect(approved?.label).toBe("Claude Code on my laptop");
  expect(await tokens.pending(req.userCode)).toBeNull();
  expect(await tokens.approve(req.userCode, { login: "bo", name: "Bo" })).toBeNull();
  const got = await tokens.collect(req.code);
  expect(got.status).toBe("ready");
  if (got.status != "ready") return;
  expect((await tokens.verify(got.token))?.login).toBe("ada");
  expect(await tokens.collect(req.code)).toEqual({ status: "gone" });
  expect(await tokens.collect("ergareq_unknown")).toEqual({ status: "gone" });
  expect(normalCode("bcdfghjk")).toBe("BCDF-GHJK");
});
