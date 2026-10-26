-- Each account's picture (shared/avatars.ts): GitHub's by the account's
-- GitHub id, or the picture Google gave at its last sign-in. Each sign-in
-- writes it (server/directory/identities.ts). NULL: no picture, so the pages
-- show the person's initial on their colour. Before this, every account showed
-- GitHub's picture for its username, which may be another GitHub person's.
ALTER TABLE users ADD COLUMN avatar TEXT;

-- The accounts that sign in with GitHub get GitHub's picture by their id now.
UPDATE users SET avatar = 'https://avatars.githubusercontent.com/u/' || (SELECT i.subject FROM identities i WHERE i.login = users.login AND i.provider = 'github') || '?s=64'
  WHERE avatar IS NULL AND EXISTS (SELECT 1 FROM identities i WHERE i.login = users.login AND i.provider = 'github');
