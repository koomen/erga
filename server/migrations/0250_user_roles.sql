-- The specific people are users, each with one role; the access rules are
-- groups only (server/directory/access.ts, people.ts; the Users and Access
-- pages). A person's access is the highest of their own role and every group
-- rule that matches them.
--
-- users.access: a user's own access besides admin (users.role): 'write'
-- (Can create and edit content), 'read' (Can authenticate), or NULL (none of
-- their own: only the group rules let them in). An admin always has write.
ALTER TABLE users ADD COLUMN access TEXT;

-- The people an admin added before their first sign-in: one provider account
-- each, and its role. A GitHub account by its login (`handle`), with GitHub's
-- numeric id (`subject`) found when the admin added it; a Google account by
-- its email (`handle`), which the first sign-in with that verified email
-- matches, and which then keeps its sub (`subject`). Their first sign-in
-- makes their account, with this role, and the row goes.
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  subject TEXT,
  handle TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'write', 'read')),
  created INTEGER NOT NULL,
  added_by TEXT,
  added_via TEXT,
  UNIQUE (provider, handle)
);
CREATE INDEX IF NOT EXISTS people_subject ON people (provider, subject);

-- Today's rules for one account become the roles of those users: a rule by
-- username, or by the Google email of an account. The rules stay in
-- access_rules (a migration only adds), where nothing reads them now.
UPDATE users SET access = (SELECT r.access FROM access_rules r WHERE r.kind = 'account' AND r.value = users.login AND r.access IN ('read', 'write'))
  WHERE access IS NULL;
UPDATE users SET access = (SELECT MAX(r.access) FROM access_rules r JOIN emails e ON e.email = r.value WHERE r.kind = 'email' AND e.login = users.login AND r.access IN ('read', 'write'))
  WHERE access IS NULL;
-- A Google email no account signed in with yet: someone added, waiting.
INSERT OR IGNORE INTO people (provider, handle, role, created, added_by, added_via)
  SELECT 'google', r.value, r.access, r.created, r.added_by, r.added_via FROM access_rules r
  WHERE r.kind = 'email' AND r.access IN ('read', 'write') AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.email = r.value);
