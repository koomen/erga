-- erga: destructive
-- Drops the tables of the old sites feature (0180_sites.sql, 0190_cloudflare_grants.sql): no code reads or writes
-- them, so the Worker before this migration runs on the schema after it, and a rollback needs no restore.

DROP TABLE IF EXISTS sites;
DROP TABLE IF EXISTS cloudflare_connections;
DROP TABLE IF EXISTS cloudflare_grants;
