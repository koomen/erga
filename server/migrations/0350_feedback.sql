-- Feedback a person sent from a page (the account menu's Send feedback, or their agent: send_feedback), kept first,
-- then opened as an issue in Erga's repository on GitHub (server/feedback.ts). `login`: lowercase, who sent it, never in
-- the issue; `via`: how, when not in person. `page`: the path it was sent from. `target`: the server that took it
-- (DEPLOY_TARGET: "production", "staging", "" elsewhere), so staging, on a copy of production's rows, never opens
-- production's issues. `issue`: its number on GitHub, null until it is opened. `tried`: the last try to open it.
-- `at`, `tried`: milliseconds since the epoch.
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  login TEXT NOT NULL,
  via TEXT,
  page TEXT,
  target TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  issue INTEGER,
  tried INTEGER
);
CREATE INDEX IF NOT EXISTS feedback_at ON feedback (at);
CREATE INDEX IF NOT EXISTS feedback_open ON feedback (target, issue);
