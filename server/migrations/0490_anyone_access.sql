-- The Access page has three parts (server/directory/access.ts): the groups, each
-- with read or write; the users with a role of their own; and everyone else:
-- Anyone's level (the setting anyone_access: none, public, read or write) and
-- whether users share with anyone with the link (the setting public_sharing).
--
-- Everybody's rule goes: Anyone's level stands in its place, and starts at none
-- (the setting's default). A group's rule with no access goes: a group gives
-- read or write, and to give none an admin removes its rule. On a server that
-- has users, public sharing starts off, whatever it was: an admin sets Anyone's
-- level and turns the switch on, on the page. (A new database keeps its
-- deploy's defaults.) No share is deleted: one with anyone with the link works
-- again when the switch is on.
DELETE FROM access_rules WHERE kind = 'everybody' OR access = 'none';
INSERT INTO server_config (key, value, updated)
  SELECT 'public_sharing', 'false', CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE EXISTS (SELECT 1 FROM users)
  ON CONFLICT (key) DO UPDATE SET value = 'false', updated = excluded.updated, updated_by = NULL, updated_via = NULL;
