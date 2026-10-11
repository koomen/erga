-- API keys an admin enters on /admin (credentials.ts): the Anthropic key and
-- the OpenAI key. Each is encrypted with AES-GCM (a fresh IV each time) under
-- a key from the deploy-time secret FACTORY_KEY, so this table alone, or a
-- copy of it (staging's database is a copy of production's), opens nothing.
-- The page shows only `last4`, `updated` and `updated_by`, never the key.
-- Touches no other table.

-- `name`: "anthropic" or "openai". `iv` and `data`: base64. `updated` is
-- milliseconds since the epoch.
CREATE TABLE IF NOT EXISTS credentials (
  name TEXT PRIMARY KEY,
  iv TEXT NOT NULL,
  data TEXT NOT NULL,
  last4 TEXT NOT NULL,
  updated INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
