-- erga: destructive. It drops and renames the tokens' tables: SQLite cannot change a CHECK in place.
-- Ops tokens (tokens.ts, scope 'ops'): an admin's token for the CLI, which reads only the server's deploy facts
-- (GET /api/ops). The tables are made again with the same columns and rows, and 'ops' in their scope's CHECK.
-- A rollback runs on them (the same columns), but the old code reads an ops token as a 'documents' token of its
-- admin, until they revoke it.

CREATE TABLE agent_tokens_ops (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'share')),
  test_by TEXT,
  created INTEGER NOT NULL,
  last_used INTEGER,
  scope TEXT NOT NULL DEFAULT 'documents' CHECK (scope IN ('document', 'documents', 'admin', 'ops')),
  doc_id TEXT,
  expires INTEGER
);
INSERT INTO agent_tokens_ops (id, hash, login, name, label, kind, test_by, created, last_used, scope, doc_id, expires)
  SELECT id, hash, login, name, label, kind, test_by, created, last_used, scope, doc_id, expires FROM agent_tokens;
DROP TABLE agent_tokens;
ALTER TABLE agent_tokens_ops RENAME TO agent_tokens;
CREATE INDEX agent_tokens_by_login ON agent_tokens (login);

CREATE TABLE token_requests_ops (
  code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  login TEXT,
  token_id TEXT,
  scope TEXT NOT NULL DEFAULT 'documents' CHECK (scope IN ('document', 'documents', 'admin', 'ops')),
  doc_id TEXT,
  token_expires INTEGER,
  oauth_client TEXT,
  redirect_uri TEXT,
  code_challenge TEXT,
  oauth_state TEXT
);
INSERT INTO token_requests_ops (code_hash, user_code, label, created, expires, login, token_id, scope, doc_id, token_expires, oauth_client, redirect_uri, code_challenge, oauth_state)
  SELECT code_hash, user_code, label, created, expires, login, token_id, scope, doc_id, token_expires, oauth_client, redirect_uri, code_challenge, oauth_state FROM token_requests;
DROP TABLE token_requests;
ALTER TABLE token_requests_ops RENAME TO token_requests;
