-- The deploy role (users.ts): a user with it may use /deploy, to deploy Erga
-- to their own Cloudflare account, when the deploy_page setting is "admins"
-- (README, Deploy your own). Admins grant and revoke it on /admin/users.
-- 0 or 1; every user has it off until an admin grants it. Touches no other
-- table, and the Worker before it ignores the column.
ALTER TABLE users ADD COLUMN deploy INTEGER NOT NULL DEFAULT 0;
