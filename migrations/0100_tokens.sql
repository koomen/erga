-- Agent tokens (tokens.ts): each stands for one person, everywhere on the
-- server, so an agent holding it (Claude Code, Codex, a script) can do what
-- they can do: list, make, edit, rename and delete their documents, publish
-- a site (server-api.ts, /api/ext and /mcp), and work in a document as their
-- agent (a document's /api/ext). Numbered apart from the directory's own
-- migrations, and touching none of their tables.

-- A token is derived from its `id` with the server's secret (an HMAC), and
-- only its SHA-256 is kept (`hash`, hex), which is how a request's token is
-- looked up; the database alone never holds a working token. `id` names it
-- in lists and to revoke it. `kind` is 'share' for the one the editor's share
-- button shows (shown again each time it's asked for, until it's rotated) and
-- 'agent' for those made at /tokens or asked for by an agent (shown once).
-- A test person's token (their share button's) has `test_by`, who minted
-- their test token: it opens only test documents, as they do.
-- Times are milliseconds since the epoch; `last_used` is updated at most
-- every few minutes.
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'share')),
  test_by TEXT,
  created INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX agent_tokens_by_login ON agent_tokens (login);

-- An agent asking for a token from the command line (a device flow): it
-- holds `code` (kept as its hash) and polls; the person opens the link with
-- `user_code` signed in and approves, which mints the token (`token_id`) for
-- the agent to collect, once, before the request expires.
CREATE TABLE token_requests (
  code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  login TEXT,
  token_id TEXT
);
