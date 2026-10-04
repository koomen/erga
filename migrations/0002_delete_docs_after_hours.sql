-- The unedited_hours setting is now delete_docs_after_hours (config.ts),
-- which can also be never (null). Nothing reads the old key any more, so a
-- value an admin set under it goes: the new one starts at its default.
DELETE FROM server_config WHERE key = 'unedited_hours';
