-- MCP's sign-in (OAuth 2.1, server/identity/oauth.ts): an agent's app asks
-- for a token through the browser. Its request is a token request like the
-- device flow's, with what OAuth needs to hand the token back: the client
-- (its signed client_id), where to send the person back (`redirect_uri`),
-- the PKCE challenge (S256) and the client's `state`. Once the person
-- approves, `code_hash` is the hash of the authorization code, and the app
-- trades the code and its PKCE verifier for the token at /oauth/token.
-- A device-flow request leaves them NULL.
ALTER TABLE token_requests ADD COLUMN oauth_client TEXT;
ALTER TABLE token_requests ADD COLUMN redirect_uri TEXT;
ALTER TABLE token_requests ADD COLUMN code_challenge TEXT;
ALTER TABLE token_requests ADD COLUMN oauth_state TEXT;
