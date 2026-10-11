-- Scoped tokens (tokens.ts; README, Tokens): an agent token is the only
-- credential for agents, scripts, the API, MCP and Git, and each one has a
-- scope and, if its maker chose one, an expiry. Admins' SSH keys, their
-- unlocks and admin tokens are gone.
--
-- Every token made before this had no scope, so they all go: their people
-- make new ones at /tokens.

DELETE FROM agent_tokens;
DELETE FROM token_requests;

-- `scope`: 'document' (the one document `doc_id`, with the person's rights
-- there, and nothing else), 'documents' (everything the person can do with
-- documents, never admin power) or 'admin' (everything the person can do,
-- while they're an admin). `expires`: milliseconds since the epoch, or NULL
-- for a token that lasts until it's revoked. A request carries the scope,
-- document and expiry the agent asked for, which its person sees and
-- approves.
ALTER TABLE agent_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'documents' CHECK (scope IN ('document', 'documents', 'admin'));
ALTER TABLE agent_tokens ADD COLUMN doc_id TEXT;
ALTER TABLE agent_tokens ADD COLUMN expires INTEGER;
ALTER TABLE token_requests ADD COLUMN scope TEXT NOT NULL DEFAULT 'documents' CHECK (scope IN ('document', 'documents', 'admin'));
ALTER TABLE token_requests ADD COLUMN doc_id TEXT;
ALTER TABLE token_requests ADD COLUMN token_expires INTEGER;

DROP TABLE IF EXISTS admin_log;
DROP TABLE IF EXISTS admin_challenges;
DROP TABLE IF EXISTS admin_keys;
