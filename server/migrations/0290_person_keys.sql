-- Each person's own API keys, for their own agent (server/directory/api-keys.ts, PersonKeys): one row for each person
-- and provider. Encrypted as the server's keys are (AES-GCM, a fresh IV each time, under a key from FACTORY_KEY), with
-- the person and the provider as the additional data, so a row opens only as that person's key for that provider.
-- Nothing answers a key to a page: only `last4` and `updated`. Not in the change log. Touches no other table.

-- `login`: lowercase. `name`: the provider (anthropic, openai, google, openrouter). `iv` and `data`: base64.
-- `updated`: milliseconds since the epoch.
CREATE TABLE IF NOT EXISTS person_keys (
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  iv TEXT NOT NULL,
  data TEXT NOT NULL,
  last4 TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (login, name)
);
