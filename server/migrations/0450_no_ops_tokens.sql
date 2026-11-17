-- The ops scope is gone: `bun erga` reads what an instance runs from its platform (Cloudflare's API, AWS's), with
-- the platform's own login, and asks the server for no token. The tokens and the waiting requests of that scope go:
-- they open nothing any more (server/identity/tokens.ts refuses a scope it does not know).
DELETE FROM agent_tokens WHERE scope = 'ops';
DELETE FROM token_requests WHERE scope = 'ops';
