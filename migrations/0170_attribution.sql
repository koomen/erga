-- How each recorded actor acted (#69, attribution.ts). Every record of who
-- did something keeps the person's login, as before, and now also how they
-- did it, when not in person: "their agent" (the editor's agent), "their
-- admin agent", "a shared agent (<label>)" (one of their tokens), "the
-- factory (task #<n>)". NULL: in person (and every row from before this).

-- A version of the settings, the change log's entries (/admin/changes).
ALTER TABLE server_config_versions ADD COLUMN via TEXT;
-- A setting's "Last set by" (/admin).
ALTER TABLE server_config ADD COLUMN updated_via TEXT;
-- An API key's "updated by" (/admin/api-keys).
ALTER TABLE credentials ADD COLUMN updated_via TEXT;
-- Who added a user (/admin/users).
ALTER TABLE users ADD COLUMN added_via TEXT;
-- Who shared a document with someone.
ALTER TABLE permissions ADD COLUMN granted_via TEXT;
