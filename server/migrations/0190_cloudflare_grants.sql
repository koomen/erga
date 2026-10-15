-- Each person's Cloudflare connection is now an OAuth grant (a consent in the
-- browser), not a pasted API token (server/sites/rows.ts).

-- `grant`: JSON, deploy/credential.ts's StoredGrant: the access and refresh
-- tokens sealed with AES-GCM under a key from FACTORY_KEY and the login (so a
-- row opens only for its own person, and only on this server), when the access
-- token expires, the scopes, and the last refresh's refusal.
-- `accounts`: JSON, [{ "id", "name" }], the accounts the grant reached after
-- the consent. `updated` is milliseconds since the epoch.
CREATE TABLE IF NOT EXISTS cloudflare_grants (
  login TEXT PRIMARY KEY,
  "grant" TEXT NOT NULL,
  accounts TEXT NOT NULL DEFAULT '[]',
  updated INTEGER NOT NULL,
  updated_via TEXT
);

-- The pasted tokens: no code reads them any more, and a secret nobody uses is
-- only a risk. The table stays (the Worker before this one still reads it).
DELETE FROM cloudflare_connections;
