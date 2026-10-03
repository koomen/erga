-- The document directory (directory.ts): every document's address, title and
-- who may do what with it. D1 on erga.dev (applied with `cf d1 migrations
-- apply`), bun:sqlite on the local host (directory-sqlite.ts applies the same
-- files, in order, at startup). A document's content and live room stay in
-- its own host (a DocHost Durable Object, or a folder in the data directory).

-- One row per document. `slug` is its pretty address, /<owner>/<slug>, and
-- follows the title until someone sets it (slug_set); the title follows the
-- page's first heading until someone sets it (title_set). `do_name` is the
-- name of its Durable Object: the id alone for new documents, "<owner>/<id>"
-- for those made before the directory. Times are milliseconds since the epoch;
-- `modified` is null until the first edit, and `expires` null once there's one.
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  title_set INTEGER NOT NULL DEFAULT 0,
  slug_set INTEGER NOT NULL DEFAULT 0,
  do_name TEXT NOT NULL,
  created INTEGER NOT NULL,
  modified INTEGER,
  expires INTEGER,
  test INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner, slug)
);

-- Who may do what with a document. Only the owner's row is written for now;
-- sharing will add editors and viewers.
CREATE TABLE members (
  doc_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  user TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (doc_id, user)
);
CREATE INDEX members_by_user ON members (user);

-- Addresses a document had before it was renamed, so old links redirect to
-- the current one. A document that takes one of these slugs takes it over.
CREATE TABLE slug_history (
  owner TEXT NOT NULL,
  slug TEXT NOT NULL,
  doc_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  PRIMARY KEY (owner, slug)
);

-- Whose per-person lists (the DocList Durable Objects that came before this
-- directory) have been copied in, so that happens once for each person.
CREATE TABLE backfills (
  owner TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
