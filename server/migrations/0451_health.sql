-- The server's own health, as its scheduled run writes it each minute (server/health.ts, tick: the Worker's Cron
-- Trigger): one row. `bun erga` reads it through the platform's database API (Cloudflare D1's), with the platform's
-- own login: the ops tool never asks the server. `checks`: each check's result, as JSON.
CREATE TABLE health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  at INTEGER NOT NULL,
  version TEXT,
  ok INTEGER NOT NULL,
  checks TEXT NOT NULL
);
