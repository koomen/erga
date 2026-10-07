-- Each user's GitHub account id (the number, which never changes when they
-- rename), from GitHub at sign-in: the factory authors a task's commits as
-- the person who added it, with their GitHub noreply address
-- (<id>+<login>@users.noreply.github.com), so the GitHub mirror links each
-- commit to their profile. NULL until they sign in again (the factory then
-- asks GitHub for it, or uses <login>@users.noreply.github.com).
ALTER TABLE users ADD COLUMN github_id INTEGER;
