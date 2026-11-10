-- The network address a request for a token came from (server/identity/tokens.ts, request): anyone may ask, signed in
-- or not, so one address has only a few requests waiting at one time. A request made in a person's browser has none.
ALTER TABLE token_requests ADD COLUMN asked_from TEXT;
CREATE INDEX token_requests_asked_from ON token_requests (asked_from);
