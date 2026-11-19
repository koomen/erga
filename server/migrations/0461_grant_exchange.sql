-- A grant is one exchange's of its code (server/identity/grants.ts). The gate keeps no state, so a code can be traded
-- for tokens more than one time while it lasts; it marks each exchange's tokens with an ID of that exchange.
-- `exchange`: the ID in the first token of the grant that the server saw. A token with another ends the grant.
-- NULL: no token yet, or a grant with a token made on the page (which is of no exchange).
ALTER TABLE agent_grants ADD COLUMN exchange TEXT;
