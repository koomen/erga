-- Admins' SSH keys (admin-keys.ts): administering, editing and deploying the
-- server needs an admin who has unlocked admin access by signing a challenge
-- with an SSH key they added themselves (README, Admin SSH keys). Touches no
-- other table.

-- A key an admin added. `public_key` is the "type base64" line (no comment),
-- `fingerprint` its SHA256 fingerprint, as `ssh-keygen -l` prints it. A key
-- belongs to the admin who added it, and only they can unlock with it.
-- `added_how`: 'github' (their first key, which had to be on their GitHub
-- account), 'unlocked' (added while unlocked with another of their keys) or
-- 'local' (local development). A revoked key keeps its row, for the record,
-- and never works again. Times are milliseconds since the epoch.
CREATE TABLE admin_keys (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created INTEGER NOT NULL,
  added_how TEXT NOT NULL,
  last_used INTEGER,
  revoked INTEGER,
  revoked_by TEXT
);
CREATE INDEX admin_keys_by_login ON admin_keys (login);
-- One admin at a time may have a given key.
CREATE UNIQUE INDEX admin_keys_live_fingerprint ON admin_keys (fingerprint) WHERE revoked IS NULL;

-- A challenge to sign: made for one admin, one purpose ('unlock', or
-- 'add-key' for the key it names) and this server's host, used once
-- (deleted as it's checked, whatever the answer), within five minutes.
CREATE TABLE admin_challenges (
  nonce TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  purpose TEXT NOT NULL,
  message TEXT NOT NULL,
  fingerprint TEXT,
  expires INTEGER NOT NULL
);

-- What happened to admin access: keys added and revoked, unlocks, admin
-- tokens made, and failed attempts. Admins read it on /admin/keys.
CREATE TABLE admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  login TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
