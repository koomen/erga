-- How each account signs in: one row for each identity a provider vouches
-- for (server/directory/identities.ts). An identity is kept by the
-- provider's stable subject id (GitHub's numeric account id, Google's
-- `sub`), never by an email or a GitHub login, which change. `login` is the
-- Erga account (users.login: its username, in its addresses). An account has
-- at most one identity of each provider. `handle` is what the provider called
-- them at their last sign-in (a GitHub login, a Google email), to show only.
--
-- The accounts from before this keep their GitHub login as their username:
-- each one with a GitHub id gets its identity here; one without (it hasn't
-- signed in since 0160) gets it at its next GitHub sign-in, by its login.
-- A Worker from before this never reads the table.
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  login TEXT NOT NULL,
  handle TEXT,
  created INTEGER NOT NULL,
  last_used INTEGER,
  PRIMARY KEY (provider, subject)
);
CREATE UNIQUE INDEX IF NOT EXISTS identities_one_per_provider ON identities (login, provider);

INSERT OR IGNORE INTO identities (provider, subject, login, handle, created, last_used)
  SELECT 'github', CAST(github_id AS TEXT), login, login, created, last_seen FROM users WHERE github_id IS NOT NULL;
