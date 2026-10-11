-- Erga's server database, in D1 (applied by migrate.ts on erga.dev, before
-- each deploy; by the dev server locally, worker/index.ts): who may sign in
-- and who's an admin (users), the server's settings (server_config), and
-- every document's address, title and who may do what with it (documents,
-- permissions, slug_history). A document's content and live room stay in its
-- own Durable Object (DocHost), named by the document's id.
--
-- This replaces everything before it (the first directory, its backfill of
-- the per-person lists): nothing from then is kept. Times are milliseconds
-- since the epoch; logins are GitHub logins, lowercase.

DROP TABLE IF EXISTS backfills;
DROP TABLE IF EXISTS slug_history;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS server_config;
DROP TABLE IF EXISTS users;

-- Who may sign in: a GitHub login with a row here may, anyone else may not
-- (the logins in the ADMINS binding always may, and get their row the first
-- time they sign in). `name` is the display name GitHub gave at the last
-- sign-in (the login until then). `role` is their role on the server:
-- 'admin' may see and change the server's settings and its users. `added_by`
-- is the admin who added them (null when they were added by being in ADMINS).
CREATE TABLE users (
  login TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created INTEGER NOT NULL,
  added_by TEXT,
  last_seen INTEGER
);

-- The server's settings: a JSON value for each key that's been set (one not
-- here has its default, config.ts), who set it and when.
CREATE TABLE server_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated INTEGER NOT NULL,
  updated_by TEXT
);

-- One row per document. `slug` is its pretty address, /<owner>/<slug>, and
-- follows the title until someone sets it (slug_set); the title follows the
-- page's first heading until someone sets it (title_set). `modified` is null
-- until the first edit, and `expires` null once there's one.
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  title_set INTEGER NOT NULL DEFAULT 0,
  slug_set INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  modified INTEGER,
  expires INTEGER,
  test INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner, slug)
);

-- Who may do what with a document: its owner (one, who made it), editors
-- (open, edit, rename) and viewers (open). A login of '*' is anyone signed
-- in who has the link. Nobody without a row (or '*') may open it.
CREATE TABLE permissions (
  doc_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  granted INTEGER NOT NULL,
  granted_by TEXT,
  PRIMARY KEY (doc_id, login)
);
CREATE INDEX permissions_by_login ON permissions (login);

-- Addresses a document had before it was renamed, so old links redirect to
-- the current one. A document that takes one of these slugs takes it over.
CREATE TABLE slug_history (
  owner TEXT NOT NULL,
  slug TEXT NOT NULL,
  doc_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  PRIMARY KEY (owner, slug)
);
