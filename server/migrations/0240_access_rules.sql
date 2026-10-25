-- The access rules (server/directory/access.ts; the Users page): one list.
-- Each rule is WHO and ACCESS. WHO: everybody (one row, always there), a
-- Google Workspace organization (`value`: its domain, matched on the ID
-- token's hd claim), a GitHub organization (`value`: its login), one account
-- (`value`: its username) or one Google account by its verified email
-- (`value`: the address). ACCESS: none (only everybody's may be), read (may
-- view documents) or write (may view, make and edit them; write includes
-- read). A person gets the highest access of the rules that match them, and
-- none signs in nowhere. Admins always have write.
--
-- This replaces the two settings access_read and access_write, the users'
-- `listed` column and the invites table (0230), which nothing reads from now:
-- this keeps them (a migration only adds), and translates what they held.
-- Every server so far was invite-only (only the accounts on its list signed
-- in): everybody gets none, and each account on the list (every row in users,
-- as each was listed) gets a rule with write; each invitation by email too.
CREATE TABLE IF NOT EXISTS access_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('everybody', 'workspace', 'github_org', 'account', 'email')),
  value TEXT NOT NULL DEFAULT '',
  access TEXT NOT NULL CHECK (access IN ('none', 'read', 'write')),
  created INTEGER NOT NULL,
  added_by TEXT,
  added_via TEXT,
  UNIQUE (kind, value)
);
INSERT OR IGNORE INTO access_rules (kind, value, access, created) VALUES ('everybody', '', 'none', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO access_rules (kind, value, access, created, added_by, added_via)
  SELECT 'account', login, 'write', created, added_by, added_via FROM users WHERE listed = 1;
INSERT OR IGNORE INTO access_rules (kind, value, access, created, added_by, added_via)
  SELECT 'email', email, 'write', created, added_by, added_via FROM invites;

-- A Google identity's Workspace (the hd claim: its domain) at its last sign-in;
-- NULL for a personal Google account (gmail.com has none) and for GitHub's.
ALTER TABLE identities ADD COLUMN hd TEXT;
