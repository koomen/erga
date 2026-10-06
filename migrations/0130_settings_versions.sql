-- The admin settings' versions (config.ts): one row each time a setting
-- changes, however it's changed (an admin on /admin, an agent, the
-- homepage's switch, the server's own write), with who changed it, when, and
-- what changed. Admins read it on /admin, as the Settings' change log.
-- Touches no other table.

-- `n` numbers the versions 1, 2, 3... `at` is milliseconds since the epoch.
-- `changes` is JSON: [{ key, from, to, reset? }], each setting's value as it
-- applied before and after (its default when it had no row; `reset`: put
-- back to its default). A change that changes nothing makes no version.
CREATE TABLE IF NOT EXISTS server_config_versions (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  by TEXT NOT NULL,
  changes TEXT NOT NULL
);
