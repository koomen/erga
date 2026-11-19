-- Agent grants (server/identity/grants.ts): a person lets an agent act for them. The gate signs the agent's tokens
-- (gate/core.ts: each names the person and a grant's id); this row is what the server checks on every request of the
-- agent, so a revoke works at once.
--
-- `provider`, `subject`: the person as the gate names them in the token. `login`: their account. `scope`: 'document'
-- (the one document `doc_id`), 'documents' or 'admin'. `expires`, `revoked`, `created`, `last_used`: milliseconds
-- since the epoch; `revoked` NULL: not revoked.
--
-- The tables agent_tokens and token_requests stay, unused: the tokens they held work no more.
CREATE TABLE agent_grants (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  label TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('document', 'documents', 'admin')),
  doc_id TEXT,
  expires INTEGER NOT NULL,
  created INTEGER NOT NULL,
  last_used INTEGER,
  revoked INTEGER
);
CREATE INDEX agent_grants_login ON agent_grants (login, created);
