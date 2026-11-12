-- erga: destructive
-- The people table's check on `provider` let in 'github' and 'google' only. A person now waits for any provider of
-- the server's sign-in (the proxy in front too: shared/sign-in.ts; a server's first admin is such a person), and
-- SQLite changes a check only when the table is made again. The Worker before this one runs on the new table: its
-- columns, its ids and its index are the same.
CREATE TABLE people_any_provider (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  subject TEXT,
  handle TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'write', 'read')),
  created INTEGER NOT NULL,
  added_by TEXT,
  added_via TEXT,
  UNIQUE (provider, handle)
);
INSERT INTO people_any_provider (id, provider, subject, handle, role, created, added_by, added_via)
  SELECT id, provider, subject, handle, role, created, added_by, added_via FROM people;
DROP TABLE people;
ALTER TABLE people_any_provider RENAME TO people;
CREATE INDEX IF NOT EXISTS people_subject ON people (provider, subject);
