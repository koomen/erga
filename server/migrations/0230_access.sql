-- Who may use the server (the access rules on /admin/users: server/directory/access.ts).
--
-- `listed`: an account an admin listed (added on /admin/users), as every
-- account was before this: 1 for each row there is now, and for each one an
-- admin adds. 0 for an account someone made themselves, which a rule of
-- "anyone" or "domains" let in. The rule "only listed accounts" lets in
-- only the listed ones. A Worker from before this never reads the column
-- (to it, every row may sign in, as before).
ALTER TABLE users ADD COLUMN listed INTEGER NOT NULL DEFAULT 1;

-- People an admin listed by an email address, before they have an account:
-- someone who signs in with that address verified (and no account) may make
-- one, listed, with the role given. The invitation goes once it's used.
CREATE TABLE IF NOT EXISTS invites (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created INTEGER NOT NULL,
  added_by TEXT,
  added_via TEXT
);

-- A GitHub identity's organizations, as GitHub answered at its last sign-in
-- (the person's token, /user/memberships/orgs: active memberships, private
-- ones too), for the access rules' organizations: a JSON list of lowercase
-- logins; NULL when never checked, or GitHub didn't answer. `orgs_checked`:
-- when. Only asked while a rule names an organization.
ALTER TABLE identities ADD COLUMN orgs TEXT;
ALTER TABLE identities ADD COLUMN orgs_checked INTEGER;
