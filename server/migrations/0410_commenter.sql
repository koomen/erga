-- erga: destructive. It drops and renames the permissions table: SQLite cannot change a CHECK in place.
-- The commenter role (document/access.ts): a commenter reads a document like a viewer, and sees, adds and replies to its
-- comments. The table is made again with the same columns and rows, and 'commenter' in its role's CHECK. A rollback
-- runs on it (the same columns), but the old code gives a commenter no access, until the owner shares it again.

CREATE TABLE permissions_commenter (
  doc_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  granted INTEGER NOT NULL,
  granted_by TEXT,
  granted_via TEXT,
  archived INTEGER,
  PRIMARY KEY (doc_id, login)
);
INSERT INTO permissions_commenter (doc_id, login, role, granted, granted_by, granted_via, archived)
  SELECT doc_id, login, role, granted, granted_by, granted_via, archived FROM permissions;
DROP TABLE permissions;
ALTER TABLE permissions_commenter RENAME TO permissions;
CREATE INDEX permissions_by_login ON permissions (login);
