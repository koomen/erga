-- Publishing a document to a domain in the person's own Cloudflare account
-- (sites.ts). Touches no other table.

-- Each person's Cloudflare connection: an API token they pasted on /settings,
-- encrypted with AES-GCM (a fresh IV each time, the login as the additional
-- data) under a key from FACTORY_KEY, as the API keys are (credentials.ts).
-- The page shows only `last4` and the accounts, never the token.
-- `accounts`: JSON, [{ "id", "name" }], the accounts the token reached when it
-- was checked. `updated` is milliseconds since the epoch.
CREATE TABLE IF NOT EXISTS cloudflare_connections (
  login TEXT PRIMARY KEY,
  iv TEXT NOT NULL,
  data TEXT NOT NULL,
  last4 TEXT NOT NULL,
  accounts TEXT NOT NULL,
  updated INTEGER NOT NULL,
  updated_via TEXT
);

-- A document's site: the hostname it is published at, on a zone of the
-- account whose Worker (`script`) serves it, and whose connection deploys it
-- (`login`). One site for each document, and one document for each hostname.
CREATE TABLE IF NOT EXISTS sites (
  doc_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL UNIQUE,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  script TEXT NOT NULL,
  login TEXT NOT NULL,
  created INTEGER NOT NULL,
  created_via TEXT
);
CREATE INDEX IF NOT EXISTS sites_login ON sites (login);
