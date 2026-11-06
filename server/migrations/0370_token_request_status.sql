-- A request for a token has a status (server/identity/token-request.ts): waiting for its person, or approved and
-- waiting for its agent to collect the token. Each change is guarded by it, so it happens once. A collected or
-- denied request is deleted, as before. The rows approved before this have a login.
ALTER TABLE token_requests ADD COLUMN status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'approved'));
UPDATE token_requests SET status = 'approved' WHERE login IS NOT NULL;
