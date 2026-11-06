// Who may call a page's model (server/migrations/0360_page_llm_who.sql): every document keeps what it had. Signed-in
// viewers, but the homepage, whose model took guests already; a new document starts with signed-in viewers.

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { PageLlm } from "../server/directory/index.ts";
import { memory } from "./helpers/memory-sql.ts";

const doc = (db: Database, id: string, owner: string, slug: string) =>
  db.query("INSERT INTO documents (id, owner, slug, title, created, page_llm) VALUES (?1, ?2, ?3, ?3, 0, 1)").run(id, owner, slug);

test("the migration: the homepage keeps all viewers; every other document, signed-in viewers; a new one, signed-in", async () => {
  const sql = memory({
    at: "0360",
    run: (db) => {
      doc(db, "home0001", "-home", "home");
      doc(db, "land0001", "ada", "landing");
      doc(db, "open0001", "ada", "open");
      db.query("INSERT INTO permissions (doc_id, login, role, granted) VALUES ('open0001', '*', 'viewer', 0)").run();
    },
  });
  const llm = new PageLlm(sql);
  expect((await llm.setting("home0001")).who).toBe("all");
  expect((await llm.setting("open0001")).who).toBe("signed_in");
  expect((await llm.setting("land0001")).who).toBe("signed_in");
  doc(sql.db, "new00001", "ada", "new");
  expect((await llm.setting("new00001")).who).toBe("signed_in");

  // A homepage the landing_document setting names (not yet the project): all viewers.
  const named = memory({
    at: "0360",
    run: (db) => {
      doc(db, "land0001", "ada", "landing");
      db.query("INSERT INTO server_config (key, value, updated) VALUES ('landing_document', ?1, 0)").run(JSON.stringify("land0001"));
    },
  });
  expect((await new PageLlm(named).setting("land0001")).who).toBe("all");
});
